import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaClient } from "@dentalos/db";
import type { PgBoss } from "pg-boss";
import { enqueue, ensureQueue, registerTenantJob, startBoss } from "./jobs";

const ADMIN = "postgresql://postgres:postgres@localhost:5433/dentalos";
const APP = "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos";
const admin = new PrismaClient({ datasources: { db: { url: ADMIN } } });
const app = new PrismaClient({ datasources: { db: { url: APP } } });
let boss: PgBoss;
let t: string;

const until = async (cond: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for job");
    await Bun.sleep(100);
  }
};

beforeAll(async () => {
  t = (await admin.tenant.create({ data: { name: "jobs" } })).id;
  boss = await startBoss(ADMIN); // pg-boss owns its own schema; needs DDL rights (migration role in prod)
});
afterAll(async () => {
  await boss.stop({ graceful: true, timeout: 2000 });
  await admin.$disconnect();
  await app.$disconnect();
});

test("job retries after failure, then succeeds, inside tenant RLS context", async () => {
  let attempts = 0;
  let sawTenant: string | undefined;
  let rowsVisible = -1;
  await registerTenantJob<{ n: number }>(
    boss,
    app,
    "poc-retry",
    async (tx, env) => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      const r = await tx.$queryRaw<
        { v: string }[]
      >`SELECT current_setting('app.tenant_id', true) AS v`;
      sawTenant = r[0]?.v;
      rowsVisible = (await tx.tenant.findMany()).length; // RLS => only own tenant
      expect(env.actorId).toBe("worker-test");
    },
    { retryLimit: 3, retryDelaySeconds: 1 },
  );
  await enqueue(boss, "poc-retry", {
    tenantId: t,
    actorId: "worker-test",
    source: "test",
    idempotencyKey: `k-${Date.now()}`,
    data: { n: 1 },
  });
  await until(() => attempts >= 2 && rowsVisible >= 0);
  expect(attempts).toBe(2);
  expect(sawTenant).toBe(t);
  expect(rowsVisible).toBe(1);
});

test("duplicate enqueue with the same idempotency key is collapsed", async () => {
  const key = `dup-${Date.now()}`;
  const env = { tenantId: t, actorId: "u", source: "test", idempotencyKey: key, data: {} };
  await boss.deleteQueue("poc-dedupe").catch(() => {}); // policy is fixed at creation; reset stale dev queue
  await ensureQueue(boss, "poc-dedupe");
  const first = await enqueue(boss, "poc-dedupe", env);
  const second = await enqueue(boss, "poc-dedupe", env);
  expect(first).toBeTruthy();
  expect(second).toBeNull();
});

test("enqueue without tenant context is rejected", async () => {
  await expect(
    enqueue(boss, "poc-retry", {
      tenantId: "",
      actorId: "u",
      source: "t",
      idempotencyKey: "x",
      data: {},
    }),
  ).rejects.toThrow();
});
