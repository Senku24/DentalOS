import {
  SpanKind,
  SpanStatusCode,
  recordSafeException,
  shutdownTracing,
  tracer,
} from "@dentalos/config";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Injectable,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { context, propagation, trace } from "@opentelemetry/api";
import { logger } from "./logger";

interface Req {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  principal?: { tenantId: string };
}
interface Res {
  statusCode: number;
  on(ev: "finish", cb: () => void): void;
}

/**
 * One SERVER span per request, started before auth so rejected requests are traced too.
 * Joins an incoming W3C `traceparent`. Span name uses the route TEMPLATE (low cardinality);
 * attributes carry ids only: no query string, headers, IP or body.
 */
export function tracingMiddleware(req: Req, res: Res, next: () => void) {
  const parent = propagation.extract(context.active(), req.headers);
  const span = tracer("dentalos-api").startSpan(
    `${req.method} ${(req.originalUrl ?? req.url).split("?")[0]}`,
    { kind: SpanKind.SERVER, attributes: { "http.request.method": req.method } },
    parent,
  );
  res.on("finish", () => {
    const route = req.route?.path;
    span.updateName(`${req.method} ${route ?? "unmatched"}`);
    span.setAttributes({
      "http.response.status_code": res.statusCode,
      ...(route ? { "http.route": route } : {}),
      ...(req.principal ? { "dentalos.tenant_id": req.principal.tenantId } : {}),
    });
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
  context.with(trace.setSpan(parent, span), next);
}

/**
 * Last-resort error handling: 4xx pass through unchanged; anything else is recorded on the active
 * span (error tracking), logged with trace ids, and answered with a generic 500: never internals.
 */
@Catch()
@Injectable()
export class TracedExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<{
      status(n: number): { json(b: unknown): void };
    }>();
    if (e instanceof HttpException && e.getStatus() < 500) {
      res.status(e.getStatus()).json(e.getResponse());
      return;
    }
    const err = e instanceof Error ? e : new Error(String(e));
    const span = trace.getActiveSpan();
    if (span) recordSafeException(span, err);
    // No message in logs either (may embed values); the trace id links to the span with the stack.
    const frames = (err.stack ?? "")
      .split("\n")
      .filter((l) => l.trimStart().startsWith("at "))
      .slice(0, 12);
    logger.error({ err: { name: err.name, frames } }, "unhandled error");
    res.status(500).json({ statusCode: 500, message: "Internal server error" });
  }
}

/** Flushes buffered spans as part of Nest's graceful shutdown, so the last requests are not lost. */
@Injectable()
export class TracingShutdown implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await shutdownTracing();
  }
}
