import { z } from "zod";
import { idempotencyKey, paymentMethod, paymentStatus, positivePaise } from "./billing";
import { invoiceStatus } from "./billing";
import {
  dateOnly,
  email,
  isoDateTime,
  normalizeEmail,
  normalizePhoneIN,
  optionalText,
  pageQuery,
  phone,
  timeZone,
  trimmed,
  uuid,
} from "./common";
import { documentCategory } from "./documents";
import { PLAN_ITEM_DECISIONS, planItemStatus, treatmentPlanStatus } from "./plans";
import { APPOINTMENT_TYPES, appointmentStatus, appointmentType } from "./scheduling";

// Patient portal (PRD 3.5, 4.10, 7.3): identity, auth, profile, appointments, plans, billing, documents,
// consents, notifications, and the staff-side administration. Rules: docs/adr/0005-portal-analytics-ai-rules.md
// (PROPOSED — needs product sign-off). Frontend-safe: no Node imports (hashing uses Web Crypto).
//
// SECURITY INVARIANT: no portal request DTO carries a `patientId`, `accountId` (except the picker) or `tenantId`
// (except the unauthenticated login start). Everything is scoped by the `PatientPrincipal` resolved from the
// verified portal session (apps/api/src/auth/portal.guard.ts), never from client input.

// ---------------------------------------------------------------------------------------------
// Constants (ADR 0005 §1) — defaults, all proposed
// ---------------------------------------------------------------------------------------------

export const PORTAL_ACCOUNT_STATUSES = ["INVITED", "ACTIVE", "SUSPENDED"] as const;
export type PortalAccountStatus = (typeof PORTAL_ACCOUNT_STATUSES)[number];
export const portalAccountStatus = z.enum(PORTAL_ACCOUNT_STATUSES);

/** Mirrors the DB enum `PortalOtpPurpose`. */
export const PORTAL_OTP_PURPOSES = ["LOGIN", "ACTIVATE", "STEP_UP", "CONTACT_VERIFY"] as const;
export type PortalOtpPurpose = (typeof PORTAL_OTP_PURPOSES)[number];
/** Channels an OTP may be delivered on (through the notifications outbox, purpose TRANSACTIONAL). */
export const PORTAL_OTP_CHANNELS = ["SMS", "EMAIL", "WHATSAPP"] as const;
export type PortalOtpChannel = (typeof PORTAL_OTP_CHANNELS)[number];

export const PORTAL_OTP_LENGTH = 6;
export const PORTAL_OTP_TTL_MINUTES = 10;
export const PORTAL_OTP_MAX_ATTEMPTS = 5;
/** Access token lifetime (HS256 dev signer; production: Cognito patient pool, ADR 0005 §1.3). */
export const PORTAL_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Sliding refresh-token lifetime; each refresh rotates the token (`PortalSession` successor row). */
export const PORTAL_REFRESH_TTL_DAYS = 30;
/** Hard cap on a session family from first login (re-login with OTP afterwards). */
export const PORTAL_SESSION_ABSOLUTE_DAYS = 90;
/** Step-up validity default; the DB refuses a signature whose OTP is older than 15 minutes. */
export const PORTAL_STEP_UP_WINDOW_MINUTES = 10;
export const PORTAL_STEP_UP_DB_MAX_MINUTES = 15;
/** Picker selection token lifetime (several accounts match one login destination). */
export const PORTAL_SELECTION_TTL_SECONDS = 5 * 60;
/** JWT `aud` of portal access tokens. Staff tokens never carry it and the staff verifier never accepts it. */
export const PORTAL_TOKEN_AUDIENCE = "dentalos-portal";
export const PORTAL_TOKEN_ISSUER = "dentalos-portal-api";

/** OTP request throttles, counted from `PortalOtp` rows (works across API instances). */
export const PORTAL_OTP_RATE_LIMITS = {
  perDestination: [
    { windowSeconds: 15 * 60, max: 3 },
    { windowSeconds: 24 * 60 * 60, max: 10 },
  ],
  perIp: [{ windowSeconds: 60 * 60, max: 20 }],
  /** Minimum gap between two codes to the same destination. */
  resendCooldownSeconds: 60,
} as const;

/** Stable error codes of the portal API. */
export const PORTAL_ERROR_CODES = [
  "otp_invalid",
  "otp_expired",
  "otp_locked",
  "otp_rate_limited",
  "portal_disabled",
  "portal_account_inactive",
  "session_revoked",
  "step_up_required",
  "booking_too_soon",
  "booking_too_far",
  "booking_type_not_bookable",
  "booking_service_not_bookable",
  "booking_limit_reached",
  "reschedule_limit_reached",
  "change_too_late",
  "appointment_not_changeable",
  "slot_unavailable",
  "consent_text_changed",
  "plan_version_stale",
  "document_not_available",
  "payment_not_allowed",
] as const;
export type PortalErrorCode = (typeof PORTAL_ERROR_CODES)[number];

// ---------------------------------------------------------------------------------------------
// Pure crypto helpers (Web Crypto: Node >= 19, Bun and browsers). Async because `subtle` is.
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Lower-case hex HMAC-SHA256. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Lower-case hex SHA-256. */
export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(message)));
}

/**
 * Uniform random 6-digit code ("000000"–"999999") by rejection sampling over a 32-bit draw (no modulo bias).
 * `random32` is injectable for deterministic use; the default is the platform CSPRNG.
 */
export function generateOtpCode(
  random32: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0] as number,
  length = PORTAL_OTP_LENGTH,
): string {
  const space = 10 ** length;
  const limit = Math.floor(0x1_0000_0000 / space) * space;
  for (;;) {
    const n = random32();
    if (n < limit) return String(n % space).padStart(length, "0");
  }
}

/** HMAC of an OTP code, bound to its row id so equal codes never produce equal hashes. */
export const hashOtpCode = (code: string, otpId: string, pepper: string) =>
  hmacSha256Hex(pepper, `otp:${otpId}:${code}`);

/** HMAC of a normalised login destination ("+919876543210" | "a@b.com"): the stored form and the rate-limit key. */
export const hashDestination = (normalizedDestination: string, pepper: string) =>
  hmacSha256Hex(pepper, `dest:${normalizedDestination}`);

/** HMAC of a client identifier (IP, user agent) so raw values never reach the database or the logs. */
export const hashClientValue = (value: string, pepper: string) =>
  hmacSha256Hex(pepper, `client:${value}`);

/** Constant-time equality of two equal-length hex strings (false when lengths differ). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * Opaque refresh token: `<tenantId>.<43 url-safe chars>`. The tenant prefix lets the unauthenticated refresh call open
 * the right RLS context; the secret half is 256 bits. Only `sha256Hex(token)` is stored (`PortalSession.refreshTokenHash`).
 */
export function generateRefreshToken(tenantId: string): string {
  return `${tenantId}.${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}
const REFRESH_TOKEN_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/i;
export function parseRefreshToken(token: string): { tenantId: string } | null {
  const m = REFRESH_TOKEN_RE.exec(token);
  return m ? { tenantId: (m[1] as string).toLowerCase() } : null;
}
export const refreshToken = z
  .string()
  .max(120)
  .refine((t) => parseRefreshToken(t) !== null, "Malformed refresh token");

// ---------------------------------------------------------------------------------------------
// Login destination (phone / e-mail)
// ---------------------------------------------------------------------------------------------

export type LoginDestination = { kind: "phone" | "email"; value: string };

/** "98765 43210" -> { phone, "+919876543210" }; "A@B.com" -> { email, "a@b.com" }; anything else -> null. */
export function normalizeLoginDestination(raw: string | null | undefined): LoginDestination | null {
  const s = raw?.trim();
  if (!s) return null;
  if (s.includes("@")) {
    const e = normalizeEmail(s);
    return e && z.email().safeParse(e).success ? { kind: "email", value: e } : null;
  }
  const p = normalizePhoneIN(s);
  return p ? { kind: "phone", value: p } : null;
}

/** Default OTP channel for a destination kind (a phone gets SMS; WhatsApp is an explicit choice). */
export const defaultOtpChannel = (kind: LoginDestination["kind"]): PortalOtpChannel =>
  kind === "email" ? "EMAIL" : "SMS";

/** "+919876543210" -> "+91******3210"; "asha@example.com" -> "a***@example.com". For responses and logs only. */
export function maskDestination(normalized: string): string {
  const at = normalized.indexOf("@");
  if (at > 0) return `${normalized.slice(0, 1)}***${normalized.slice(at)}`;
  const tail = normalized.slice(-4);
  const head = normalized.slice(0, Math.min(3, normalized.length - 4));
  return `${head}${"*".repeat(Math.max(normalized.length - head.length - 4, 0))}${tail}`;
}

/** Normalised login destination; rejects anything that is neither a phone nor an e-mail. */
export const loginDestination = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .transform((v, ctx) => {
    const d = normalizeLoginDestination(v);
    if (!d) {
      ctx.addIssue({ code: "custom", message: "Enter a valid mobile number or e-mail" });
      return z.NEVER;
    }
    return d.value;
  });

// ---------------------------------------------------------------------------------------------
// OTP evaluators (pure; the DB trigger `portal_otp_guard` is the final authority under races)
// ---------------------------------------------------------------------------------------------

export type OtpAttemptResult =
  | { ok: true }
  | {
      ok: false;
      reason: "expired" | "consumed" | "locked" | "mismatch";
      /** Attempts left AFTER this failed one (0 when locked). */
      attemptsLeft: number;
    };

/**
 * Decides one verification try. `attempts` is the count BEFORE this try. Order: consumed, expired, locked, then the
 * code itself; a mismatch consumes an attempt. The caller increments `attempts` in the same transaction.
 */
export function evaluateOtpAttempt(input: {
  now: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  maxAttempts: number;
  codeMatches: boolean;
}): OtpAttemptResult {
  const left = Math.max(input.maxAttempts - input.attempts - 1, 0);
  if (input.consumedAt) return { ok: false, reason: "consumed", attemptsLeft: 0 };
  if (input.now.getTime() > input.expiresAt.getTime())
    return { ok: false, reason: "expired", attemptsLeft: 0 };
  if (input.attempts >= input.maxAttempts) return { ok: false, reason: "locked", attemptsLeft: 0 };
  if (!input.codeMatches) return { ok: false, reason: "mismatch", attemptsLeft: left };
  return { ok: true };
}

export type OtpRateLimitResult =
  | { allowed: true }
  | { allowed: false; scope: "destination" | "ip" | "cooldown"; retryAfterSeconds: number };

type Window = { windowSeconds: number; max: number };
function overLimit(times: readonly Date[], now: Date, w: Window): number | null {
  const since = now.getTime() - w.windowSeconds * 1000;
  const inWindow = times.map((t) => t.getTime()).filter((t) => t > since);
  if (inWindow.length < w.max) return null;
  // Allowed again when the oldest counted request leaves the window (the (max)th most recent one).
  const sorted = inWindow.sort((a, b) => b - a);
  const blocking = sorted[w.max - 1] as number;
  return Math.max(Math.ceil((blocking + w.windowSeconds * 1000 - now.getTime()) / 1000), 1);
}

/** Throttle for a new OTP request given the creation times of the recent `PortalOtp` rows of the destination / IP. */
export function evaluateOtpRateLimit(input: {
  now: Date;
  destinationRequests: readonly Date[];
  ipRequests: readonly Date[];
  limits?: typeof PORTAL_OTP_RATE_LIMITS;
}): OtpRateLimitResult {
  const limits = input.limits ?? PORTAL_OTP_RATE_LIMITS;
  const last = input.destinationRequests.reduce((m, t) => Math.max(m, t.getTime()), 0);
  const gap = limits.resendCooldownSeconds * 1000 - (input.now.getTime() - last);
  if (last > 0 && gap > 0)
    return { allowed: false, scope: "cooldown", retryAfterSeconds: Math.ceil(gap / 1000) };
  for (const w of limits.perDestination) {
    const r = overLimit(input.destinationRequests, input.now, w);
    if (r !== null) return { allowed: false, scope: "destination", retryAfterSeconds: r };
  }
  for (const w of limits.perIp) {
    const r = overLimit(input.ipRequests, input.now, w);
    if (r !== null) return { allowed: false, scope: "ip", retryAfterSeconds: r };
  }
  return { allowed: true };
}

/** True while the session's last step-up OTP is within the window (capped at the DB bound of 15 minutes). */
export function isStepUpFresh(
  stepUpAt: Date | null,
  now: Date,
  windowMinutes = PORTAL_STEP_UP_WINDOW_MINUTES,
): boolean {
  if (!stepUpAt) return false;
  const w = Math.min(windowMinutes, PORTAL_STEP_UP_DB_MAX_MINUTES) * 60_000;
  const age = now.getTime() - stepUpAt.getTime();
  return age >= 0 && age <= w;
}

// ---------------------------------------------------------------------------------------------
// Portal settings (Tenant.settings.portal) and booking-rule evaluators
// ---------------------------------------------------------------------------------------------

export const PORTAL_DEFAULT_BOOKABLE_TYPES = ["CONSULTATION", "CHECKUP", "FOLLOW_UP"] as const;

/** Stored in `Tenant.settings.portal`. Every key optional (no defaults here: see `resolvePortalSettings`). */
export const portalSettings = z.strictObject({
  /** Master switch: invites, login and booking all refuse while false (default false). */
  enabled: z.boolean().optional(),
  /** Booking / rescheduling / cancelling needs at least this many hours before the start (default 24). */
  minNoticeHours: z.number().int().min(0).max(720).optional(),
  /** How far ahead a patient may book (default 90 days). */
  maxAdvanceDays: z.number().int().min(1).max(365).optional(),
  /** Reschedules per appointment chain (default 2). 0 = patients can only cancel and rebook. */
  maxReschedules: z.number().int().min(0).max(10).optional(),
  /** Future appointments one patient may hold booked through the portal at a time (default 3). */
  maxActiveBookings: z.number().int().min(1).max(20).optional(),
  /** Appointment types offered in the portal (default CONSULTATION, CHECKUP, FOLLOW_UP). */
  bookableAppointmentTypes: z
    .array(appointmentType)
    .min(1)
    .max(APPOINTMENT_TYPES.length)
    .optional(),
  /** Slot length when no service is chosen (default 30). */
  defaultDurationMin: z.number().int().min(5).max(240).optional(),
  /** Branches offered for portal booking (default: every active branch). */
  bookableBranchIds: z.array(uuid).max(200).optional(),
  /** May patients cancel in the portal (default true). */
  allowPatientCancel: z.boolean().optional(),
  /** Minutes a step-up OTP stays valid for consent / plan decisions (default 10, max 15). */
  stepUpWindowMinutes: z.number().int().min(1).max(PORTAL_STEP_UP_DB_MAX_MINUTES).optional(),
  /** Require a signed treatment-plan consent before ACCEPTED decisions count (default true). */
  requirePlanConsent: z.boolean().optional(),
});
export type PortalSettings = z.infer<typeof portalSettings>;

export type ResolvedPortalSettings = Required<Omit<PortalSettings, "bookableBranchIds">> & {
  bookableBranchIds: string[] | null;
};

export const DEFAULT_PORTAL_SETTINGS: ResolvedPortalSettings = {
  enabled: false,
  minNoticeHours: 24,
  maxAdvanceDays: 90,
  maxReschedules: 2,
  maxActiveBookings: 3,
  bookableAppointmentTypes: [...PORTAL_DEFAULT_BOOKABLE_TYPES],
  defaultDurationMin: 30,
  bookableBranchIds: null,
  allowPatientCancel: true,
  stepUpWindowMinutes: PORTAL_STEP_UP_WINDOW_MINUTES,
  requirePlanConsent: true,
};

/** Effective knobs from the raw `Tenant.settings` JSON; anything missing or invalid falls back to the default. */
export function resolvePortalSettings(rawTenantSettings: unknown): ResolvedPortalSettings {
  const raw =
    rawTenantSettings && typeof rawTenantSettings === "object"
      ? (rawTenantSettings as { portal?: unknown }).portal
      : undefined;
  const parsed = portalSettings.safeParse(raw ?? {});
  if (!parsed.success) return { ...DEFAULT_PORTAL_SETTINGS };
  const v = parsed.data;
  return {
    enabled: v.enabled ?? DEFAULT_PORTAL_SETTINGS.enabled,
    minNoticeHours: v.minNoticeHours ?? DEFAULT_PORTAL_SETTINGS.minNoticeHours,
    maxAdvanceDays: v.maxAdvanceDays ?? DEFAULT_PORTAL_SETTINGS.maxAdvanceDays,
    maxReschedules: v.maxReschedules ?? DEFAULT_PORTAL_SETTINGS.maxReschedules,
    maxActiveBookings: v.maxActiveBookings ?? DEFAULT_PORTAL_SETTINGS.maxActiveBookings,
    bookableAppointmentTypes:
      v.bookableAppointmentTypes ?? DEFAULT_PORTAL_SETTINGS.bookableAppointmentTypes,
    defaultDurationMin: v.defaultDurationMin ?? DEFAULT_PORTAL_SETTINGS.defaultDurationMin,
    bookableBranchIds: v.bookableBranchIds ?? null,
    allowPatientCancel: v.allowPatientCancel ?? DEFAULT_PORTAL_SETTINGS.allowPatientCancel,
    stepUpWindowMinutes: v.stepUpWindowMinutes ?? DEFAULT_PORTAL_SETTINGS.stepUpWindowMinutes,
    requirePlanConsent: v.requirePlanConsent ?? DEFAULT_PORTAL_SETTINGS.requirePlanConsent,
  };
}

export const PORTAL_BOOKING_VIOLATIONS = [
  "in_past",
  "too_soon",
  "too_far",
  "type_not_bookable",
  "service_not_bookable",
  "too_many_active",
  "reschedule_limit",
  "change_too_late",
  "cancel_disabled",
  "status_not_changeable",
] as const;
export type PortalBookingViolation = (typeof PORTAL_BOOKING_VIOLATIONS)[number];

/** Statuses a patient may still change on their own (once checked in, the clinic owns the visit). */
export const PORTAL_CHANGEABLE_STATUSES = ["BOOKED", "CONFIRMED"] as const;
export const isPortalChangeableStatus = (status: string): boolean =>
  (PORTAL_CHANGEABLE_STATUSES as readonly string[]).includes(status);

const hoursBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 3_600_000;

/**
 * New portal booking against the clinic rules. Returns EVERY violated rule (empty = allowed). Working hours,
 * dentist/chair double-booking and the branch's own scheduling knobs are enforced by the scheduling service and the DB
 * exclusion constraints, not here. `serviceBookable` is `undefined` when no service was chosen.
 */
export function evaluatePortalBooking(input: {
  now: Date;
  startsAt: Date;
  rules: Pick<
    ResolvedPortalSettings,
    "minNoticeHours" | "maxAdvanceDays" | "maxActiveBookings" | "bookableAppointmentTypes"
  >;
  appointmentType: string;
  serviceBookable?: boolean;
  /** Future, still-open appointments the patient already holds. */
  activeFutureBookings: number;
}): PortalBookingViolation[] {
  const v: PortalBookingViolation[] = [];
  const lead = hoursBetween(input.now, input.startsAt);
  if (lead <= 0) v.push("in_past");
  else if (lead < input.rules.minNoticeHours) v.push("too_soon");
  if (lead > input.rules.maxAdvanceDays * 24) v.push("too_far");
  if (!input.rules.bookableAppointmentTypes.includes(input.appointmentType as never))
    v.push("type_not_bookable");
  if (input.serviceBookable === false) v.push("service_not_bookable");
  if (input.activeFutureBookings >= input.rules.maxActiveBookings) v.push("too_many_active");
  return v;
}

/**
 * Reschedule / cancel of an EXISTING appointment. `currentStartsAt` is the appointment being changed (the notice is
 * counted to it, so late changes are refused); `newStartsAt` is checked like a booking for reschedules.
 * `reschedulesUsed` = length of the `rescheduledFromId` chain behind the appointment.
 */
export function evaluatePortalChange(input: {
  now: Date;
  action: "reschedule" | "cancel";
  status: string;
  currentStartsAt: Date;
  newStartsAt?: Date;
  reschedulesUsed: number;
  rules: Pick<
    ResolvedPortalSettings,
    "minNoticeHours" | "maxAdvanceDays" | "maxReschedules" | "allowPatientCancel"
  >;
}): PortalBookingViolation[] {
  const v: PortalBookingViolation[] = [];
  if (!isPortalChangeableStatus(input.status)) v.push("status_not_changeable");
  if (hoursBetween(input.now, input.currentStartsAt) < input.rules.minNoticeHours)
    v.push("change_too_late");
  if (input.action === "cancel") {
    if (!input.rules.allowPatientCancel) v.push("cancel_disabled");
    return v;
  }
  if (input.reschedulesUsed >= input.rules.maxReschedules) v.push("reschedule_limit");
  if (input.newStartsAt) {
    const lead = hoursBetween(input.now, input.newStartsAt);
    if (lead <= 0) v.push("in_past");
    else if (lead < input.rules.minNoticeHours) v.push("too_soon");
    if (lead > input.rules.maxAdvanceDays * 24) v.push("too_far");
  }
  return v;
}

/** Maps a violated rule to the stable API error code. */
export const PORTAL_VIOLATION_ERROR: Readonly<Record<PortalBookingViolation, PortalErrorCode>> = {
  in_past: "booking_too_soon",
  too_soon: "booking_too_soon",
  too_far: "booking_too_far",
  type_not_bookable: "booking_type_not_bookable",
  service_not_bookable: "booking_service_not_bookable",
  too_many_active: "booking_limit_reached",
  reschedule_limit: "reschedule_limit_reached",
  change_too_late: "change_too_late",
  cancel_disabled: "change_too_late",
  status_not_changeable: "appointment_not_changeable",
};

// ---------------------------------------------------------------------------------------------
// Notification content for the portal (templates seeded when the portal is enabled)
// ---------------------------------------------------------------------------------------------

/** Default bodies for the two portal system templates (a tenant may edit them as new versions). */
export const PORTAL_DEFAULT_TEMPLATE_BODIES = {
  PORTAL_OTP: {
    SMS: "{{code}} is your {{clinicName}} patient portal code. It expires in {{validityMinutes}} minutes. Do not share it.",
    WHATSAPP:
      "{{code}} is your {{clinicName}} patient portal code. It expires in {{validityMinutes}} minutes. Do not share it with anyone.",
    EMAIL:
      "Your {{clinicName}} patient portal code is {{code}}. It expires in {{validityMinutes}} minutes. If you did not ask for it, ignore this message. Never share this code.",
  },
  PORTAL_INVITE: {
    SMS: "Hi {{patientName}}, {{clinicName}} invites you to the patient portal: {{portalLink}}",
    WHATSAPP:
      "Hi {{patientName}}, {{clinicName}} has set up your patient portal. Sign in with your mobile number: {{portalLink}}",
    EMAIL:
      "Hi {{patientName}},\n\n{{clinicName}} has set up your patient portal. View appointments, treatment plans and invoices, and pay online. Sign in with a one-time code sent to this address or your mobile: {{portalLink}}",
  },
} as const satisfies Record<string, Record<"SMS" | "WHATSAPP" | "EMAIL", string>>;

/** Patient-facing title of a notification row by template code. */
export const PORTAL_NOTIFICATION_TITLES: Readonly<Record<string, string>> = {
  APPT_CONFIRMATION: "Appointment confirmed",
  APPT_REMINDER_24H: "Appointment reminder",
  APPT_REMINDER_2H: "Appointment reminder",
  APPT_CHANGED: "Appointment updated",
  INVOICE_ISSUED: "New invoice",
  PAYMENT_RECEIPT: "Payment received",
  REFUND_PROCESSED: "Refund processed",
  RECALL_REMINDER: "Check-up due",
  PLAN_CONSENT_REQUEST: "Treatment plan awaiting your review",
  PORTAL_INVITE: "Portal invitation",
};
/** Codes the portal never lists (the OTP is a credential, not a message to keep). */
export const PORTAL_HIDDEN_NOTIFICATION_CODES = ["PORTAL_OTP", "TEST_MESSAGE"] as const;
export const portalNotificationTitle = (templateCode: string): string =>
  PORTAL_NOTIFICATION_TITLES[templateCode] ?? "Message from your clinic";

// ---------------------------------------------------------------------------------------------
// Portal auth DTOs (public routes: `@Public()` + rate limits; everything else needs the portal guard)
// ---------------------------------------------------------------------------------------------

/**
 * POST /portal/auth/otp — start login (or activation of an INVITED account). `tenantId` is the clinic being signed in
 * to (public identifier in the portal URL / PORTAL_TENANT_ID). The answer is the same whether or not an account matches
 * (no account enumeration); `challengeId` of a non-match is random.
 */
export const portalOtpRequest = z.object({
  tenantId: uuid,
  destination: loginDestination,
  channel: z.enum(PORTAL_OTP_CHANNELS).optional(),
});
export type PortalOtpRequest = z.infer<typeof portalOtpRequest>;
export const portalOtpResponse = z.object({
  challengeId: uuid,
  maskedDestination: z.string(),
  channel: z.enum(PORTAL_OTP_CHANNELS),
  expiresInSeconds: z.number().int(),
  resendAfterSeconds: z.number().int(),
});
export type PortalOtpResponse = z.infer<typeof portalOtpResponse>;

export const portalOtpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code");

/** POST /portal/auth/verify */
export const portalVerifyOtpRequest = z.object({
  tenantId: uuid,
  challengeId: uuid,
  code: portalOtpCode,
  /** Free-text device label shown in "your sessions" (≤ 80 chars, no PII needed). */
  deviceLabel: trimmed(80).optional(),
});
export type PortalVerifyOtpRequest = z.infer<typeof portalVerifyOtpRequest>;

export const portalAccountOption = z.object({
  /** Opaque: valid only with the `selectionToken` it came with. */
  accountId: uuid,
  displayName: z.string(),
  /** Under 18: guardian access is out of scope, the portal still shows a minor notice. */
  minor: z.boolean(),
});
export type PortalAccountOption = z.infer<typeof portalAccountOption>;

export const portalTokens = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: isoDateTime,
  refreshToken: z.string(),
  refreshTokenExpiresAt: isoDateTime,
});
export type PortalTokens = z.infer<typeof portalTokens>;

/** POST /portal/auth/select — finish login after the picker. */
export const portalSelectAccountRequest = z.object({
  selectionToken: z.string().min(20).max(2000),
  accountId: uuid,
  deviceLabel: trimmed(80).optional(),
});
export type PortalSelectAccountRequest = z.infer<typeof portalSelectAccountRequest>;

/** POST /portal/auth/refresh — rotates the refresh token (the old one is revoked; replaying it revokes the family). */
export const portalRefreshRequest = z.object({ refreshToken });
export type PortalRefreshRequest = z.infer<typeof portalRefreshRequest>;

/** POST /portal/auth/logout — revokes the current session (or every session of the account). */
export const portalLogoutRequest = z.object({ allDevices: z.boolean().optional() });
export type PortalLogoutRequest = z.infer<typeof portalLogoutRequest>;

export const PORTAL_STEP_UP_SUBJECTS = ["consent", "plan_decision", "contact_change"] as const;
/** POST /portal/auth/step-up — sends a fresh OTP to the account's login destination for a sensitive action. */
export const portalStepUpRequest = z.object({
  subjectType: z.enum(PORTAL_STEP_UP_SUBJECTS),
  subjectId: uuid.optional(),
  channel: z.enum(PORTAL_OTP_CHANNELS).optional(),
});
export type PortalStepUpRequest = z.infer<typeof portalStepUpRequest>;
export const portalStepUpVerifyRequest = z.object({ challengeId: uuid, code: portalOtpCode });
export type PortalStepUpVerifyRequest = z.infer<typeof portalStepUpVerifyRequest>;
export const portalStepUpResponse = z.object({ stepUpUntil: isoDateTime });
export type PortalStepUpResponse = z.infer<typeof portalStepUpResponse>;

/** GET /portal/me */
export const portalMeResponse = z.object({
  account: z.object({
    id: uuid,
    status: portalAccountStatus,
    loginPhoneMasked: z.string().nullable(),
    loginEmailMasked: z.string().nullable(),
  }),
  patient: z.object({
    firstName: z.string(),
    preferredName: z.string().nullable(),
    displayName: z.string(),
    minor: z.boolean(),
  }),
  clinic: z.object({ id: uuid, name: z.string() }),
  settings: z.object({
    bookingEnabled: z.boolean(),
    minNoticeHours: z.number().int(),
    maxReschedules: z.number().int(),
    allowPatientCancel: z.boolean(),
    onlinePaymentsEnabled: z.boolean(),
  }),
  session: z.object({ expiresAt: isoDateTime, stepUpUntil: isoDateTime.nullable() }),
});
export type PortalMeResponse = z.infer<typeof portalMeResponse>;

/** One code verified: either signed in, or several patients match the destination and the person picks one. */
export const portalVerifyOtpResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("AUTHENTICATED"),
    tokens: portalTokens,
    me: portalMeResponse,
  }),
  z.object({
    status: z.literal("CHOOSE_PATIENT"),
    selectionToken: z.string(),
    expiresInSeconds: z.number().int(),
    options: z.array(portalAccountOption).min(2),
  }),
]);
export type PortalVerifyOtpResponse = z.infer<typeof portalVerifyOtpResponse>;

export const portalSessionResponse = z.object({
  id: uuid,
  deviceLabel: z.string().nullable(),
  createdAt: isoDateTime,
  lastUsedAt: isoDateTime,
  current: z.boolean(),
});
export type PortalSessionResponse = z.infer<typeof portalSessionResponse>;

// ---------------------------------------------------------------------------------------------
// Profile (allow-list: the portal never returns or accepts any other Patient column)
// ---------------------------------------------------------------------------------------------

export const PORTAL_PROFILE_FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "preferredName",
  "dob",
  "sex",
  "phone",
  "altPhone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
] as const;
/** Fields the patient may edit without verification. phone / email change only through the OTP-verified flow. */
export const PORTAL_EDITABLE_PROFILE_FIELDS = [
  "preferredName",
  "altPhone",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
] as const;

export const portalCommPreference = z.object({
  channel: z.enum(["SMS", "WHATSAPP", "EMAIL"]),
  /** TRANSACTIONAL cannot be switched off from the portal (invoices, receipts, OTP). */
  purpose: z.enum(["REMINDER", "MARKETING"]),
  optIn: z.boolean(),
});
export type PortalCommPreference = z.infer<typeof portalCommPreference>;

export const portalProfileResponse = z.object({
  mrn: z.string().nullable(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string().nullable(),
  preferredName: z.string().nullable(),
  dob: dateOnly.nullable(),
  sex: z.string(),
  phone: z.string().nullable(),
  altPhone: z.string().nullable(),
  email: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
  minor: z.boolean(),
  communicationPreferences: z.array(portalCommPreference),
});
export type PortalProfileResponse = z.infer<typeof portalProfileResponse>;

/** PATCH /portal/profile — strict allow-list, no defaults (absent keys keep the stored value). */
export const updatePortalProfileRequest = z.strictObject({
  preferredName: optionalText(100),
  altPhone: phone.nullable().optional(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9 -]{3,12}$/)
    .optional(),
  communicationPreferences: z.array(portalCommPreference).max(12).optional(),
});
export type UpdatePortalProfileRequest = z.infer<typeof updatePortalProfileRequest>;

/** POST /portal/profile/contact — change the login phone or e-mail; an OTP goes to the NEW destination first. */
export const portalContactChangeRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phone"), value: phone }),
  z.object({ kind: z.literal("email"), value: email }),
]);
export type PortalContactChangeRequest = z.infer<typeof portalContactChangeRequest>;
export const portalContactVerifyRequest = z.object({ challengeId: uuid, code: portalOtpCode });
export type PortalContactVerifyRequest = z.infer<typeof portalContactVerifyRequest>;

// ---------------------------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------------------------

export const portalBranchInfo = z.object({
  id: uuid,
  name: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  timeZone: timeZone,
});
export type PortalBranchInfo = z.infer<typeof portalBranchInfo>;

export const portalAppointmentResponse = z.object({
  id: uuid,
  status: appointmentStatus,
  appointmentType: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  branch: portalBranchInfo,
  /** Display name when the clinic directory has one; the IdP subject is never shown. */
  dentistName: z.string().nullable(),
  serviceName: z.string().nullable(),
  reschedulesUsed: z.number().int(),
  canReschedule: z.boolean(),
  canCancel: z.boolean(),
  /** Why a change is not possible (a `PORTAL_BOOKING_VIOLATIONS` value), for the UI hint. */
  changeBlockedReason: z.enum(PORTAL_BOOKING_VIOLATIONS).nullable(),
});
export type PortalAppointmentResponse = z.infer<typeof portalAppointmentResponse>;

export const listPortalAppointmentsQuery = pageQuery.extend({
  scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
});
export type ListPortalAppointmentsQuery = z.infer<typeof listPortalAppointmentsQuery>;

export const portalBookableService = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  durationMin: z.number().int(),
  pricePaise: z.number().int(),
});
export const portalBookingOptionsResponse = z.object({
  branches: z.array(portalBranchInfo.extend({ services: z.array(portalBookableService) })),
  appointmentTypes: z.array(appointmentType),
  rules: z.object({
    minNoticeHours: z.number().int(),
    maxAdvanceDays: z.number().int(),
    maxReschedules: z.number().int(),
    defaultDurationMin: z.number().int(),
  }),
});
export type PortalBookingOptionsResponse = z.infer<typeof portalBookingOptionsResponse>;

/** GET /portal/appointments/slots — free slots for one local day (same engine as staff availability). */
export const portalSlotsQuery = z.object({
  branchId: uuid,
  date: dateOnly,
  serviceId: uuid.optional(),
  appointmentType: appointmentType.optional(),
});
export type PortalSlotsQuery = z.infer<typeof portalSlotsQuery>;
export const portalSlotsResponse = z.object({
  branchId: uuid,
  date: dateOnly,
  timeZone,
  durationMin: z.number().int(),
  slots: z.array(z.object({ startsAt: isoDateTime, endsAt: isoDateTime })),
});
export type PortalSlotsResponse = z.infer<typeof portalSlotsResponse>;

/**
 * POST /portal/appointments. No patientId (the principal's), no dentist or chair choice: the scheduling service picks a
 * free dentist/chair of the branch (a dentist preference is an open question). Booking rules: `evaluatePortalBooking`.
 */
export const portalBookAppointmentRequest = z.object({
  branchId: uuid,
  startsAt: isoDateTime,
  serviceId: uuid.optional(),
  appointmentType: appointmentType.optional(),
  notes: optionalText(500),
  idempotencyKey,
});
export type PortalBookAppointmentRequest = z.infer<typeof portalBookAppointmentRequest>;

export const portalRescheduleRequest = z.object({
  startsAt: isoDateTime,
  reason: optionalText(500),
  idempotencyKey: idempotencyKey.optional(),
});
export type PortalRescheduleRequest = z.infer<typeof portalRescheduleRequest>;

export const portalCancelRequest = z.object({ reason: optionalText(500) });
export type PortalCancelRequest = z.infer<typeof portalCancelRequest>;

// ---------------------------------------------------------------------------------------------
// Treatment plans and estimates (patient-friendly: no internal notes, prices only as the frozen estimate)
// ---------------------------------------------------------------------------------------------

/** Item states a patient may still decide (a decision on any other state is refused). */
export const PORTAL_DECIDABLE_ITEM_STATUSES = ["PROPOSED", "DEFERRED"] as const;

export const portalPlanItem = z.object({
  id: uuid,
  serviceName: z.string(),
  toothLabel: z.string().nullable(),
  quantity: z.number().int(),
  unitEstimatePaise: z.number().int(),
  estimatePaise: z.number().int(),
  status: planItemStatus,
  canDecide: z.boolean(),
});
export type PortalPlanItem = z.infer<typeof portalPlanItem>;

export const portalAiExplanation = z.object({
  text: z.string(),
  /** Always true: rendered with the "AI-assisted, reviewed by your dentist" label. */
  aiGenerated: z.literal(true),
  approvedAt: isoDateTime,
});

export const portalPlanSummary = z.object({
  id: uuid,
  title: z.string(),
  status: treatmentPlanStatus,
  version: z.number().int(),
  presentedAt: isoDateTime.nullable(),
  estimatePaise: z.number().int(),
  branch: z.object({ id: uuid, name: z.string() }),
});
export const portalPlanResponse = portalPlanSummary.extend({
  items: z.array(portalPlanItem),
  totals: z.object({
    estimatePaise: z.number().int(),
    acceptedPaise: z.number().int(),
    pendingPaise: z.number().int(),
  }),
  /** Estimate with GST as the invoice would compute it (ADR 0004 §1.3). */
  estimate: z.object({
    taxInclusive: z.boolean(),
    subtotalPaise: z.number().int(),
    taxPaise: z.number().int(),
    totalPaise: z.number().int(),
  }),
  /** Dentist-approved patient-friendly explanation, if one was released (null otherwise). */
  explanation: portalAiExplanation.nullable(),
  /** Consent the patient must sign before accepting, when the tenant requires one and it is not signed yet. */
  consentRequired: z
    .object({ templateVersionId: uuid, title: z.string(), signed: z.boolean() })
    .nullable(),
});
export type PortalPlanResponse = z.infer<typeof portalPlanResponse>;

export const portalSignatureInput = z.object({
  /** The patient's full name typed as the signature. */
  typedName: trimmed(200).min(2),
  /** Explicit "I agree" tick. */
  agree: z.literal(true),
});
export type PortalSignatureInput = z.infer<typeof portalSignatureInput>;

/**
 * POST /portal/plans/:id/decisions — accept / decline / defer items of the CURRENT plan version. Needs a fresh
 * step-up OTP (`step_up_required`). An ACCEPTED decision also needs `signature` when `requirePlanConsent` is on.
 */
export const portalPlanDecisionRequest = z.object({
  planVersion: z.number().int().min(1),
  decisions: z
    .array(
      z.object({
        planItemId: uuid,
        decision: z.enum(PLAN_ITEM_DECISIONS),
        reason: optionalText(500),
      }),
    )
    .min(1)
    .max(50),
  consentTemplateVersionId: uuid.optional(),
  /** SHA-256 of the consent text shown (`portalConsentTextHash`), proving which text was agreed. */
  consentBodySha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  signature: portalSignatureInput.optional(),
});
export type PortalPlanDecisionRequest = z.infer<typeof portalPlanDecisionRequest>;

// ---------------------------------------------------------------------------------------------
// Invoices, payments, receipts
// ---------------------------------------------------------------------------------------------

export const portalInvoiceSummary = z.object({
  id: uuid,
  number: z.string(),
  status: invoiceStatus,
  issuedAt: isoDateTime,
  dueDate: dateOnly.nullable(),
  totalPaise: z.number().int(),
  adjustmentPaise: z.number().int(),
  paidPaise: z.number().int(),
  balancePaise: z.number().int(),
  branchName: z.string(),
  /** ISSUED / PARTIALLY_PAID with a balance, and online payments are enabled for the clinic. */
  payable: z.boolean(),
});
export type PortalInvoiceSummary = z.infer<typeof portalInvoiceSummary>;

export const listPortalInvoicesQuery = pageQuery.extend({
  status: z.enum(["OPEN", "PAID", "ALL"]).default("ALL"),
});
export type ListPortalInvoicesQuery = z.infer<typeof listPortalInvoicesQuery>;

export const portalInvoiceLine = z.object({
  description: z.string(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
  discountPaise: z.number().int(),
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
});
export const portalPaymentResponse = z.object({
  id: uuid,
  receiptNumber: z.string().nullable(),
  amountPaise: z.number().int(),
  method: paymentMethod,
  status: paymentStatus,
  receivedAt: isoDateTime,
  invoiceNumbers: z.array(z.string()),
});
export type PortalPaymentResponse = z.infer<typeof portalPaymentResponse>;
export const portalInvoiceDetail = portalInvoiceSummary.extend({
  taxInclusive: z.boolean(),
  subtotalPaise: z.number().int(),
  discountPaise: z.number().int(),
  taxPaise: z.number().int(),
  lines: z.array(portalInvoiceLine),
  payments: z.array(portalPaymentResponse),
});
export type PortalInvoiceDetail = z.infer<typeof portalInvoiceDetail>;

export const listPortalPaymentsQuery = pageQuery;
export type ListPortalPaymentsQuery = z.infer<typeof listPortalPaymentsQuery>;

export const portalReceiptResponse = z.object({
  receiptNumber: z.string(),
  paymentId: uuid,
  amountPaise: z.number().int(),
  method: paymentMethod,
  receivedAt: isoDateTime,
  clinicName: z.string(),
  branchName: z.string(),
  patientName: z.string(),
  allocations: z.array(z.object({ invoiceNumber: z.string(), amountPaise: z.number().int() })),
});
export type PortalReceiptResponse = z.infer<typeof portalReceiptResponse>;

/**
 * POST /portal/payments/checkout — start an online payment (the stub gateway in V1). Invoices must belong to the
 * principal's patient and be payable; `amountPaise` defaults to the sum of their balances and may not exceed it (no
 * advance payments from the portal). The payment is PENDING until the gateway webhook confirms it — never trust a
 * client-side success flag.
 */
export const portalCheckoutRequest = z.object({
  invoiceIds: z.array(uuid).min(1).max(20),
  amountPaise: positivePaise.optional(),
  idempotencyKey,
  /** https only (http solely for localhost in development); the service also checks the origin against config. */
  returnUrl: z.url().max(500).optional(),
});
export type PortalCheckoutRequest = z.infer<typeof portalCheckoutRequest>;
export const portalCheckoutResponse = z.object({
  paymentId: uuid,
  status: paymentStatus,
  checkoutUrl: z.string(),
  expiresAt: isoDateTime,
});
export type PortalCheckoutResponse = z.infer<typeof portalCheckoutResponse>;

// ---------------------------------------------------------------------------------------------
// Documents (only staff-flagged `portalVisible`, AVAILABLE, never ID_PROOF)
// ---------------------------------------------------------------------------------------------

export const portalDocumentResponse = z.object({
  id: uuid,
  fileName: z.string(),
  category: documentCategory,
  contentType: z.string(),
  sizeBytes: z.number().int(),
  description: z.string().nullable(),
  createdAt: isoDateTime,
});
export type PortalDocumentResponse = z.infer<typeof portalDocumentResponse>;
export const listPortalDocumentsQuery = pageQuery;
export type ListPortalDocumentsQuery = z.infer<typeof listPortalDocumentsQuery>;
/** GET /portal/documents/:id/download-url — short-lived (<= 5 min) presigned URL; never a public object URL. */
export const portalDocumentDownloadResponse = z.object({ url: z.string(), expiresAt: isoDateTime });
export type PortalDocumentDownloadResponse = z.infer<typeof portalDocumentDownloadResponse>;

// ---------------------------------------------------------------------------------------------
// Consents
// ---------------------------------------------------------------------------------------------

/** SHA-256 hex of a consent text exactly as displayed (trimmed, line endings normalised to \n). */
export const portalConsentTextHash = (body: string) =>
  sha256Hex(body.replace(/\r\n?/g, "\n").trim());

export const portalPendingConsent = z.object({
  templateVersionId: uuid,
  type: z.string(),
  title: z.string(),
  body: z.string(),
  bodySha256: z.string(),
  /** Set when the consent belongs to a treatment-plan version. */
  planVersionId: uuid.nullable(),
  planTitle: z.string().nullable(),
});
export const portalSignedConsent = z.object({
  consentId: uuid,
  type: z.string(),
  title: z.string().nullable(),
  signedAt: isoDateTime,
  typedName: z.string().nullable(),
});
export const portalConsentListResponse = z.object({
  pending: z.array(portalPendingConsent),
  signed: z.array(portalSignedConsent),
});
export type PortalConsentListResponse = z.infer<typeof portalConsentListResponse>;

/** POST /portal/consents/sign — needs a fresh step-up OTP; `bodySha256` must equal the current text hash. */
export const portalSignConsentRequest = z.object({
  templateVersionId: uuid,
  planVersionId: uuid.optional(),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  signature: portalSignatureInput,
});
export type PortalSignConsentRequest = z.infer<typeof portalSignConsentRequest>;
export const portalSignConsentResponse = z.object({ consentId: uuid, signedAt: isoDateTime });
export type PortalSignConsentResponse = z.infer<typeof portalSignConsentResponse>;

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

export const portalNotificationResponse = z.object({
  id: uuid,
  kind: z.string(),
  title: z.string(),
  channel: z.enum(["SMS", "WHATSAPP", "EMAIL"]),
  status: z.enum(["QUEUED", "SENT", "FAILED"]),
  createdAt: isoDateTime,
  sentAt: isoDateTime.nullable(),
});
export type PortalNotificationResponse = z.infer<typeof portalNotificationResponse>;
export const listPortalNotificationsQuery = pageQuery;
export type ListPortalNotificationsQuery = z.infer<typeof listPortalNotificationsQuery>;

// ---------------------------------------------------------------------------------------------
// Staff-side portal administration (`portal:manage`, settings: `portal:admin`)
// ---------------------------------------------------------------------------------------------

/**
 * POST /portal-admin/accounts — invite a patient. The patient's identity must already be staff-verified
 * (`Patient.identityVerifiedAt`) and the record must not be merged. Destinations default to the patient's own
 * phone / e-mail; staff may override (e.g. a verified new number). One account per patient.
 */
export const invitePortalAccountRequest = z.object({
  patientId: uuid,
  loginPhone: phone.optional(),
  loginEmail: email.optional(),
  /** Channel for the invite message (default: SMS for a phone, EMAIL for an e-mail). */
  channel: z.enum(PORTAL_OTP_CHANNELS).optional(),
});
export type InvitePortalAccountRequest = z.infer<typeof invitePortalAccountRequest>;

export const portalAccountResponse = z.object({
  id: uuid,
  patientId: uuid,
  patientName: z.string(),
  status: portalAccountStatus,
  loginPhoneMasked: z.string().nullable(),
  loginEmailMasked: z.string().nullable(),
  invitedBy: z.string(),
  invitedAt: isoDateTime,
  activatedAt: isoDateTime.nullable(),
  suspendedAt: isoDateTime.nullable(),
  suspendReason: z.string().nullable(),
  lastLoginAt: isoDateTime.nullable(),
  activeSessions: z.number().int(),
});
export type PortalAccountResponse = z.infer<typeof portalAccountResponse>;

export const listPortalAccountsQuery = pageQuery.extend({
  status: portalAccountStatus.optional(),
  patientId: uuid.optional(),
  /** Matches patient name or login destination. */
  q: z.string().trim().max(100).optional(),
});
export type ListPortalAccountsQuery = z.infer<typeof listPortalAccountsQuery>;

export const suspendPortalAccountRequest = z.object({ reason: trimmed(500).min(3) });
export type SuspendPortalAccountRequest = z.infer<typeof suspendPortalAccountRequest>;
export const reactivatePortalAccountRequest = z.object({ note: optionalText(500) });
export type ReactivatePortalAccountRequest = z.infer<typeof reactivatePortalAccountRequest>;

/** PATCH /portal-admin/documents/:id — flag a document (not an ID proof) visible to its patient in the portal. */
export const setDocumentPortalVisibleRequest = z.object({ portalVisible: z.boolean() });
export type SetDocumentPortalVisibleRequest = z.infer<typeof setDocumentPortalVisibleRequest>;

export const portalSettingsResponse = z.object({
  enabled: z.boolean(),
  minNoticeHours: z.number().int(),
  maxAdvanceDays: z.number().int(),
  maxReschedules: z.number().int(),
  maxActiveBookings: z.number().int(),
  bookableAppointmentTypes: z.array(appointmentType),
  defaultDurationMin: z.number().int(),
  bookableBranchIds: z.array(uuid).nullable(),
  allowPatientCancel: z.boolean(),
  stepUpWindowMinutes: z.number().int(),
  requirePlanConsent: z.boolean(),
  onlinePaymentsEnabled: z.boolean(),
});
export type PortalSettingsResponse = z.infer<typeof portalSettingsResponse>;

/** PATCH /portal-admin/settings — same shape as the stored knobs; no defaults. */
export const updatePortalSettingsRequest = portalSettings;
export type UpdatePortalSettingsRequest = z.infer<typeof updatePortalSettingsRequest>;

/** PUT /portal-admin/bookable-services — flags (or un-flags) services for portal booking in bulk. */
export const setPortalBookableServicesRequest = z.object({
  serviceIds: z.array(uuid).min(1).max(200),
  portalBookable: z.boolean(),
});
export type SetPortalBookableServicesRequest = z.infer<typeof setPortalBookableServicesRequest>;
export const portalBookableServiceAdminResponse = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  durationMin: z.number().int(),
  active: z.boolean(),
  portalBookable: z.boolean(),
});
export type PortalBookableServiceAdminResponse = z.infer<typeof portalBookableServiceAdminResponse>;

// ---------------------------------------------------------------------------------------------
// Queues (pg-boss; ids-only payloads, tenant envelope of apps/worker/src/jobs.ts)
// ---------------------------------------------------------------------------------------------

export const PORTAL_QUEUES = {
  /** After an OTP message is final (SENT / FAILED): blanks the code from the outbox row (`variables.code`). */
  SCRUB_OTP_MESSAGE: "portal.scrub-otp-message",
  /** Daily: deletes expired OTPs / sessions past retention (runs as the schema owner). */
  RETENTION_SWEEP: "portal.retention-sweep",
} as const;
export type PortalQueue = (typeof PORTAL_QUEUES)[keyof typeof PORTAL_QUEUES];
export const scrubOtpMessageJob = z.object({ outboxId: uuid });
export type ScrubOtpMessageJob = z.infer<typeof scrubOtpMessageJob>;
export const portalRetentionSweepJob = z.object({ asOf: dateOnly.optional() });
export type PortalRetentionSweepJob = z.infer<typeof portalRetentionSweepJob>;
