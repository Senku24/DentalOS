import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SpanStatusCode, initTracing, withSpan } from "@dentalos/config";
import { PrismaClient } from "@dentalos/db";
import { type ArgumentsHost, HttpException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { SignJWT } from "jose";

process.env.DEV_JWT_SECRET = "test-secret-test-secret-test-secret";
process.env.DATABASE_URL = "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos";

const exporter = new InMemorySpanExporter();
const tracing = initTracing({ serviceName: "api-test", exporter, simple: true, prisma: true });
const { AppModule } = await import("../app.module");
const { TracedExceptionFilter, tracingMiddleware } = await import("./tracing");

const admin = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres:postgres@localhost:5433/dentalos" } },
});
const key = new TextEncoder().encode(process.env.DEV_JWT_SECRET);
const token = () =>
  new SignJWT({ mfa: true })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("u-trace")
    .setExpirationTime("5m")
    .sign(key);

let app: Awaited<ReturnType<typeof NestFactory.create>>;
let base: string;
let tenant: string;
let jwt: string;

beforeAll(async () => {
  tenant = (await admin.tenant.create({ data: { name: "trace" } })).id;
  await admin.membership.create({
    data: { tenantId: tenant, userId: "u-trace", roles: ["OWNER"], orgWide: true },
  });
  jwt = await token();
  app = await NestFactory.create(AppModule, { logger: false });
  app.use(tracingMiddleware);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
});
afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await tracing.shutdown();
});

const settle = () => Bun.sleep(150); // let finish handlers run

test("request produces a SERVER span with route template + tenant, and Prisma child spans in the same trace", async () => {
  exporter.reset();
  const r = await fetch(`${base}/me`, {
    headers: { authorization: `Bearer ${jwt}`, "x-tenant-id": tenant },
  });
  expect(r.status).toBe(200);
  await settle();
  const spans = exporter.getFinishedSpans();
  const server = spans.find((s) => s.name === "GET /me");
  expect(server).toBeTruthy();
  expect(server?.attributes["http.route"]).toBe("/me");
  expect(server?.attributes["http.response.status_code"]).toBe(200);
  expect(server?.attributes["dentalos.tenant_id"]).toBe(tenant);
  // Skip one-off lazy engine start-up spans; every query span must belong to this request's trace,
  // including those inside withTenant()'s interactive transaction.
  const db = spans.filter(
    (s) => s.name.startsWith("prisma:") && !/detect_platform|load_engine/.test(s.name),
  );
  expect(db.some((s) => s.name === "prisma:client:operation")).toBe(true);
  expect(db.every((s) => s.spanContext().traceId === server?.spanContext().traceId)).toBe(true);
});

test("a rejected request (401) is traced without being an error span", async () => {
  exporter.reset();
  const r = await fetch(`${base}/me`);
  expect(r.status).toBe(401);
  await settle();
  const s = exporter
    .getFinishedSpans()
    .find((x) => x.attributes["http.response.status_code"] === 401);
  expect(s).toBeTruthy();
  expect(s?.status.code).not.toBe(SpanStatusCode.ERROR);
});

test("an incoming traceparent is continued", async () => {
  exporter.reset();
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  await fetch(`${base}/health/live`, {
    headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
  });
  await settle();
  const s = exporter.getFinishedSpans().find((x) => x.name === "GET /health/live");
  expect(s?.spanContext().traceId).toBe(traceId);
  expect(s?.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
});

test("spans never carry credentials, headers or query strings", async () => {
  exporter.reset();
  await fetch(`${base}/me?patient=Asha%20Verma`, {
    headers: { authorization: `Bearer ${jwt}`, "x-tenant-id": tenant },
  });
  await settle();
  const dump = JSON.stringify(
    exporter.getFinishedSpans().map((s) => ({ n: s.name, a: s.attributes, e: s.events })),
  );
  expect(dump).not.toContain(jwt);
  expect(dump).not.toContain("Bearer");
  expect(dump).not.toContain("Asha");
});

test("exception filter: 5xx is recorded on the span and answered generically; 4xx passes through", async () => {
  exporter.reset();
  const sent: { status?: number; body?: unknown } = {};
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({
        status: (n: number) => {
          sent.status = n;
          return {
            json: (b: unknown) => {
              sent.body = b;
            },
          };
        },
      }),
    }),
  };
  const asHost = host as unknown as ArgumentsHost; // minimal stub
  const filter = new TracedExceptionFilter();
  await withSpan("req", {}, () => filter.catch(new Error("password=hunter2 failed"), asHost));
  expect(sent.status).toBe(500);
  expect(JSON.stringify(sent.body)).not.toContain("hunter2");
  const span = exporter.getFinishedSpans().find((s) => s.name === "req");
  expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  expect(JSON.stringify(span?.events)).not.toContain("hunter2"); // message never reaches telemetry

  filter.catch(new HttpException("nope", 403), asHost);
  expect(sent.status).toBe(403);
});
