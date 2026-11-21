import { z } from "zod";
import { dateOnly, isoDateTime, optionalText, pageQuery, trimmed, uuid } from "./common";
import { COMM_PURPOSES } from "./patients";

// Notifications: channels, versioned templates, outbox, consent resolution, quiet hours, reminders,
// recall, delivery receipts (PRD 4.7, 6.6). Rules: docs/adr/0004-business-operations-rules.md §9
// (PROPOSED — needs product sign-off). Sends happen in background jobs (pg-boss) with the tenant
// envelope of apps/worker/src/jobs.ts: job payloads carry ids only; the outbox row holds the address.

/** Notification channels of V1 (a subset of M1's `CommChannel`, which also lists VOICE). */
export const NOTIFICATION_CHANNELS = ["WHATSAPP", "EMAIL", "SMS"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NOTIFICATION_PURPOSES = COMM_PURPOSES;
export type NotificationPurpose = (typeof NOTIFICATION_PURPOSES)[number];
export const NOTIFICATION_STATUSES = [
  "QUEUED",
  "SENT",
  "FAILED",
  "SKIPPED_NO_CONSENT",
  "OPTED_OUT",
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];
/** Senders shipped in M3. CONSOLE logs the message (no external account); real providers come later. */
export const NOTIFICATION_PROVIDERS = ["CONSOLE"] as const;
export const DELIVERY_STATUSES = ["queued", "sent", "delivered", "read", "failed"] as const;

export const notificationChannel = z.enum(NOTIFICATION_CHANNELS);
export const notificationPurpose = z.enum(NOTIFICATION_PURPOSES);
export const notificationStatus = z.enum(NOTIFICATION_STATUSES);

/** Stable error codes of the notifications API. */
export const NOTIFICATION_ERROR_CODES = [
  "notification_state",
  "template_not_found",
  "template_placeholder_unknown",
  "template_body_too_long",
  "address_invalid",
  "channel_disabled",
  "webhook_signature_invalid",
] as const;

// ---------------------------------------------------------------------------------------------
// Well-known templates and their placeholders
// ---------------------------------------------------------------------------------------------

/**
 * Template codes the system sends. A tenant authors the text per channel and language; the code, purpose and
 * placeholder set are fixed here. `purpose` decides the consent rule (see `resolveConsent`).
 */
export const SYSTEM_TEMPLATES = {
  APPT_CONFIRMATION: {
    purpose: "TRANSACTIONAL",
    placeholders: [
      "patientName",
      "appointmentDate",
      "appointmentTime",
      "branchName",
      "branchPhone",
      "dentistName",
    ],
  },
  APPT_REMINDER_24H: {
    purpose: "REMINDER",
    placeholders: [
      "patientName",
      "appointmentDate",
      "appointmentTime",
      "branchName",
      "branchPhone",
      "dentistName",
    ],
  },
  APPT_REMINDER_2H: {
    purpose: "REMINDER",
    placeholders: [
      "patientName",
      "appointmentDate",
      "appointmentTime",
      "branchName",
      "branchPhone",
      "dentistName",
    ],
  },
  APPT_CHANGED: {
    purpose: "TRANSACTIONAL",
    placeholders: [
      "patientName",
      "appointmentDate",
      "appointmentTime",
      "branchName",
      "branchPhone",
      "changeSummary",
    ],
  },
  INVOICE_ISSUED: {
    purpose: "TRANSACTIONAL",
    placeholders: [
      "patientName",
      "invoiceNumber",
      "invoiceDate",
      "totalAmount",
      "balanceAmount",
      "dueDate",
      "branchName",
    ],
  },
  PAYMENT_RECEIPT: {
    purpose: "TRANSACTIONAL",
    placeholders: [
      "patientName",
      "receiptNumber",
      "paidAmount",
      "paymentMethod",
      "paymentDate",
      "invoiceNumber",
      "balanceAmount",
      "branchName",
    ],
  },
  REFUND_PROCESSED: {
    purpose: "TRANSACTIONAL",
    placeholders: ["patientName", "refundAmount", "refundDate", "receiptNumber", "branchName"],
  },
  RECALL_REMINDER: {
    purpose: "REMINDER",
    placeholders: ["patientName", "serviceName", "dueDate", "branchName", "branchPhone"],
  },
  PLAN_CONSENT_REQUEST: {
    purpose: "TRANSACTIONAL",
    placeholders: ["patientName", "planTitle", "branchName", "branchPhone", "consentLink"],
  },
  TEST_MESSAGE: { purpose: "TRANSACTIONAL", placeholders: ["patientName", "branchName"] },
} as const satisfies Record<
  string,
  { purpose: NotificationPurpose; placeholders: readonly string[] }
>;
export type SystemTemplateCode = keyof typeof SYSTEM_TEMPLATES;
export const SYSTEM_TEMPLATE_CODES = Object.keys(SYSTEM_TEMPLATES) as SystemTemplateCode[];

/** Body size limits per channel (WhatsApp template body, SMS concatenated, e-mail text). */
export const TEMPLATE_BODY_LIMITS: Readonly<Record<NotificationChannel, number>> = {
  WHATSAPP: 1024,
  SMS: 612,
  EMAIL: 10_000,
};

// ---------------------------------------------------------------------------------------------
// Template rendering (pure)
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const MAX_VALUE_LENGTH = 500;

/** Distinct placeholder names used by a body, in order of first use. */
export function extractPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string))];
}

/** Placeholders of `body` not in `allowed` (empty when `allowed` is undefined: free-form custom codes). */
export function unknownPlaceholders(
  body: string,
  allowed: readonly string[] | undefined,
): string[] {
  if (!allowed) return [];
  return extractPlaceholders(body).filter((p) => !allowed.includes(p));
}

/** Allowed placeholders for a template code (undefined for custom codes). */
export function placeholdersFor(code: string): readonly string[] | undefined {
  return (SYSTEM_TEMPLATES as Record<string, { placeholders: readonly string[] }>)[code]
    ?.placeholders;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from message values
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;
const cleanValue = (v: unknown): string =>
  String(v ?? "")
    .replace(CONTROL_CHARS, " ")
    .trim()
    .slice(0, MAX_VALUE_LENGTH);

/**
 * Replaces `{{name}}` with the values (control characters stripped, 500 chars max, no HTML interpretation).
 * Missing / null values render as empty text and are reported in `missing` so the caller can refuse to send
 * a half-filled message. Pure and deterministic.
 */
export function renderTemplate(
  body: string,
  variables: Readonly<Record<string, unknown>>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = variables[name];
    if (v === undefined || v === null || v === "") {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return cleanValue(v);
  });
  return { text, missing };
}

/** "+919876543210" -> "+91******3210"; "ana@clinic.com" -> "a**@clinic.com". For staff screens and logs. */
export function maskAddress(address: string): string {
  const at = address.indexOf("@");
  if (at > 0) return `${address.slice(0, 1)}${"*".repeat(Math.max(2, at - 1))}${address.slice(at)}`;
  if (address.length <= 7) return "*".repeat(address.length);
  return `${address.slice(0, 3)}${"*".repeat(address.length - 7)}${address.slice(-4)}`;
}

/** Stable key for enqueue de-duplication: parts joined with ":" (max 200 chars). */
export const notificationIdempotencyKey = (...parts: Array<string | number>): string =>
  parts.join(":").slice(0, 200);

// ---------------------------------------------------------------------------------------------
// Consent / opt-out resolution (ADR 0004 §9.3) — pure; the worker re-evaluates at send time
// ---------------------------------------------------------------------------------------------

export interface PreferenceRow {
  channel: string;
  purpose: string;
  optIn: boolean;
}
export interface ConsentKnobs {
  /** Treat a patient with NO preference rows as opted in to transactional messages. */
  implicitTransactional: boolean;
  /** Same for reminders (appointment / recall). */
  implicitReminder: boolean;
}
export type ConsentDecision =
  | { decision: "SEND"; reason: string }
  | { decision: "OPTED_OUT"; reason: string }
  | { decision: "SKIPPED_NO_CONSENT"; reason: string };

/**
 * Whether a message may be sent to a patient on a channel for a purpose. `CommunicationPreference` rows are
 * (patient, channel, purpose) -> optIn. In order:
 *  1. A TRANSACTIONAL row with optIn=false is the patient's channel opt-out: nothing is sent on that channel
 *     for any purpose (-> OPTED_OUT). Transactional messages never bypass it.
 *  2. A row for the message's own purpose decides: optIn=true -> SEND, optIn=false -> OPTED_OUT.
 *  3. No row for the purpose:
 *     - TRANSACTIONAL: SEND only when `implicitTransactional`, else SKIPPED_NO_CONSENT.
 *     - REMINDER: inherits an opted-in TRANSACTIONAL row; else `implicitReminder`, else SKIPPED_NO_CONSENT.
 *     - MARKETING: never implied -> SKIPPED_NO_CONSENT.
 * A MARKETING opt-out never blocks TRANSACTIONAL or REMINDER messages.
 */
export function resolveConsent(
  prefs: readonly PreferenceRow[],
  channel: string,
  purpose: string,
  knobs: ConsentKnobs,
): ConsentDecision {
  const row = (p: string) => prefs.find((r) => r.channel === channel && r.purpose === p);
  const channelRow = row("TRANSACTIONAL");
  if (channelRow && !channelRow.optIn) return { decision: "OPTED_OUT", reason: "channel_opt_out" };
  const own = row(purpose);
  if (own) {
    return own.optIn
      ? { decision: "SEND", reason: "opted_in" }
      : { decision: "OPTED_OUT", reason: `${purpose.toLowerCase()}_opt_out` };
  }
  if (purpose === "REMINDER" && channelRow?.optIn)
    return { decision: "SEND", reason: "channel_opt_in" };
  if (purpose === "TRANSACTIONAL" && knobs.implicitTransactional)
    return { decision: "SEND", reason: "implicit_transactional" };
  if (purpose === "REMINDER" && knobs.implicitReminder)
    return { decision: "SEND", reason: "implicit_reminder" };
  return { decision: "SKIPPED_NO_CONSENT", reason: "no_preference" };
}

// ---------------------------------------------------------------------------------------------
// Quiet hours, reminder schedule, recall, retry (pure)
// ---------------------------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "HH:MM, 24-hour");
export const minutesOfDay = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export interface QuietHours {
  /** Local "HH:MM". The window may wrap midnight (21:00 -> 08:00). */
  start: string;
  end: string;
  timeZone: string;
}

/** Local minutes after midnight of `at` in `timeZone`. */
export function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** True when `at` falls inside the quiet window [start, end) (wrapping past midnight allowed). */
export function isWithinQuietHours(at: Date, qh: QuietHours): boolean {
  const s = minutesOfDay(qh.start);
  const e = minutesOfDay(qh.end);
  if (s === e) return false;
  const now = localMinutes(at, qh.timeZone);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

/** The first instant at or after `at` outside the quiet window (`at` itself when already allowed). */
export function nextAllowedSendTime(at: Date, qh: QuietHours): Date {
  if (!isWithinQuietHours(at, qh)) return at;
  const now = localMinutes(at, qh.timeZone);
  const e = minutesOfDay(qh.end);
  const delta = now < e ? e - now : 1440 - now + e;
  const truncated = at.getTime() - (at.getTime() % 60_000);
  return new Date(truncated + delta * 60_000);
}

/** Appointment reminder offsets (minutes before start): T-24h and T-2h. */
export const DEFAULT_REMINDER_OFFSETS_MINUTES = [1440, 120] as const;

/**
 * When to send reminders for an appointment starting at `startsAt`: one per offset, skipping any whose time
 * is already past `now` (a booking made 3 h ahead gets only the T-2h reminder). Sorted earliest first.
 */
export function reminderSendTimes(
  startsAt: Date,
  offsetsMinutes: readonly number[],
  now: Date,
): Array<{ offsetMinutes: number; sendAt: Date }> {
  return [...new Set(offsetsMinutes)]
    .map((offsetMinutes) => ({
      offsetMinutes,
      sendAt: new Date(startsAt.getTime() - offsetMinutes * 60_000),
    }))
    .filter((r) => r.sendAt.getTime() > now.getTime())
    .sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}

/** Template code of a reminder offset (1440 -> APPT_REMINDER_24H, 120 -> APPT_REMINDER_2H, else null). */
export const reminderTemplateCode = (offsetMinutes: number): SystemTemplateCode | null =>
  offsetMinutes === 1440 ? "APPT_REMINDER_24H" : offsetMinutes === 120 ? "APPT_REMINDER_2H" : null;

/** "YYYY-MM-DD" + days (UTC calendar arithmetic, no DST). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Recall due date: last completed procedure date + the service's interval. */
export const recallDueOn = (lastCompletedOn: string, intervalDays: number) =>
  addDays(lastCompletedOn, intervalDays);

/** Retry policy of the send job: attempts and exponential backoff (30 s, 1 m, 2 m, 4 m ...) capped at 1 h. */
export const NOTIFICATION_MAX_ATTEMPTS = 5;
export function retryDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 3600);
}

// ---------------------------------------------------------------------------------------------
// Settings knobs: Tenant.settings.notifications (ADR 0004 §10)
// ---------------------------------------------------------------------------------------------

export const notificationSettings = z.strictObject({
  /** Channels the clinic uses (default: all three). */
  enabledChannels: z.array(notificationChannel).min(1).optional(),
  /** Reminder channel preference: the first enabled channel the patient consented to and has an address for. */
  reminderChannelOrder: z.array(notificationChannel).min(1).optional(),
  /** Minutes before the appointment (default 1440 and 120). */
  reminderOffsetsMinutes: z.array(z.number().int().min(5).max(10_080)).min(1).max(5).optional(),
  quietHours: z
    .strictObject({
      enabled: z.boolean(),
      start: hhmm,
      end: hhmm,
      timeZone: z.string().min(1).max(64).optional(),
      /** Purposes allowed to ignore quiet hours (default: TRANSACTIONAL). */
      exemptPurposes: z.array(notificationPurpose).optional(),
    })
    .optional(),
  implicitConsent: z
    .strictObject({
      transactional: z.boolean().optional(),
      reminder: z.boolean().optional(),
    })
    .optional(),
  /** Send the recall reminder this many days before the due date. */
  recallLeadDays: z.number().int().min(0).max(90).optional(),
  /** Display name used as the e-mail sender. */
  senderName: optionalText(60),
});
export type NotificationSettings = z.infer<typeof notificationSettings>;

export interface ResolvedNotificationSettings {
  enabledChannels: NotificationChannel[];
  reminderChannelOrder: NotificationChannel[];
  reminderOffsetsMinutes: number[];
  quietHours: (QuietHours & { exemptPurposes: NotificationPurpose[] }) | null;
  consent: ConsentKnobs;
  recallLeadDays: number;
  senderName: string | null;
}

/** Effective notification knobs from raw Tenant.settings JSON (missing / invalid -> defaults). */
export function resolveNotificationSettings(
  rawTenantSettings: unknown,
): ResolvedNotificationSettings {
  const raw =
    rawTenantSettings && typeof rawTenantSettings === "object"
      ? (rawTenantSettings as { notifications?: unknown }).notifications
      : undefined;
  const s = notificationSettings.safeParse(raw ?? {}).data ?? {};
  const qh = s.quietHours;
  return {
    enabledChannels: s.enabledChannels ?? [...NOTIFICATION_CHANNELS],
    reminderChannelOrder: s.reminderChannelOrder ?? ["WHATSAPP", "SMS", "EMAIL"],
    reminderOffsetsMinutes: s.reminderOffsetsMinutes ?? [...DEFAULT_REMINDER_OFFSETS_MINUTES],
    quietHours:
      qh?.enabled === true
        ? {
            start: qh.start,
            end: qh.end,
            timeZone: qh.timeZone ?? "Asia/Kolkata",
            exemptPurposes: qh.exemptPurposes ?? ["TRANSACTIONAL"],
          }
        : null,
    consent: {
      implicitTransactional: s.implicitConsent?.transactional ?? false,
      implicitReminder: s.implicitConsent?.reminder ?? false,
    },
    recallLeadDays: s.recallLeadDays ?? 7,
    senderName: s.senderName ?? null,
  };
}

/** PATCH /notifications/settings (replaces the whole `notifications` section; keys are all optional). */
export const updateNotificationSettingsRequest = notificationSettings;
export type UpdateNotificationSettingsRequest = z.infer<typeof updateNotificationSettingsRequest>;

// ---------------------------------------------------------------------------------------------
// Templates (versioned, append-only text)
// ---------------------------------------------------------------------------------------------

const templateCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "3-64 chars: letters, digits or _");
const language = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/, "Language tag such as en or hi");

/** Creates the template and its version 1. Purpose defaults from `SYSTEM_TEMPLATES` for system codes. */
export const createNotificationTemplateRequest = z.object({
  code: templateCode,
  channel: notificationChannel,
  language: language.default("en"),
  purpose: notificationPurpose.optional(),
  name: trimmed(120),
  subject: optionalText(200),
  body: z.string().trim().min(1).max(10_000),
  providerTemplateRef: z.string().trim().max(200).optional(),
});
export type CreateNotificationTemplateRequest = z.infer<typeof createNotificationTemplateRequest>;
/** Metadata only; text changes publish a new version. No defaults. */
export const updateNotificationTemplateRequest = z.object({
  name: trimmed(120).optional(),
  active: z.boolean().optional(),
});
export type UpdateNotificationTemplateRequest = z.infer<typeof updateNotificationTemplateRequest>;
/** Publishes the next (append-only) version. */
export const publishNotificationTemplateVersionRequest = z.object({
  subject: optionalText(200),
  body: z.string().trim().min(1).max(10_000),
  providerTemplateRef: z.string().trim().max(200).optional(),
});
export type PublishNotificationTemplateVersionRequest = z.infer<
  typeof publishNotificationTemplateVersionRequest
>;
export const listNotificationTemplatesQuery = pageQuery.extend({
  channel: notificationChannel.optional(),
  language: language.optional(),
  code: z.string().trim().max(64).optional(),
  active: z.stringbool().optional(),
});
export type ListNotificationTemplatesQuery = z.infer<typeof listNotificationTemplatesQuery>;
export const notificationTemplateVersionResponse = z.object({
  id: uuid,
  templateId: uuid,
  version: z.number().int(),
  subject: z.string().nullable(),
  body: z.string(),
  placeholders: z.array(z.string()),
  providerTemplateRef: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
});
export type NotificationTemplateVersionResponse = z.infer<
  typeof notificationTemplateVersionResponse
>;
export const notificationTemplateResponse = z.object({
  id: uuid,
  code: z.string(),
  channel: notificationChannel,
  language: z.string(),
  purpose: notificationPurpose,
  name: z.string(),
  active: z.boolean(),
  currentVersion: z.number().int(),
  /** Allowed placeholders for system codes (null for custom codes). */
  allowedPlaceholders: z.array(z.string()).nullable(),
  latest: notificationTemplateVersionResponse.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type NotificationTemplateResponse = z.infer<typeof notificationTemplateResponse>;
export const previewNotificationTemplateRequest = z.object({
  body: z.string().trim().min(1).max(10_000),
  variables: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
export type PreviewNotificationTemplateRequest = z.infer<typeof previewNotificationTemplateRequest>;
export const previewNotificationTemplateResponse = z.object({
  text: z.string(),
  missing: z.array(z.string()),
  unknown: z.array(z.string()),
});
export type PreviewNotificationTemplateResponse = z.infer<
  typeof previewNotificationTemplateResponse
>;

/** Validation shared by create / publish: placeholder names and channel length. Returns issues (empty = ok). */
export function validateTemplateBody(
  code: string,
  channel: NotificationChannel,
  body: string,
): Array<"template_placeholder_unknown" | "template_body_too_long"> {
  const issues: Array<"template_placeholder_unknown" | "template_body_too_long"> = [];
  if (unknownPlaceholders(body, placeholdersFor(code)).length > 0)
    issues.push("template_placeholder_unknown");
  if (body.length > TEMPLATE_BODY_LIMITS[channel]) issues.push("template_body_too_long");
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Outbox, test sends, preference checks
// ---------------------------------------------------------------------------------------------

export const listOutboxQuery = pageQuery.extend({
  patientId: uuid.optional(),
  branchId: uuid.optional(),
  status: notificationStatus.optional(),
  channel: notificationChannel.optional(),
  templateCode: z.string().trim().max(64).optional(),
  refType: z.string().trim().max(60).optional(),
  refId: z.string().trim().max(100).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListOutboxQuery = z.infer<typeof listOutboxQuery>;
export const outboxResponse = z.object({
  id: uuid,
  branchId: uuid.nullable(),
  patientId: uuid.nullable(),
  channel: notificationChannel,
  purpose: notificationPurpose,
  templateCode: z.string(),
  templateVersionId: uuid,
  /** Masked (`maskAddress`); the full address is never returned to the browser. */
  toAddressMasked: z.string(),
  status: notificationStatus,
  attempts: z.number().int(),
  scheduledFor: isoDateTime,
  nextAttemptAt: isoDateTime.nullable(),
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
  deliveredAt: isoDateTime.nullable(),
  lastError: z.string().nullable(),
  source: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  actorId: z.string(),
  createdAt: isoDateTime,
  sentAt: isoDateTime.nullable(),
});
export type OutboxResponse = z.infer<typeof outboxResponse>;

/**
 * Sends a template to an arbitrary address through the real pipeline (outbox + job), without a patient.
 * Permission: `comms:templates` ONLY (org level; OWNER). Never `comms:send` — that is held by reception and would turn
 * `toAddress` into an open message relay once a real provider is wired in (ADR 0004 §9.1, §12).
 */
export const sendTestNotificationRequest = z.object({
  channel: notificationChannel,
  templateCode: templateCode.default("TEST_MESSAGE"),
  language: language.default("en"),
  /** Phone (E.164 normalised server-side) for WHATSAPP / SMS, e-mail for EMAIL. */
  toAddress: z.string().trim().min(5).max(254),
  variables: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  branchId: uuid.optional(),
});
export type SendTestNotificationRequest = z.infer<typeof sendTestNotificationRequest>;
export const sendTestNotificationResponse = z.object({
  outboxId: uuid,
  status: notificationStatus,
});
export type SendTestNotificationResponse = z.infer<typeof sendTestNotificationResponse>;

export const checkPreferencesQuery = z.object({
  patientId: uuid,
  channel: notificationChannel,
  purpose: notificationPurpose,
});
export type CheckPreferencesQuery = z.infer<typeof checkPreferencesQuery>;
export const preferenceCheckResponse = z.object({
  patientId: uuid,
  channel: notificationChannel,
  purpose: notificationPurpose,
  decision: z.enum(["SEND", "OPTED_OUT", "SKIPPED_NO_CONSENT"]),
  reason: z.string(),
  /** Whether the patient has a usable address for the channel (phone / e-mail on file). */
  hasAddress: z.boolean(),
});
export type PreferenceCheckResponse = z.infer<typeof preferenceCheckResponse>;

// ---------------------------------------------------------------------------------------------
// Recall settings
// ---------------------------------------------------------------------------------------------

export const upsertRecallSettingRequest = z.object({
  serviceId: uuid,
  /** Days after a completed procedure of this service (e.g. 180 for scaling). */
  intervalDays: z.number().int().min(1).max(3650),
  active: z.boolean().default(true),
});
export type UpsertRecallSettingRequest = z.infer<typeof upsertRecallSettingRequest>;
export const listRecallSettingsQuery = pageQuery.extend({
  active: z.stringbool().optional(),
});
export type ListRecallSettingsQuery = z.infer<typeof listRecallSettingsQuery>;
export const recallSettingResponse = z.object({
  id: uuid,
  serviceId: uuid,
  serviceName: z.string().optional(),
  intervalDays: z.number().int(),
  active: z.boolean(),
  updatedBy: z.string(),
  updatedAt: isoDateTime,
});
export type RecallSettingResponse = z.infer<typeof recallSettingResponse>;

// ---------------------------------------------------------------------------------------------
// Delivery receipts (provider webhook) and job payloads
// ---------------------------------------------------------------------------------------------

/**
 * POST /webhooks/notifications/:provider/:tenantId — provider delivery receipt. Same signature scheme as the
 * payment webhook (`parseWebhookSignatureHeader`, header x-dentalos-signature, `GATEWAY_WEBHOOK_TOLERANCE_SECONDS`).
 * Processing is idempotent per `eventId` and only ever moves `deliveryStatus` / `deliveredAt` / a FAILED
 * transition — never the message content.
 */
export const deliveryReceiptPayload = z.object({
  eventId: z.string().trim().min(1).max(200),
  providerMessageId: z.string().trim().min(1).max(200),
  status: z.enum(DELIVERY_STATUSES),
  errorCode: z.string().trim().max(100).optional(),
  occurredAt: isoDateTime,
});
export type DeliveryReceiptPayload = z.infer<typeof deliveryReceiptPayload>;

/**
 * Queue names and payloads (ids only — the pg-boss schema is not tenant-RLS data). Producers (billing,
 * scheduling, plans) enqueue with `enqueue()` from apps/worker's jobs.ts shape: `{ tenantId, actorId, source,
 * idempotencyKey, data }`; handlers live in apps/worker/src/handlers and run inside `withTenant`.
 */
export const NOTIFICATION_QUEUES = {
  SEND: "notifications.send",
  APPOINTMENT_REMINDER: "notifications.appointment-reminder",
  APPOINTMENT_CHANGED: "notifications.appointment-changed",
  INVOICE_ISSUED: "notifications.invoice-issued",
  PAYMENT_RECEIPT: "notifications.payment-receipt",
  REFUND_PROCESSED: "notifications.refund-processed",
  PLAN_CONSENT_REQUEST: "notifications.plan-consent-request",
  RECALL_SWEEP: "notifications.recall-sweep",
} as const;
export type NotificationQueue = (typeof NOTIFICATION_QUEUES)[keyof typeof NOTIFICATION_QUEUES];

export const sendNotificationJob = z.object({ outboxId: uuid });
export const appointmentReminderJob = z.object({
  appointmentId: uuid,
  offsetMinutes: z.number().int().min(5).max(10_080),
});
export const appointmentChangedJob = z.object({
  appointmentId: uuid,
  change: z.enum(["BOOKED", "CONFIRMED", "CANCELLED", "RESCHEDULED"]),
});
export const invoiceIssuedJob = z.object({ invoiceId: uuid });
export const paymentReceiptJob = z.object({ paymentId: uuid });
export const refundProcessedJob = z.object({ refundId: uuid });
export const planConsentRequestJob = z.object({
  planId: uuid,
  planVersion: z.number().int().min(1),
});
/** Daily sweep: `asOf` is "YYYY-MM-DD" in the tenant's time zone. */
export const recallSweepJob = z.object({ asOf: dateOnly.optional() });
export type SendNotificationJob = z.infer<typeof sendNotificationJob>;
export type AppointmentReminderJob = z.infer<typeof appointmentReminderJob>;
