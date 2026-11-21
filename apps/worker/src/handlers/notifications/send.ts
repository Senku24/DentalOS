import type { NotificationOutbox } from "@dentalos/db";
import {
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_QUEUES,
  type NotificationChannel,
  isWithinQuietHours,
  nextAllowedSendTime,
  renderTemplate,
  resolveConsent,
  retryDelaySeconds,
  sendNotificationJob,
} from "@dentalos/validation";
import { loadPrefs, loadSettings } from "./outbox";
import { type NotificationProvider, ProviderError } from "./provider";
import { type HandlerCtx, log, registerWork } from "./work";

/**
 * Dev knob: scales the retry backoff (`retryDelaySeconds`), e.g. NOTIFY_RETRY_SCALE=0.02 turns 30 s into 0.6 s so the
 * retry / FAILED path can be exercised quickly. Default 1 (the ADR schedule: 30 s, 1 m, 2 m, 4 m, capped at 1 h).
 */
const retryScale = () => {
  const n = Number(process.env.NOTIFY_RETRY_SCALE);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

type Plan =
  | { kind: "noop" }
  | { kind: "later"; at: Date }
  | {
      kind: "send";
      row: NotificationOutbox;
      subject: string | null;
      body: string;
      ref: string | null;
    };

/**
 * `notifications.send` (ADR 0004 §9.5). Idempotent and bounded:
 *  1. short tx: load the row; anything but QUEUED is a no-op (duplicate delivery); not yet due -> re-schedule; consent is
 *     re-resolved at send time (preferences change) -> SKIPPED_NO_CONSENT / OPTED_OUT; quiet hours re-checked; render the
 *     pinned template version (missing placeholders = permanent FAILED: a half-filled message is never sent).
 *  2. OUTSIDE any transaction: provider.send (the outbox idempotency key is the provider's de-dupe key).
 *  3. short tx: record SENT, or count the attempt: below NOTIFICATION_MAX_ATTEMPTS the row stays QUEUED with
 *     `nextAttemptAt` and a delayed follow-up job (backoff helper), at the limit it becomes FAILED. The attempt counter
 *     lives in the row, so the loop is bounded no matter how often the job is delivered.
 */
export async function registerSendHandler(ctx: HandlerCtx, provider: NotificationProvider) {
  await registerWork(
    ctx,
    NOTIFICATION_QUEUES.SEND,
    sendNotificationJob,
    async (c) => {
      const { outboxId } = c.env.data;
      const plan = await c.tx<Plan>(async (tx) => {
        const row = await tx.notificationOutbox.findUnique({ where: { id: outboxId } });
        if (!row) throw new Error("outbox_row_not_found"); // enqueued before visible: let pg-boss retry
        if (row.status !== "QUEUED") return { kind: "noop" };
        const now = new Date();
        const due =
          row.nextAttemptAt && row.nextAttemptAt > row.scheduledFor
            ? row.nextAttemptAt
            : row.scheduledFor;
        if (due.getTime() > now.getTime() + 1000) return { kind: "later", at: due };

        const settings = await loadSettings(tx, c.env.tenantId);
        if (row.patientId) {
          const d = resolveConsent(
            await loadPrefs(tx, row.patientId),
            row.channel,
            row.purpose,
            settings.consent,
          );
          if (d.decision !== "SEND") {
            await tx.notificationOutbox.update({
              where: { id: row.id },
              data: { status: d.decision, lastError: d.reason, nextAttemptAt: null },
            });
            return { kind: "noop" };
          }
        }
        const qh = settings.quietHours;
        if (qh && !qh.exemptPurposes.includes(row.purpose) && isWithinQuietHours(now, qh)) {
          const at = nextAllowedSendTime(now, qh);
          await tx.notificationOutbox.update({
            where: { id: row.id },
            data: { scheduledFor: at, nextAttemptAt: at },
          });
          return { kind: "later", at };
        }
        const version = await tx.notificationTemplateVersion.findUnique({
          where: { id: row.templateVersionId },
        });
        if (!version) throw new Error("template_version_not_found");
        const vars = (row.variables ?? {}) as Record<string, unknown>;
        const body = renderTemplate(version.body, vars);
        const subject = version.subject ? renderTemplate(version.subject, vars) : null;
        const missing = [...body.missing, ...(subject?.missing ?? [])];
        if (missing.length > 0) {
          await tx.notificationOutbox.update({
            where: { id: row.id },
            data: {
              status: "FAILED",
              attempts: row.attempts + 1,
              lastError: `template_variables_missing:${[...new Set(missing)].join(",")}`.slice(
                0,
                500,
              ),
              nextAttemptAt: null,
            },
          });
          return { kind: "noop" };
        }
        return {
          kind: "send",
          row,
          subject: subject?.text ?? null,
          body: body.text,
          ref: version.providerTemplateRef,
        };
      });

      if (plan.kind === "noop") return;
      if (plan.kind === "later") {
        await c.send(
          NOTIFICATION_QUEUES.SEND,
          { outboxId },
          { idempotencyKey: `send:${outboxId}:due:${plan.at.getTime()}`, startAfter: plan.at },
        );
        return;
      }

      const { row } = plan;
      let providerMessageId: string | null = null;
      let errorCode: string | null = null;
      try {
        const r = await provider.send({
          channel: row.channel as NotificationChannel,
          to: row.toAddress,
          subject: plan.subject,
          body: plan.body,
          providerTemplateRef: plan.ref,
          idempotencyKey: row.idempotencyKey,
        });
        providerMessageId = r.providerMessageId;
      } catch (err) {
        errorCode = err instanceof ProviderError ? err.code : "provider_error"; // never err.message: may carry addresses
      }

      const attempts = row.attempts + 1;
      if (providerMessageId) {
        const n = await c.tx((tx) =>
          tx.notificationOutbox.updateMany({
            where: { id: row.id, status: "QUEUED" },
            data: {
              status: "SENT",
              attempts,
              provider: provider.name,
              providerMessageId,
              sentAt: new Date(),
              lastError: null,
              nextAttemptAt: null,
            },
          }),
        );
        log("info", "notification marked SENT", { outboxId: row.id, updated: n.count });
        return;
      }
      const exhausted = attempts >= NOTIFICATION_MAX_ATTEMPTS;
      const next = new Date(Date.now() + retryDelaySeconds(attempts) * 1000 * retryScale());
      await c.tx((tx) =>
        tx.notificationOutbox.updateMany({
          where: { id: row.id, status: "QUEUED" },
          data: exhausted
            ? { status: "FAILED", attempts, lastError: errorCode, nextAttemptAt: null }
            : { attempts, lastError: errorCode, nextAttemptAt: next },
        }),
      );
      if (exhausted) {
        log("warn", "notification FAILED after max attempts", {
          outboxId: row.id,
          attempts,
          errorCode,
        });
        return;
      }
      await c.send(
        NOTIFICATION_QUEUES.SEND,
        { outboxId },
        { idempotencyKey: `send:${outboxId}:retry:${attempts}`, startAfter: next },
      );
      log("warn", "notification attempt failed, retry scheduled", {
        outboxId: row.id,
        attempts,
        errorCode,
        nextAttemptAt: next.toISOString(),
      });
    },
    // pg-boss's own retries only cover crashes / unexpected throws; the delivery retries above are ours.
    { retryLimit: 2, retryDelaySeconds: 10 },
  );
}
