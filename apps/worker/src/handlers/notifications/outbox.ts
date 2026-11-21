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
import type { WorkCtx } from "./work";

/**
 * Worker-side enqueue service (ADR 0004 §9): the ONE place handlers create outbox rows. It resolves the template
 * version, applies consent (`resolveConsent`, strictest reading when no preference row), quiet hours, and inserts
 * idempotently on `(tenantId, idempotencyKey)`. The row is the source of truth; the send job is only a nudge that
 * the caller enqueues AFTER the transaction committed (`dispatch`).
 * (The API has its own copy for the test-send / retry endpoints: apps/api/src/notifications/enqueue.service.ts.
 * The two apps share only @dentalos/validation, where the rules themselves live as pure helpers.)
 */

export const loadSettings = async (tx: Tx, tenantId: string) => {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  return resolveNotificationSettings(t?.settings);
};

export const loadPrefs = (tx: Tx, patientId: string): Promise<PreferenceRow[]> =>
  tx.communicationPreference.findMany({
    where: { patientId },
    select: { channel: true, purpose: true, optIn: true },
  });

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
  /** Not before (reminders). Quiet hours may push it later. */
  scheduledFor?: Date;
}

export type EnqueueResult =
  | { ok: true; row: NotificationOutbox; created: boolean }
  | { ok: false; reason: "template_missing" | "channel_disabled" };

export async function findTemplateVersion(
  tx: Tx,
  code: string,
  channel: NotificationChannel,
  language = "en",
) {
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

export async function enqueueOutbox(
  tx: Tx,
  tenantId: string,
  settings: ResolvedNotificationSettings,
  input: EnqueueInput,
  prefs: PreferenceRow[] | null,
  now = new Date(),
): Promise<EnqueueResult> {
  const existing = await tx.notificationOutbox.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) return { ok: true, row: existing, created: false };
  if (!settings.enabledChannels.includes(input.channel))
    return { ok: false, reason: "channel_disabled" };
  const found = await findTemplateVersion(tx, input.templateCode, input.channel, input.language);
  if (!found) return { ok: false, reason: "template_missing" };
  const purpose = found.template.purpose as NotificationPurpose;

  let status: "QUEUED" | "SKIPPED_NO_CONSENT" | "OPTED_OUT" = "QUEUED";
  let lastError: string | null = null;
  if (input.patientId) {
    const decision = resolveConsent(
      prefs ?? (await loadPrefs(tx, input.patientId)),
      input.channel,
      purpose,
      settings.consent,
    );
    if (decision.decision !== "SEND") {
      status = decision.decision;
      lastError = decision.reason;
    }
  }
  let scheduledFor = input.scheduledFor && input.scheduledFor > now ? input.scheduledFor : now;
  const qh = settings.quietHours;
  if (status === "QUEUED" && qh && !qh.exemptPurposes.includes(purpose))
    scheduledFor = nextAllowedSendTime(scheduledFor, qh);

  const data: Prisma.NotificationOutboxCreateManyInput = {
    tenantId,
    branchId: input.branchId ?? null,
    patientId: input.patientId ?? null,
    channel: input.channel,
    purpose,
    templateCode: input.templateCode,
    templateVersionId: found.version.id,
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
  // ON CONFLICT DO NOTHING: a concurrent twin does not abort this transaction; re-read the winner.
  const { count } = await tx.notificationOutbox.createMany({ data: [data], skipDuplicates: true });
  const row = await tx.notificationOutbox.findUniqueOrThrow({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
  });
  return { ok: true, row, created: count === 1 };
}

/** Enqueues the send job of a QUEUED row (after commit). The job key is per row; the job re-reads everything. */
export function dispatch(
  c: WorkCtx<unknown>,
  row: Pick<NotificationOutbox, "id" | "status" | "scheduledFor">,
) {
  if (row.status !== "QUEUED") return Promise.resolve(null);
  return c.send(
    NOTIFICATION_QUEUES.SEND,
    { outboxId: row.id },
    {
      idempotencyKey: `send:${row.id}:0`,
      startAfter: row.scheduledFor > new Date() ? row.scheduledFor : undefined,
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Patient / branch context shared by the producers
// ---------------------------------------------------------------------------------------------

export interface PatientContact {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  merged: boolean;
}

export async function loadPatientContact(
  tx: Tx,
  patientId: string,
): Promise<PatientContact | null> {
  const p = await tx.patient.findUnique({ where: { id: patientId } });
  if (!p) return null;
  return {
    id: p.id,
    displayName: p.preferredName || p.firstName,
    phone: p.phoneNormalized,
    email: p.emailNormalized,
    merged: p.mergedIntoId !== null,
  };
}

export const addressFor = (c: PatientContact, channel: NotificationChannel) =>
  channel === "EMAIL" ? c.email : c.phone;

export interface BranchContext {
  id: string;
  name: string;
  phone: string;
  timeZone: string;
}
export async function loadBranch(tx: Tx, branchId: string): Promise<BranchContext | null> {
  const b = await tx.branch.findUnique({ where: { id: branchId } });
  return b ? { id: b.id, name: b.name, phone: b.phone ?? "", timeZone: b.timezone } : null;
}

export interface DeliverableInput
  extends Omit<EnqueueInput, "channel" | "toAddress" | "patientId"> {
  patient: PatientContact;
  /** Candidate channels, most preferred first (default: reminderChannelOrder). */
  channels?: NotificationChannel[];
}

/**
 * Picks the first enabled channel that has an address and an active template and whose consent resolves to SEND,
 * and enqueues there. When nobody can be sent to, ONE auditable SKIPPED_NO_CONSENT / OPTED_OUT row is written on the
 * first candidate (so staff can see why nothing went out); when no channel has both an address and a template
 * nothing is written (`reason: "no_channel"`).
 */
export async function enqueueForPatient(
  tx: Tx,
  tenantId: string,
  settings: ResolvedNotificationSettings,
  input: DeliverableInput,
  now = new Date(),
): Promise<EnqueueResult | { ok: false; reason: "no_channel" | "merged_patient" }> {
  const existing = await tx.notificationOutbox.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) return { ok: true, row: existing, created: false };
  if (input.patient.merged) return { ok: false, reason: "merged_patient" };
  const prefs = await loadPrefs(tx, input.patient.id);
  const order = input.channels ?? settings.reminderChannelOrder;
  let fallback: { channel: NotificationChannel; address: string } | null = null;
  for (const channel of order) {
    if (!settings.enabledChannels.includes(channel)) continue;
    const address = addressFor(input.patient, channel);
    if (!address) continue;
    const found = await findTemplateVersion(tx, input.templateCode, channel, input.language);
    if (!found) continue;
    const purpose = found.template.purpose as NotificationPurpose;
    const decision = resolveConsent(prefs, channel, purpose, settings.consent);
    if (decision.decision === "SEND")
      return enqueueOutbox(
        tx,
        tenantId,
        settings,
        { ...input, channel, toAddress: address, patientId: input.patient.id },
        prefs,
        now,
      );
    fallback ??= { channel, address };
  }
  if (!fallback) return { ok: false, reason: "no_channel" };
  return enqueueOutbox(
    tx,
    tenantId,
    settings,
    {
      ...input,
      channel: fallback.channel,
      toAddress: fallback.address,
      patientId: input.patient.id,
    },
    prefs,
    now,
  );
}
