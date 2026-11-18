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
const token = (sub: string, mfa = true) =>
  new SignJWT({ mfa })
    .setProtectedHeader({ alg: "HS256" })
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
  await admin.membership.create({ data: { tenantId: tA, userId: "user-a", role: "OWNER" } });
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
  expect((await r.json()).role).toBe("OWNER");
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
