import { NOTIFICATION_QUEUES, z } from "@dentalos/validation";
import { ensureQueue } from "../../jobs";
import { REMINDER_SCAN_QUEUE } from "./appointments";
import { type HandlerCtx, log, sendJob } from "./work";

/**
 * Periodic fan-out. pg-boss `schedule()` runs a cron queue; each tick lists the tenants and enqueues one
 * tenant-envelope job per tenant (the handlers then run inside that tenant's RLS context). The app role cannot list
 * tenants (RLS), so the owner connection of pg-boss is used for the id list (`SELECT id FROM "Tenant"`); when that role
 * cannot read it, set NOTIFY_SCAN_TENANTS (comma-separated tenant ids): when set it is used INSTEAD of the table
 * (fallback for restricted roles, and a dev knob to limit the fan-out to a few tenants).
 *   NOTIFY_REMINDER_SCAN_CRON  default every 5 minutes
 *   NOTIFY_RECALL_SCAN_CRON    default 02:30 daily
 */
const TICK_QUEUE = "notifications.scan-tick";
const tickData = z.object({ kind: z.enum(["reminder", "recall"]) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listTenants(ctx: HandlerCtx): Promise<string[]> {
  const only = (process.env.NOTIFY_SCAN_TENANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID.test(s));
  if (only.length > 0) return only;
  try {
    const r = (await ctx.boss.getDb().executeSql(`SELECT id::text AS id FROM "Tenant"`, [])) as {
      rows: Array<{ id: string }>;
    };
    return r.rows.map((x) => x.id);
  } catch (err) {
    log("warn", "tenant list unavailable from the pg-boss connection", { err: String(err) });
    return [];
  }
}

export async function registerScanTicks(ctx: HandlerCtx) {
  await ensureQueue(ctx.boss, TICK_QUEUE, { retryLimit: 1, retryDelaySeconds: 30 });
  await ctx.boss.work(TICK_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const parsed = tickData.safeParse(job.data);
      if (!parsed.success) continue;
      const { kind } = parsed.data;
      const queue = kind === "reminder" ? REMINDER_SCAN_QUEUE : NOTIFICATION_QUEUES.RECALL_SWEEP;
      const bucket =
        kind === "reminder"
          ? Math.floor(Date.now() / 60_000)
          : new Date().toISOString().slice(0, 10);
      for (const tenantId of await listTenants(ctx))
        await sendJob(ctx.boss, queue, {
          tenantId,
          actorId: "system",
          source: `scheduler.${kind}`,
          idempotencyKey: `${kind}-scan:${bucket}`,
          data: {},
        });
    }
  });
  await ctx.boss.schedule(
    TICK_QUEUE,
    process.env.NOTIFY_REMINDER_SCAN_CRON || "*/5 * * * *",
    { kind: "reminder" },
    { key: "reminder" },
  );
  await ctx.boss.schedule(
    TICK_QUEUE,
    process.env.NOTIFY_RECALL_SCAN_CRON || "30 2 * * *",
    { kind: "recall" },
    { key: "recall" },
  );
}
