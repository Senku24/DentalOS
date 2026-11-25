import type { Tx } from "@dentalos/db";
import { Prisma } from "@dentalos/db";
import {
  AI_QUEUES,
  ANALYTICS_QUEUES,
  APPOINTMENT_STATUSES,
  DEFAULT_ANALYTICS_TIME_ZONE,
  type DailySnapshotJob,
  addCalendarDays,
  appointmentRates,
  branchDailyMetrics,
  dailySnapshotJob,
  utcToZoned,
  zonedToUtc,
} from "@dentalos/validation";
import { type JobEnvelope, ensureQueue, registerTenantJob } from "../../jobs";
import type { HandlerContext } from "../index";

const log = (level: "info" | "warn" | "error", msg: string, extra: object = {}) =>
  console[level === "info" ? "log" : level](
    JSON.stringify({ level, service: "worker", msg, ...extra }),
  );

const n = (v: unknown) => Number(v ?? 0);
const ts = (d: Date) => Prisma.sql`${d}::timestamptz`;

export const validZone = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * `branchDailyMetrics` of one branch-local day (ADR 0005 §4.2 definitions, same as the API's analytics queries; this is
 * a deliberate local copy because the worker cannot import the API). One grouped query per entity, all inside the
 * tenant transaction (RLS). Money is integer paise, rates integer basis points. `outstandingPaise` is the open balance
 * at COMPUTE time (an "as of the day" ledger does not exist).
 */
export async function computeBranchDay(tx: Tx, branchId: string, day: string, tz: string) {
  const start = zonedToUtc(day, 0, tz);
  const end = zonedToUtc(addCalendarDays(day, 1), 0, tz);

  const appts = await tx.$queryRaw<{ s: string; c: bigint }[]>(Prisma.sql`
    SELECT a."status"::text AS s, count(*)::bigint AS c
      FROM "Appointment" a
     WHERE a."branchId" = ${branchId}::uuid
       AND a."startsAt" >= ${ts(start)} AND a."startsAt" < ${ts(end)}
     GROUP BY 1`);
  const byStatus: Record<string, number> = Object.fromEntries(
    APPOINTMENT_STATUSES.map((s) => [s, 0]),
  );
  for (const r of appts) byStatus[r.s] = n(r.c);
  const total = Object.values(byStatus).reduce((a, v) => a + v, 0);
  // a closed day: every appointment's start has passed, so "resolved" is simply the non-rescheduled ones
  const rates = appointmentRates(byStatus);

  const [patients, billed, pay, ref, outstanding] = await Promise.all([
    tx.$queryRaw<{ c: bigint }[]>(Prisma.sql`
      SELECT count(*)::bigint AS c FROM "Patient" p
       WHERE p."originBranchId" = ${branchId}::uuid AND p."mergedIntoId" IS NULL
         AND p."createdAt" >= ${ts(start)} AND p."createdAt" < ${ts(end)}`),
    tx.$queryRaw<{ v: bigint }[]>(Prisma.sql`
      SELECT coalesce(sum(i."totalPaise"), 0)::bigint AS v FROM "Invoice" i
       WHERE i."branchId" = ${branchId}::uuid AND i."status" IN ('ISSUED','PARTIALLY_PAID','PAID')
         AND i."issuedAt" >= ${ts(start)} AND i."issuedAt" < ${ts(end)}`),
    tx.$queryRaw<{ v: bigint }[]>(Prisma.sql`
      SELECT coalesce(sum(p."amountPaise"), 0)::bigint AS v FROM "Payment" p
       WHERE p."branchId" = ${branchId}::uuid AND p."status" = 'RECORDED'
         AND p."receivedAt" >= ${ts(start)} AND p."receivedAt" < ${ts(end)}`),
    tx.$queryRaw<{ v: bigint }[]>(Prisma.sql`
      SELECT coalesce(sum(r."amountPaise"), 0)::bigint AS v FROM "Refund" r
       WHERE r."branchId" = ${branchId}::uuid AND r."status" = 'PROCESSED'
         AND r."processedAt" >= ${ts(start)} AND r."processedAt" < ${ts(end)}`),
    tx.$queryRaw<{ v: bigint }[]>(Prisma.sql`
      SELECT coalesce(sum(i."balancePaise"), 0)::bigint AS v FROM "Invoice" i
       WHERE i."branchId" = ${branchId}::uuid AND i."status" IN ('ISSUED','PARTIALLY_PAID')`),
  ]);

  return branchDailyMetrics.parse({
    appointments: { total, byStatus },
    completedVisits: byStatus.COMPLETED ?? 0,
    newPatients: n(patients[0]?.c),
    cancellationRateBp: rates.cancellationRateBp,
    noShowRateBp: rates.noShowRateBp,
    billedPaise: n(billed[0]?.v),
    collectedPaise: n(pay[0]?.v) - n(ref[0]?.v),
    outstandingPaise: n(outstanding[0]?.v),
  });
}

/** Branch-local "yesterday". */
export const yesterdayIn = (tz: string, now: Date = new Date()) =>
  addCalendarDays(utcToZoned(now, tz).date, -1);

/**
 * `analytics.daily-snapshot` (ADR 0005 §4.5): computes one branch-local day (default: yesterday in the branch zone) and
 * upserts the `AnalyticsSnapshot` row (UNIQUE tenant + branch + day, `INSERT .. ON CONFLICT`, so running it twice or
 * concurrently leaves exactly one row). Without `force` an existing snapshot is left alone (no work, no AI re-queue);
 * with `force` the numbers are recomputed and the row updated in place. After the commit window it queues
 * `ai.daily-summary` for the row (the AI handler decides whether the capability is enabled / within quota).
 */
export async function registerSnapshotHandler({ boss, prisma }: HandlerContext) {
  // The AI worker owns this queue, but it may start after us: creating it is idempotent and keeps `send` from failing.
  await ensureQueue(boss, AI_QUEUES.DAILY_SUMMARY);
  await registerTenantJob<DailySnapshotJob>(
    boss,
    prisma,
    ANALYTICS_QUEUES.DAILY_SNAPSHOT,
    async (tx, env: JobEnvelope<DailySnapshotJob>) => {
      const parsed = dailySnapshotJob.safeParse(env.data);
      if (!parsed.success) {
        log("error", "dropping malformed daily-snapshot job", { tenantId: env.tenantId });
        return;
      }
      const job = parsed.data;
      const branch = await tx.branch.findFirst({
        where: { id: job.branchId },
        select: { id: true, timezone: true },
      });
      if (!branch) {
        log("warn", "daily-snapshot: branch not found", {
          tenantId: env.tenantId,
          branchId: job.branchId,
        });
        return;
      }
      const tz = validZone(branch.timezone) ? branch.timezone : DEFAULT_ANALYTICS_TIME_ZONE;
      const day = job.day ?? yesterdayIn(tz);
      if (day > utcToZoned(new Date(), tz).date) {
        log("warn", "daily-snapshot: day is in the future, skipped", {
          tenantId: env.tenantId,
          branchId: branch.id,
          day,
        });
        return;
      }
      if (!job.force) {
        const existing = await tx.analyticsSnapshot.findFirst({
          where: { branchId: branch.id, day: new Date(`${day}T00:00:00.000Z`) },
          select: { id: true },
        });
        if (existing) return;
      }
      const metrics = await computeBranchDay(tx, branch.id, day, tz);
      const rows = await tx.$queryRaw<{ id: string; created: boolean }[]>(Prisma.sql`
        INSERT INTO "AnalyticsSnapshot" ("id", "tenantId", "branchId", "day", "metrics", "generatedAt", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${env.tenantId}::uuid, ${branch.id}::uuid, ${day}::date,
                ${JSON.stringify(metrics)}::jsonb, now(), now(), now())
        ON CONFLICT ("tenantId", "branchId", "day")
        DO UPDATE SET "metrics" = EXCLUDED."metrics", "generatedAt" = now(), "updatedAt" = now()
        RETURNING "id"::text AS id, (xmax = 0) AS created`);
      const row = rows[0];
      if (!row) return;
      log("info", "analytics snapshot", {
        tenantId: env.tenantId,
        branchId: branch.id,
        day,
        snapshotId: row.id,
        created: row.created,
      });
      // The AI handler runs in its own transaction: delay it so this one has committed (ids-only payload).
      // A failure here must never roll back the snapshot: the summary is a nicety, the numbers are the record.
      try {
        await boss.send(
          AI_QUEUES.DAILY_SUMMARY,
          {
            tenantId: env.tenantId,
            actorId: env.actorId,
            source: "analytics.daily-snapshot",
            idempotencyKey: `daily-summary:${row.id}`,
            data: { snapshotId: row.id },
          },
          {
            singletonKey: `${env.tenantId}:daily-summary:${row.id}`,
            startAfter: new Date(Date.now() + 10_000),
          },
        );
      } catch (err) {
        log("warn", "daily-snapshot: could not queue the AI summary", {
          tenantId: env.tenantId,
          snapshotId: row.id,
          err: String(err),
        });
      }
    },
    { retryLimit: 3, retryDelaySeconds: 10 },
  );
}
