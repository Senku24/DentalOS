import {
  ANALYTICS_QUEUES,
  DEFAULT_ANALYTICS_TIME_ZONE,
  type SnapshotSweepJob,
  addCalendarDays,
  snapshotSweepJob,
  utcToZoned,
} from "@dentalos/validation";
import { type JobEnvelope, enqueue, ensureQueue, registerTenantJob } from "../../jobs";
import type { HandlerContext } from "../index";
import { validZone } from "./snapshot";

const log = (level: "info" | "warn" | "error", msg: string, extra: object = {}) =>
  console[level === "info" ? "log" : level](
    JSON.stringify({ level, service: "worker", msg, ...extra }),
  );

/** Days of catch-up per branch (yesterday and the two before it), so a worker outage does not leave holes. */
const LOOKBACK_DAYS = 3;
const TICK_QUEUE = "analytics.sweep-tick";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant ids for the cron fan-out. The app role cannot list tenants (RLS), so the pg-boss owner connection is used;
 * ANALYTICS_SCAN_TENANTS (comma-separated ids; NOTIFY_SCAN_TENANTS as a fallback) overrides the table (restricted
 * roles, dev).
 */
async function listTenants({ boss }: HandlerContext): Promise<string[]> {
  const only = (process.env.ANALYTICS_SCAN_TENANTS ?? process.env.NOTIFY_SCAN_TENANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID.test(s));
  if (only.length > 0) return only;
  try {
    const r = (await boss.getDb().executeSql(`SELECT id::text AS id FROM "Tenant"`, [])) as {
      rows: Array<{ id: string }>;
    };
    return r.rows.map((x) => x.id);
  } catch (err) {
    log("warn", "analytics: tenant list unavailable from the pg-boss connection", {
      err: String(err),
    });
    return [];
  }
}

/**
 * Cron fan-out (ANALYTICS_SNAPSHOT_CRON, default hourly at :10): one `analytics.snapshot-sweep` tenant job per tenant.
 * The sweep (tenant job) lists the active branches, works out each branch's local yesterday (and the previous days of
 * the lookback), finds the days that have no snapshot yet and enqueues one `analytics.daily-snapshot` per missing
 * (branch, day). Running the sweep any number of times is safe (idempotency keys + the unique row).
 */
export async function registerSweep(ctx: HandlerContext) {
  const { boss, prisma } = ctx;

  await registerTenantJob<SnapshotSweepJob>(
    boss,
    prisma,
    ANALYTICS_QUEUES.SNAPSHOT_SWEEP,
    async (tx, env: JobEnvelope<SnapshotSweepJob>) => {
      const parsed = snapshotSweepJob.safeParse(env.data ?? {});
      if (!parsed.success) {
        log("error", "dropping malformed snapshot-sweep job", { tenantId: env.tenantId });
        return;
      }
      const asOf = parsed.data.asOf ? new Date(parsed.data.asOf) : new Date();
      const branches = await tx.branch.findMany({
        where: { active: true },
        select: { id: true, timezone: true },
      });
      const wanted: { branchId: string; day: string }[] = [];
      for (const b of branches) {
        const tz = validZone(b.timezone) ? b.timezone : DEFAULT_ANALYTICS_TIME_ZONE;
        const today = utcToZoned(asOf, tz).date;
        for (let i = 1; i <= LOOKBACK_DAYS; i++)
          wanted.push({ branchId: b.id, day: addCalendarDays(today, -i) });
      }
      if (wanted.length === 0) return;
      const have = await tx.analyticsSnapshot.findMany({
        where: {
          branchId: { in: branches.map((b) => b.id) },
          day: {
            gte: new Date(
              `${wanted.reduce((m, w) => (w.day < m ? w.day : m), wanted[0]?.day ?? "")}T00:00:00.000Z`,
            ),
          },
        },
        select: { branchId: true, day: true },
      });
      const done = new Set(have.map((h) => `${h.branchId}|${h.day.toISOString().slice(0, 10)}`));
      let queued = 0;
      for (const w of wanted) {
        if (done.has(`${w.branchId}|${w.day}`)) continue;
        await enqueue(boss, ANALYTICS_QUEUES.DAILY_SNAPSHOT, {
          tenantId: env.tenantId,
          actorId: "system",
          source: "analytics.snapshot-sweep",
          idempotencyKey: `snapshot:${w.branchId}:${w.day}`,
          data: { branchId: w.branchId, day: w.day },
        });
        queued++;
      }
      log("info", "analytics snapshot sweep", { tenantId: env.tenantId, queued });
    },
    { retryLimit: 2, retryDelaySeconds: 30 },
  );

  await ensureQueue(boss, TICK_QUEUE, { retryLimit: 1, retryDelaySeconds: 30 });
  await boss.work(TICK_QUEUE, async (jobs) => {
    if (jobs.length === 0) return;
    const bucket = new Date().toISOString().slice(0, 13); // one fan-out per hour
    for (const tenantId of await listTenants(ctx))
      await enqueue(boss, ANALYTICS_QUEUES.SNAPSHOT_SWEEP, {
        tenantId,
        actorId: "system",
        source: "scheduler.analytics",
        idempotencyKey: `snapshot-sweep:${bucket}`,
        data: {},
      });
  });
  await boss.schedule(
    TICK_QUEUE,
    process.env.ANALYTICS_SNAPSHOT_CRON || "10 * * * *",
    {},
    {
      key: "analytics-snapshot",
    },
  );
}
