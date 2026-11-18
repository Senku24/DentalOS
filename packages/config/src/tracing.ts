import {
  type Attributes,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

export { SpanKind, SpanStatusCode };

export interface TracingOptions {
  serviceName: string;
  serviceVersion?: string;
  /**
   * Explicit exporter (tests, or a custom one). When omitted, OTLP/HTTP is used if
   * OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. an in-region ADOT/OTel collector); otherwise spans are
   * created for log correlation only and not exported.
   */
  exporter?: SpanExporter;
  /** Synchronous export (tests). Production uses batching. */
  simple?: boolean;
  /** Instrument Prisma queries as child spans. */
  prisma?: boolean;
}

export interface TracingHandle {
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}

let active:
  | {
      provider: TracerProvider;
      ctx: AsyncLocalStorageContextManager;
      prisma?: PrismaInstrumentation;
    }
  | undefined;

/** Idempotent: re-initialising tears down the previous setup first (keeps tests isolated). */
export function initTracing(opts: TracingOptions): TracingHandle {
  void teardown();
  const exporter =
    opts.exporter ??
    (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OTLPTraceExporter({
          url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`,
        })
      : undefined);
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName,
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? process.env.APP_VERSION ?? "dev",
      "deployment.environment.name": process.env.DEPLOY_ENV ?? "local",
    }),
    spanProcessors: exporter
      ? [opts.simple ? new SimpleSpanProcessor({ exporter }) : new BatchSpanProcessor({ exporter })]
      : [],
  });
  const ctx = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(ctx);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  const prisma = opts.prisma ? new PrismaInstrumentation() : undefined;
  prisma?.setTracerProvider(provider);
  prisma?.enable();
  active = { provider, ctx, prisma };
  return {
    forceFlush: () => provider.forceFlush(),
    shutdown: teardown,
  };
}

/** Flushes and stops tracing (call on application shutdown). No-op if never initialised. */
export const shutdownTracing = () => teardown();

async function teardown() {
  const a = active;
  active = undefined;
  if (!a) return;
  a.prisma?.disable();
  await a.provider.shutdown().catch(() => {});
  a.ctx.disable();
  context.disable();
  propagation.disable();
  trace.disable();
}

/**
 * Records an exception WITHOUT its message: messages from drivers/ORMs can embed values (PII,
 * clinical data, secrets). Keeps the type and stack frames, which is what triage needs.
 */
export function recordSafeException(span: Span, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  const frames = (e.stack ?? "")
    .split("\n")
    .filter((l) => l.trimStart().startsWith("at "))
    .join("\n");
  span.addEvent("exception", { "exception.type": e.name, "exception.stacktrace": frames });
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.name });
}

export const tracer = (name = "dentalos") => trace.getTracer(name);

/**
 * Runs `fn` in a span; records exceptions and marks the span ERROR on throw.
 * Attributes must be ids/enums only: never PII or clinical content.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T> | T,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes, kind }, async (span) => {
    try {
      return await fn();
    } catch (e) {
      recordSafeException(span, e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** W3C trace-context carrier for the active span (store in job payloads / outbound headers). */
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export const extractTraceContext = (carrier: Record<string, unknown> | undefined): Context =>
  carrier ? propagation.extract(context.active(), carrier) : context.active();

/** Continues a trace that began elsewhere (HTTP request that enqueued a job, etc.). */
export const runInContext = <T>(ctx: Context, fn: () => T): T => context.with(ctx, fn);

/** For log correlation. Empty when there is no active span. */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const s = trace.getActiveSpan()?.spanContext();
  return s ? { traceId: s.traceId, spanId: s.spanId } : {};
}
