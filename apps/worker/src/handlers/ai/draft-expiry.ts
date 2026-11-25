import { AI_QUEUES, aiDraftExpirySweepJob, z } from "@dentalos/validation";
import { ensureQueue } from "../../jobs";
import { type HandlerCtx, log, registerWork, sendJob } from "../notifications/work";

const CAPABILITY_OF_KIND: Record<string, string> = {
  PATIENT_HISTORY_SUMMARY: "patient_history_summary",
  ENCOUNTER_SUMMARY: "encounter_summary",
  CLINICAL_NOTE: "clinical_note_draft",
  VOICE_NOTE: "voice_note_draft",
  PLAN_EXPLANATION: "plan_explanation",
};
const BATCH = 500;
const TICK_QUEUE = "ai.sweep-tick";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ai.draft-expiry-sweep` (ADR 0005 §5.2): DRAFT rows past `expiresAt` become EXPIRED (a one-way move the DB trigger
 * allows exactly once) with one `expire` row each in the append-only activity log (no content). Safe to re-run: only
 * rows still in DRAFT move. A cron tick fans the sweep out per tenant daily (AI_EXPIRY_SWEEP_CRON, default 03:15).
 */
export async function registerDraftExpiryHandler(ctx: HandlerCtx) {
  await registerWork(ctx, AI_QUEUES.DRAFT_EXPIRY_SWEEP, aiDraftExpirySweepJob, async (c) => {
    const asOf = c.env.data.asOf ? new Date(c.env.data.asOf) : new Date();
    const n = await c.tx(async (tx) => {
      const due = await tx.aiDraft.findMany({
        where: { status: "DRAFT", expiresAt: { lt: asOf } },
        select: { id: true, kind: true, branchId: true, patientId: true, metadata: true },
        orderBy: { expiresAt: "asc" },
        take: BATCH,
      });
      if (due.length === 0) return 0;
      const moved = await tx.aiDraft.updateMany({
        where: { id: { in: due.map((d) => d.id) }, status: "DRAFT", expiresAt: { lt: asOf } },
        data: { status: "EXPIRED" },
      });
      for (const d of due) {
        const meta = d.metadata as { provider?: string; model?: string };
        await tx.aiActivityLog.create({
          data: {
            tenantId: c.env.tenantId,
            actorId: "system",
            scope: "PATIENT",
            branchId: d.branchId,
            patientId: d.patientId,
            capability: CAPABILITY_OF_KIND[d.kind] ?? "unknown_capability",
            provider: meta.provider ?? "unknown",
            model: meta.model ?? "unknown",
            action: "expire",
            draftId: d.id,
            outcome: "success",
            deidentified: true,
          },
        });
      }
      return moved.count;
    });
    if (n > 0) log("info", "ai.draft-expiry-sweep", { tenantId: c.env.tenantId, expired: n });
  });

  // Daily fan-out (pg-boss cron). Tenants: AI_SCAN_TENANTS / NOTIFY_SCAN_TENANTS (comma separated) else the Tenant table
  // through the pg-boss owner connection (the app role cannot list tenants under RLS).
  await ensureQueue(ctx.boss, TICK_QUEUE, { retryLimit: 1, retryDelaySeconds: 30 });
  await ctx.boss.work(TICK_QUEUE, async (jobs) => {
    for (const _ of jobs) {
      const only = (process.env.AI_SCAN_TENANTS || process.env.NOTIFY_SCAN_TENANTS || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => UUID.test(s));
      let tenants = only;
      if (tenants.length === 0) {
        try {
          const r = (await ctx.boss
            .getDb()
            .executeSql(`SELECT id::text AS id FROM "Tenant"`, [])) as {
            rows: Array<{ id: string }>;
          };
          tenants = r.rows.map((x) => x.id);
        } catch (err) {
          log("warn", "ai: tenant list unavailable from the pg-boss connection", {
            err: String(err),
          });
        }
      }
      const day = new Date().toISOString().slice(0, 10);
      for (const tenantId of tenants)
        await sendJob(ctx.boss, AI_QUEUES.DRAFT_EXPIRY_SWEEP, {
          tenantId,
          actorId: "system",
          source: "scheduler.ai",
          idempotencyKey: `ai-expiry:${day}`,
          data: z.object({}).parse({}),
        });
    }
  });
  await ctx.boss.schedule(
    TICK_QUEUE,
    process.env.AI_EXPIRY_SWEEP_CRON || "15 3 * * *",
    {},
    {
      key: "ai-expiry",
    },
  );
}
