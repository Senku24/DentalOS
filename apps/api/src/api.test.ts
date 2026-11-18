import "reflect-metadata";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaClient } from "@dentalos/db";
import { NestFactory } from "@nestjs/core";
import { SignJWT } from "jose";

process.env.DEV_JWT_SECRET = "test-secret-test-secret-test-secret";
process.env.DATABASE_URL = "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos";
const { AppModule } = await import("./app.module");

const admin = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres:postgres@localhost:5433/dentalos" } },
});
const key = new TextEncoder().encode(process.env.DEV_JWT_SECRET);
const token = (sub: string, mfa = true, extra: Record<string, unknown> = {}) =>
  new SignJWT({ mfa, ...extra })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(key);

let app: Awaited<ReturnType<typeof NestFactory.create>>;
let base: string;
let tA: string;
let tB: string;

beforeAll(async () => {
  tA = (await admin.tenant.create({ data: { name: "API-A" } })).id;
  tB = (await admin.tenant.create({ data: { name: "API-B" } })).id;
  await admin.membership.create({
    data: { tenantId: tA, userId: "user-a", roles: ["OWNER"], orgWide: true },
  });
  await admin.membership.create({
    data: { tenantId: tA, userId: "user-rec", roles: ["RECEPTIONIST"], branchScope: ["b1"] },
  });
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "localhost");
});
afterAll(async () => {
  await app.close();
  await admin.$disconnect();
});

const get = async (path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { headers });

test("health is public", async () => {
  expect((await get("/health/live")).status).toBe(200);
  expect((await get("/health/ready")).status).toBe(200);
});
test("no token -> 401", async () => {
  expect((await get("/me", { "x-tenant-id": tA })).status).toBe(401);
});
test("member with MFA -> principal from DB", async () => {
  const r = await get("/me", {
    authorization: `Bearer ${await token("user-a")}`,
    "x-tenant-id": tA,
  });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.roles).toEqual(["OWNER"]);
  expect(body.orgWide).toBe(true);
});
test("no MFA -> 403", async () => {
  expect(
    (
      await get("/me", {
        authorization: `Bearer ${await token("user-a", false)}`,
        "x-tenant-id": tA,
      })
    ).status,
  ).toBe(403);
});
test("cross-tenant header with valid user -> 403", async () => {
  expect(
    (await get("/me", { authorization: `Bearer ${await token("user-a")}`, "x-tenant-id": tB }))
      .status,
  ).toBe(403);
});
test("garbage tenant id -> 403, no crash", async () => {
  expect(
    (
      await get("/me", {
        authorization: `Bearer ${await token("user-a")}`,
        "x-tenant-id": "'; drop",
      })
    ).status,
  ).toBe(403);
});

test("@Can: receptionist is denied an org-level route, owner allowed", async () => {
  const rec = await get("/me/admin", {
    authorization: `Bearer ${await token("user-rec")}`,
    "x-tenant-id": tA,
  });
  expect(rec.status).toBe(403);
  const owner = await get("/me/admin", {
    authorization: `Bearer ${await token("user-a")}`,
    "x-tenant-id": tA,
  });
  expect(owner.status).toBe(200);
});

// ---- realtime (SSE) ----
import { EventBus } from "./realtime/event-bus";

const readUntil = async (res: Response, needle: string, ms = 3000) => {
  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await Promise.race([reader.read(), Bun.sleep(300).then(() => null)]);
    if (r && !r.done) buf += dec.decode(r.value);
    if (buf.includes(needle)) break;
  }
  reader.cancel().catch(() => {});
  return buf;
};

test("SSE delivers same-tenant events and never another tenant's", async () => {
  const bus = app.get(EventBus);
  const res = await get("/events", {
    authorization: `Bearer ${await token("user-a")}`,
    "x-tenant-id": tA,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const pending = readUntil(res, "appointment.checked_in");
  await Bun.sleep(150);
  bus.publish({ tenantId: tB, type: "leak.other_tenant", data: { x: 1 } });
  bus.publish({ tenantId: tA, branchId: "b1", type: "appointment.checked_in", data: { id: "a1" } });
  const text = await pending;
  expect(text).toContain("appointment.checked_in");
  expect(text).not.toContain("leak.other_tenant");
});

test("SSE respects branch scope for non-org-wide principals", async () => {
  const bus = app.get(EventBus);
  const res = await get("/events", {
    authorization: `Bearer ${await token("user-rec")}`,
    "x-tenant-id": tA,
  });
  const pending = readUntil(res, "visible.b1");
  await Bun.sleep(150);
  bus.publish({ tenantId: tA, branchId: "b2", type: "hidden.b2", data: {} });
  bus.publish({ tenantId: tA, branchId: "b1", type: "visible.b1", data: {} });
  const text = await pending;
  expect(text).toContain("visible.b1");
  expect(text).not.toContain("hidden.b2");
});

test("SSE without auth -> 401", async () => {
  expect((await get("/events", { "x-tenant-id": tA })).status).toBe(401);
});

test("@StepUp: a stale sign-in is told to re-authenticate, a fresh one passes", async () => {
  const stale = await token("user-a", true, { auth_time: Math.floor(Date.now() / 1000) - 3600 });
  const r = await get("/me/admin", { authorization: `Bearer ${stale}`, "x-tenant-id": tA });
  expect(r.status).toBe(401);
  expect(await r.json()).toMatchObject({ error: "reauth_required", maxAgeSeconds: 900 });
  const fresh = await token("user-a", true, { auth_time: Math.floor(Date.now() / 1000) - 60 });
  expect(
    (await get("/me/admin", { authorization: `Bearer ${fresh}`, "x-tenant-id": tA })).status,
  ).toBe(200);
});
