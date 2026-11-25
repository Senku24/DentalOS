import { PORTAL_QUEUES, portalRetentionSweepJob, scrubOtpMessageJob } from "@dentalos/validation";
import { ensureQueue } from "../../jobs";
import type { HandlerRegistrar } from "../index";
import { log, registerWork } from "../notifications/work";

/** Messages in these states never change again (the DB guard treats them as final). */
const FINAL = ["SENT", "FAILED", "SKIPPED_NO_CONSENT", "OPTED_OUT"] as const;
const RETENTION_QUEUE = PORTAL_QUEUES.RETENTION_SWEEP;
const OTP_RETENTION_DAYS = Number(process.env.PORTAL_OTP_RETENTION_DAYS ?? 7);
const SESSION_RETENTION_DAYS = Number(process.env.PORTAL_SESSION_RETENTION_DAYS ?? 90);

/**
 * M4 portal handlers (ADR 0005 §1.2 "Not left at rest", §1.3).
 *
 *  `portal.scrub-otp-message`  blanks `variables.code` of a FINAL PORTAL_OTP outbox row (migration 0009 allows exactly
 *                              that change on a final row, nothing else). A message still being delivered is retried
 *                              with backoff (a throw) so the code never stays in the table once the message is final.
 *  `portal.retention-sweep`    daily, global: deletes expired / consumed OTPs and long-dead sessions. The app role cannot
 *                              delete these rows (append-only grants), so it runs on the pg-boss owner connection
 *                              (PGBOSS_DATABASE_URL / ADMIN_DATABASE_URL) and is a logged no-op when that role lacks
 *                              the rights. Retention: OTPs PORTAL_OTP_RETENTION_DAYS (7), sessions PORTAL_SESSION_RETENTION_DAYS (90).
 */
export const registerPortalHandlers: HandlerRegistrar = async (ctx) => {
  await registerWork(
    ctx,
    PORTAL_QUEUES.SCRUB_OTP_MESSAGE,
    scrubOtpMessageJob,
    async (c) => {
      const { outboxId } = c.env.data;
      const done = await c.tx(async (tx) => {
        const row = await tx.notificationOutbox.findUnique({ where: { id: outboxId } });
        if (!row || row.templateCode !== "PORTAL_OTP") return true; // nothing to scrub
        if (!(FINAL as readonly string[]).includes(row.status)) return false; // still in flight
        const vars = (row.variables ?? {}) as Record<string, unknown>;
        if (!("code" in vars)) return true; // idempotent
        const { code: _code, ...rest } = vars;
        await tx.notificationOutbox.update({
          where: { id: outboxId },
          data: { variables: rest as never },
        });
        return true;
      });
      if (!done) throw new Error("otp message not final yet");
    },
    { retryLimit: 10, retryDelaySeconds: 30 },
  );

  await ensureQueue(ctx.boss, RETENTION_QUEUE, { retryLimit: 1, retryDelaySeconds: 60 });
  await ctx.boss.work(RETENTION_QUEUE, async (jobs) => {
    for (const job of jobs) {
      if (
        !portalRetentionSweepJob.safeParse((job.data as { data?: unknown } | null)?.data ?? {})
          .success
      )
        continue;
      try {
        const db = ctx.boss.getDb();
        const otps = (await db.executeSql(
          `DELETE FROM "PortalOtp" WHERE "expiresAt" < now() - ($1 || ' days')::interval`,
          [String(OTP_RETENTION_DAYS)],
        )) as { rowCount?: number };
        // A session may be the predecessor of a live rotation: delete leaves first, a few passes.
        let sessions = 0;
        for (let pass = 0; pass < 5; pass++) {
          const r = (await db.executeSql(
            `DELETE FROM "PortalSession" s
              WHERE COALESCE(s."revokedAt", s."expiresAt") < now() - ($1 || ' days')::interval
                AND NOT EXISTS (SELECT 1 FROM "PortalSession" n WHERE n."tenantId" = s."tenantId" AND n."rotatedFromId" = s."id")`,
            [String(SESSION_RETENTION_DAYS)],
          )) as { rowCount?: number };
          sessions += r.rowCount ?? 0;
          if (!r.rowCount) break;
        }
        log("info", "portal retention sweep", { otps: otps.rowCount ?? 0, sessions });
      } catch (err) {
        log("warn", "portal retention sweep skipped (the pg-boss role cannot delete these rows)", {
          err: String(err),
        });
      }
    }
  });
  await ctx.boss.schedule(
    RETENTION_QUEUE,
    process.env.PORTAL_RETENTION_CRON || "40 3 * * *",
    { data: {} },
    { key: "portal-retention" },
  );
};
