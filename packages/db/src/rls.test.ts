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

test("every public table enforces FORCE RLS with at least one policy (meta-test)", async () => {
  const rows = await admin.$queryRaw<
    { relname: string; rls: boolean; forced: boolean; policies: bigint; hasTenantCol: boolean }[]
  >`
    SELECT c.relname,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
           EXISTS (SELECT 1 FROM information_schema.columns k
                    WHERE k.table_schema = 'public' AND k.table_name = c.relname
                      AND k.column_name = 'tenantId') AS "hasTenantCol"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`;
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(`${r.relname}: rls=${r.rls} forced=${r.forced}`).toBe(
      `${r.relname}: rls=true forced=true`,
    );
    expect(Number(r.policies)).toBeGreaterThan(0);
    // Every table is tenant-owned, except the Tenant root itself.
    expect(r.relname === "Tenant" || r.hasTenantCol).toBe(true);
  }
});

const ev = (tenantId: string, action: string) => ({
  tenantId,
  actorId: "u",
  action,
  resource: "r",
  outcome: "success",
  source: "test",
});

test("audit hash chain links events, survives concurrency, and detects tampering", async () => {
  const t = (await admin.tenant.create({ data: { name: "chain" } })).id;
  await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      withTenant(app, t, (tx) => tx.auditEvent.create({ data: ev(t, `a${i}`) })),
    ),
  );
  const verify = async () =>
    (await admin.$queryRaw<{ v: bigint | null }[]>`SELECT verify_audit_chain(${t}::uuid) AS v`)[0]
      ?.v;
  const rows = await admin.auditEvent.findMany({
    where: { tenantId: t },
    orderBy: { chainPos: "asc" },
  });
  expect(rows.map((r) => Number(r.chainPos))).toEqual([1, 2, 3, 4, 5]);
  expect(rows[0]?.prevHash).toBeNull();
  expect(rows[1]?.prevHash).toBe(rows[0]?.hash ?? "");
  expect(await verify()).toBeNull();

  // Privileged tamper (the app role cannot UPDATE/DELETE) must be detected.
  await admin.$executeRaw`UPDATE "AuditEvent" SET "outcome" = 'denied' WHERE "tenantId" = ${t}::uuid AND "chainPos" = 3`;
  expect(Number(await verify())).toBe(3);
});

test("chain is per tenant and the app role cannot forge chain fields' integrity", async () => {
  await expect(
    withTenant(app, a, (tx) => tx.auditEvent.updateMany({ data: { hash: "x" } })),
  ).rejects.toThrow();
});

test("withTenant exposes actor id to the session", async () => {
  const actor = await withTenant(
    app,
    a,
    (tx) => tx.$queryRaw<{ v: string }[]>`SELECT current_setting('app.actor_id', true) AS v`,
    { actorId: "user-42" },
  );
  expect(actor[0]?.v).toBe("user-42");
});
