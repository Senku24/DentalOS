import type { NotificationOutbox, Prisma, Tx } from "@dentalos/db";
import {
  NOTIFICATION_QUEUES,
  type NotificationChannel,
  type NotificationPurpose,
  type PreferenceRow,
  type ResolvedNotificationSettings,
  nextAllowedSendTime,
  resolveConsent,
  resolveNotificationSettings,
} from "@dentalos/validation";
import { Injectable } from "@nestjs/common";
import { JobQueueService } from "../common/job-queue.service";

export interface EnqueueInput {
  actorId: string;
  branchId?: string | null;
  patientId?: string | null;
  channel: NotificationChannel;
  templateCode: string;
  language?: string;
  toAddress: string;
  variables: Record<string, string | number>;
  idempotencyKey: string;
  source: string;
  refType?: string;
  refId?: string;
  scheduledFor?: Date;
}
export type EnqueueResult =
  | { ok: true; row: NotificationOutbox; created: boolean }
  | { ok: false; reason: "template_missing" | "channel_disabled" };

/**
 * Outbox enqueue service of the API (test sends, retries; ADR 0004 §9). Same rules as the worker's copy
 * (apps/worker/src/handlers/notifications/outbox.ts): template version resolution, `resolveConsent` against the
 * `CommunicationPreference` rows (strictest reading when there is no row), quiet hours, idempotent insert on
 * `(tenantId, idempotencyKey)`. Rows only ever enter as QUEUED / SKIPPED_NO_CONSENT / OPTED_OUT (DB guard); the
 * send job is enqueued AFTER the transaction committed via `dispatch`.
 */
@Injectable()
export class NotificationEnqueueService {
  constructor(private readonly jobs: JobQueueService) {}

  async settings(tx: Tx, tenantId: string): Promise<ResolvedNotificationSettings> {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    return resolveNotificationSettings(t?.settings);
  }

  async findTemplateVersion(tx: Tx, code: string, channel: NotificationChannel, language = "en") {
    for (const lang of language === "en" ? ["en"] : [language, "en"]) {
      const t = await tx.notificationTemplate.findFirst({
        where: { code, channel, language: lang, active: true, currentVersion: { gt: 0 } },
      });
      if (!t) continue;
      const v = await tx.notificationTemplateVersion.findUnique({
        where: {
          tenantId_templateId_version: {
            tenantId: t.tenantId,
            templateId: t.id,
            version: t.currentVersion,
          },
        },
      });
      if (v) return { template: t, version: v };
    }
    return null;
  }

  async enqueue(
    tx: Tx,
    tenantId: string,
    settings: ResolvedNotificationSettings,
    input: EnqueueInput,
    now = new Date(),
  ): Promise<EnqueueResult> {
    const existing = await tx.notificationOutbox.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return { ok: true, row: existing, created: false };
    if (!settings.enabledChannels.includes(input.channel))
      return { ok: false, reason: "channel_disabled" };
    const found = await this.findTemplateVersion(
      tx,
      input.templateCode,
      input.channel,
      input.language,
    );
    if (!found) return { ok: false, reason: "template_missing" };
    const purpose = found.template.purpose as NotificationPurpose;
    return this.insert(tx, tenantId, settings, input, {
      templateVersionId: found.version.id,
      purpose,
      now,
    });
  }

  /**
   * Re-queues a FAILED message as a NEW row (a FAILED row is final by the DB guard): same pinned template version,
   * address and variables, consent and quiet hours evaluated again. Idempotent: the key is `retry:<original id>`.
   */
  retry(
    tx: Tx,
    tenantId: string,
    settings: ResolvedNotificationSettings,
    orig: NotificationOutbox,
    actorId: string,
  ) {
    return this.insert(
      tx,
      tenantId,
      settings,
      {
        actorId,
        branchId: orig.branchId,
        patientId: orig.patientId,
        channel: orig.channel as NotificationChannel,
        templateCode: orig.templateCode,
        toAddress: orig.toAddress,
        variables: (orig.variables ?? {}) as Record<string, string | number>,
        idempotencyKey: `retry:${orig.id}`,
        source: `retry:${orig.id}`,
        refType: orig.refType ?? undefined,
        refId: orig.refId ?? undefined,
      },
      { templateVersionId: orig.templateVersionId, purpose: orig.purpose, now: new Date() },
    );
  }

  private async insert(
    tx: Tx,
    tenantId: string,
    settings: ResolvedNotificationSettings,
    input: EnqueueInput,
    pinned: { templateVersionId: string; purpose: NotificationPurpose; now: Date },
  ): Promise<{ ok: true; row: NotificationOutbox; created: boolean }> {
    const key = { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } };
    let status: "QUEUED" | "SKIPPED_NO_CONSENT" | "OPTED_OUT" = "QUEUED";
    let lastError: string | null = null;
    if (input.patientId) {
      const prefs: PreferenceRow[] = await tx.communicationPreference.findMany({
        where: { patientId: input.patientId },
        select: { channel: true, purpose: true, optIn: true },
      });
      const d = resolveConsent(prefs, input.channel, pinned.purpose, settings.consent);
      if (d.decision !== "SEND") {
        status = d.decision;
        lastError = d.reason;
      }
    }
    let scheduledFor =
      input.scheduledFor && input.scheduledFor > pinned.now ? input.scheduledFor : pinned.now;
    const qh = settings.quietHours;
    if (status === "QUEUED" && qh && !qh.exemptPurposes.includes(pinned.purpose))
      scheduledFor = nextAllowedSendTime(scheduledFor, qh);
    const data: Prisma.NotificationOutboxCreateManyInput = {
      tenantId,
      branchId: input.branchId ?? null,
      patientId: input.patientId ?? null,
      channel: input.channel,
      purpose: pinned.purpose,
      templateCode: input.templateCode,
      templateVersionId: pinned.templateVersionId,
      toAddress: input.toAddress,
      variables: input.variables,
      status,
      scheduledFor,
      nextAttemptAt: status === "QUEUED" ? scheduledFor : null,
      idempotencyKey: input.idempotencyKey,
      lastError,
      source: input.source,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      actorId: input.actorId,
    };
    // ON CONFLICT DO NOTHING keeps the transaction usable when a twin request wins the race.
    const { count } = await tx.notificationOutbox.createMany({
      data: [data],
      skipDuplicates: true,
    });
    const row = await tx.notificationOutbox.findUniqueOrThrow({ where: key });
    return { ok: true, row, created: count === 1 };
  }

  /** Enqueues the send job for a QUEUED row. Call AFTER the transaction that wrote the row committed. */
  async dispatch(
    tenantId: string,
    actorId: string,
    row: Pick<NotificationOutbox, "id" | "status" | "scheduledFor">,
  ) {
    if (row.status !== "QUEUED") return null;
    return this.jobs.enqueue(
      NOTIFICATION_QUEUES.SEND,
      {
        tenantId,
        actorId,
        source: "api",
        idempotencyKey: `send:${row.id}:0`,
        data: { outboxId: row.id },
      },
      { startAfter: row.scheduledFor > new Date() ? row.scheduledFor : undefined },
    );
  }
}
