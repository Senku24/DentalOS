import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { withTenant } from "./index";

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/dentalos";
const APP_URL = ADMIN_URL.replace(/\/\/[^@]+@/, "//dentalos_app:dentalos_app@");
const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
let a: string;
let b: string;

beforeAll(async () => {
  a = (await admin.tenant.create({ data: { name: "A" } })).id;
  b = (await admin.tenant.create({ data: { name: "B" } })).id;
  await admin.branch.create({ data: { tenantId: a, name: "A1" } });
  await admin.branch.create({ data: { tenantId: b, name: "B1" } });
});
afterAll(async () => {
  await admin.$disconnect();
  await app.$disconnect();
});

test("tenant A only sees its own branches", async () => {
  const rows = await withTenant(app, a, (tx) => tx.branch.findMany());
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.tenantId === a)).toBe(true);
});

test("missing tenant context returns nothing (fails closed)", async () => {
  expect(await app.branch.findMany()).toHaveLength(0);
});

test("invalid tenant id is rejected before any query", async () => {
  await expect(withTenant(app, "x' OR 1=1 --", (tx) => tx.branch.findMany())).rejects.toThrow();
});

test("cannot insert a row for another tenant", async () => {
  await expect(
    withTenant(app, a, (tx) => tx.branch.create({ data: { tenantId: b, name: "evil" } })),
  ).rejects.toThrow();
});

test("audit events are append-only for app role", async () => {
  await withTenant(app, a, (tx) =>
    tx.auditEvent.create({
      data: {
        tenantId: a,
        actorId: "u",
        action: "x",
        resource: "r",
        outcome: "ok",
        source: "test",
      },
    }),
  );
  await expect(withTenant(app, a, (tx) => tx.auditEvent.deleteMany())).rejects.toThrow();
});
