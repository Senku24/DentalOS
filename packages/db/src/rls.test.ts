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
let branchA: string;
let branchB: string;

beforeAll(async () => {
  a = (await admin.tenant.create({ data: { name: "A" } })).id;
  b = (await admin.tenant.create({ data: { name: "B" } })).id;
  branchA = (await admin.branch.create({ data: { tenantId: a, code: "A1", name: "A1" } })).id;
  branchB = (await admin.branch.create({ data: { tenantId: b, code: "B1", name: "B1" } })).id;
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
    withTenant(app, a, (tx) =>
      tx.branch.create({ data: { tenantId: b, code: "EVIL", name: "evil" } }),
    ),
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

test("setRolePassword rotates a role's password safely (quotes in the secret are inert)", async () => {
  const { setRolePassword } = await import("./role-password");
  await admin.$executeRawUnsafe("DROP ROLE IF EXISTS dentalos_pw_probe");
  await admin.$executeRawUnsafe("CREATE ROLE dentalos_pw_probe LOGIN PASSWORD 'old'");
  const secret = `p'a"ss;--\\${"x".repeat(24)}`;
  await setRolePassword(ADMIN_URL, "dentalos_pw_probe", secret);
  const probe = new PrismaClient({
    datasources: {
      db: {
        url: ADMIN_URL.replace(/\/\/[^@]+@/, `//dentalos_pw_probe:${encodeURIComponent(secret)}@`),
      },
    },
  });
  expect((await probe.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`)[0]?.ok).toBe(1);
  await probe.$disconnect();
  await expect(setRolePassword(ADMIN_URL, "x; DROP ROLE y", "z".repeat(30))).rejects.toThrow();
  await expect(setRolePassword(ADMIN_URL, "dentalos_pw_probe", "short")).rejects.toThrow();
  await admin.$executeRawUnsafe("DROP ROLE dentalos_pw_probe");
});

// --- M1 tables ---------------------------------------------------------------------------------
const patient = (tenantId: string, originBranchId: string, first = "Asha") => ({
  tenantId,
  originBranchId,
  firstName: first,
  nameNormalized: first.toLowerCase(),
  intakeType: "WALK_IN" as const,
  createdBy: "u",
});

test("patients are tenant-isolated and cannot reference another tenant's branch", async () => {
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  expect(
    await withTenant(app, b, (tx) => tx.patient.findUnique({ where: { id: p.id } })),
  ).toBeNull();
  // Composite FK (tenantId, originBranchId) -> Branch(tenantId, id): a guessed foreign UUID is rejected.
  await expect(
    withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchB) })),
  ).rejects.toThrow();
});

test("child rows cannot point at another tenant's patient (composite FK)", async () => {
  const pb = await withTenant(app, b, (tx) => tx.patient.create({ data: patient(b, branchB) }));
  await expect(
    withTenant(app, a, (tx) =>
      tx.patientAlert.create({
        data: { tenantId: a, patientId: pb.id, title: "x", severity: "HIGH", createdBy: "u" },
      }),
    ),
  ).rejects.toThrow();
});

test("medical history is append-only and patients cannot be hard-deleted by the app role", async () => {
  const p = await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA) }));
  const h = await withTenant(app, a, (tx) =>
    tx.patientMedicalHistory.create({
      data: { tenantId: a, patientId: p.id, version: 1, recordedBy: "u" },
    }),
  );
  await expect(
    withTenant(app, a, (tx) =>
      tx.patientMedicalHistory.update({ where: { id: h.id }, data: { notes: "rewrite" } }),
    ),
  ).rejects.toThrow();
  await expect(
    withTenant(app, a, (tx) => tx.patient.delete({ where: { id: p.id } })),
  ).rejects.toThrow();
});

test("only one open price override per service+branch; history rows allowed", async () => {
  const s = await withTenant(app, a, (tx) =>
    tx.service.create({
      data: {
        tenantId: a,
        code: `S-${Date.now()}`,
        name: "Scaling",
        durationMin: 30,
        basePricePaise: 150000,
      },
    }),
  );
  const ov = (closed: boolean) => ({
    tenantId: a,
    serviceId: s.id,
    branchId: branchA,
    pricePaise: 120000,
    reason: "local market",
    setBy: "u",
    effectiveFrom: new Date(Date.now() - 86_400_000),
    effectiveTo: closed ? new Date() : null,
  });
  await withTenant(app, a, (tx) => tx.branchPriceOverride.create({ data: ov(true) }));
  await withTenant(app, a, (tx) => tx.branchPriceOverride.create({ data: ov(false) }));
  await expect(
    withTenant(app, a, (tx) => tx.branchPriceOverride.create({ data: ov(false) })),
  ).rejects.toThrow();
});

test("pg_trgm similarity search works on normalised patient names", async () => {
  await withTenant(app, a, (tx) => tx.patient.create({ data: patient(a, branchA, "Priyanka") }));
  const rows = await withTenant(
    app,
    a,
    (tx) => tx.$queryRaw<{ n: string }[]>`
      SELECT "nameNormalized" AS n FROM "Patient"
       WHERE "nameNormalized" % ${"priyanka"} ORDER BY similarity("nameNormalized", ${"priyanka"}) DESC`,
  );
  expect(rows[0]?.n).toBe("priyanka");
});
