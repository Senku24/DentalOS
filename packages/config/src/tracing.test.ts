import { afterEach, expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {
  SpanStatusCode,
  currentTraceIds,
  extractTraceContext,
  initTracing,
  injectTraceContext,
  runInContext,
  withSpan,
} from "./tracing";

let handle: ReturnType<typeof initTracing> | undefined;
afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
});

const setup = () => {
  const exporter = new InMemorySpanExporter();
  handle = initTracing({ serviceName: "test", exporter, simple: true });
  return exporter;
};

test("withSpan nests under the active span and records attributes", async () => {
  const ex = setup();
  await withSpan("outer", { "dentalos.module": "billing" }, () =>
    withSpan("inner", { "dentalos.op": "post-invoice" }, async () => {}),
  );
  const spans = ex.getFinishedSpans();
  const outer = spans.find((s) => s.name === "outer");
  const inner = spans.find((s) => s.name === "inner");
  expect(inner?.spanContext().traceId).toBe(outer?.spanContext().traceId ?? "x");
  expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId ?? "x");
  expect(outer?.attributes["dentalos.module"]).toBe("billing");
});

test("an exception marks the span ERROR, records the exception and rethrows", async () => {
  const ex = setup();
  await expect(
    withSpan("boom", {}, () => {
      throw new Error("db down");
    }),
  ).rejects.toThrow("db down");
  const s = ex.getFinishedSpans()[0];
  expect(s?.status.code).toBe(SpanStatusCode.ERROR);
  expect(s?.events.some((e) => e.name === "exception")).toBe(true);
});

test("trace context survives a hop through a carrier (e.g. a job payload)", async () => {
  const ex = setup();
  let carrier: Record<string, string> = {};
  await withSpan("http request", {}, async () => {
    carrier = injectTraceContext();
  });
  expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  await runInContext(extractTraceContext(carrier), () => withSpan("job", {}, async () => {}));
  const [req, job] = [
    ex.getFinishedSpans().find((s) => s.name === "http request"),
    ex.getFinishedSpans().find((s) => s.name === "job"),
  ];
  expect(job?.spanContext().traceId).toBe(req?.spanContext().traceId ?? "x");
  expect(job?.parentSpanContext?.spanId).toBe(req?.spanContext().spanId ?? "x");
});

test("currentTraceIds is empty outside a span and populated inside", async () => {
  setup();
  expect(currentTraceIds()).toEqual({});
  await withSpan("x", {}, async () => {
    expect(currentTraceIds().traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

test("OTLP/HTTP export reaches a collector under Bun", async () => {
  const received: { path: string; type: string | null; bytes: number }[] = [];
  const collector = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.arrayBuffer();
      received.push({
        path: new URL(req.url).pathname,
        type: req.headers.get("content-type"),
        bytes: body.byteLength,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${collector.port}`;
  try {
    handle = initTracing({ serviceName: "otlp-test" }); // default exporter, batch processor
    await withSpan("exported", { "dentalos.module": "poc" }, async () => {});
    await handle.forceFlush();
    const hit = received.find((r) => r.path === "/v1/traces");
    expect(hit).toBeTruthy();
    expect(hit?.bytes).toBeGreaterThan(50);
  } finally {
    // biome-ignore lint/performance/noDelete: must truly unset, not set to "undefined"
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await collector.stop(true);
  }
});
