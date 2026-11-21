import type { BadgeTone } from "@dentalos/ui";
import {
  type NotificationChannel,
  type NotificationPurpose,
  type NotificationStatus,
  SYSTEM_TEMPLATES,
  placeholdersFor,
} from "@dentalos/validation";

/** Display copy for notification enums. Status is always shown as text, not colour alone. */

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  EMAIL: "Email",
};
export const channelLabel = (c: string) => CHANNEL_LABEL[c as NotificationChannel] ?? c;

export const PURPOSE_LABEL: Record<NotificationPurpose, string> = {
  TRANSACTIONAL: "Transactional",
  REMINDER: "Reminder",
  MARKETING: "Marketing",
};
export const purposeLabel = (p: string) => PURPOSE_LABEL[p as NotificationPurpose] ?? p;

export const STATUS_LABEL: Record<NotificationStatus, string> = {
  QUEUED: "Queued",
  SENT: "Sent",
  FAILED: "Failed",
  SKIPPED_NO_CONSENT: "Skipped: no consent",
  OPTED_OUT: "Opted out",
};
export const STATUS_TONE: Record<NotificationStatus, BadgeTone> = {
  QUEUED: "info",
  SENT: "success",
  FAILED: "danger",
  SKIPPED_NO_CONSENT: "warning",
  OPTED_OUT: "neutral",
};
export const statusLabel = (s: string) => STATUS_LABEL[s as NotificationStatus] ?? s;
export const statusTone = (s: string): BadgeTone =>
  STATUS_TONE[s as NotificationStatus] ?? "neutral";

export const DELIVERY_TONE: Record<string, BadgeTone> = {
  queued: "info",
  sent: "info",
  delivered: "success",
  read: "success",
  failed: "danger",
};

/** Why the consent resolver decided what it did (reasons from `resolveConsent`). */
const CONSENT_REASONS: Record<string, string> = {
  channel_opt_out:
    "The patient opted out of this channel (a transactional opt-out blocks every purpose on it).",
  opted_in: "The patient opted in to this purpose on this channel.",
  channel_opt_in:
    "No reminder preference, but the patient opted in to transactional messages on this channel, which reminders inherit.",
  implicit_transactional:
    "No preference on file; the clinic treats patients as opted in to transactional messages (implicit consent is on).",
  implicit_reminder:
    "No preference on file; the clinic treats patients as opted in to reminders (implicit consent is on).",
  no_preference:
    "No preference on file and the clinic's settings don't imply consent for this purpose (marketing is never implied).",
  transactional_opt_out: "The patient opted out of transactional messages on this channel.",
  reminder_opt_out: "The patient opted out of reminders on this channel.",
  marketing_opt_out: "The patient opted out of marketing on this channel.",
  cancelled: "Cancelled by staff before it was sent.",
};
export const consentReason = (reason: string | null | undefined): string => {
  if (!reason) return "";
  return CONSENT_REASONS[reason] ?? reason.replace(/_/g, " ");
};

/** Sample values for the placeholder helper and live previews (never real patient data). */
export const SAMPLE_VALUES: Record<string, string> = {
  patientName: "Asha Verma",
  appointmentDate: "Thu, 26 Nov 2026",
  appointmentTime: "11:30 AM",
  branchName: "Saket",
  branchPhone: "+91 11 4000 1234",
  dentistName: "Dr Rao",
  changeSummary: "moved to 4:00 PM",
  invoiceNumber: "SKT/2627/0042",
  invoiceDate: "22 Nov 2026",
  totalAmount: "₹5,900",
  balanceAmount: "₹2,400",
  dueDate: "29 Nov 2026",
  receiptNumber: "RCT-0118",
  paidAmount: "₹3,500",
  paymentMethod: "UPI",
  paymentDate: "22 Nov 2026",
  refundAmount: "₹500",
  refundDate: "22 Nov 2026",
  serviceName: "Scaling and polishing",
  planTitle: "Root canal and crown",
  consentLink: "https://example.com/consent/abc123",
};
export const sampleFor = (name: string) => SAMPLE_VALUES[name] ?? `[${name}]`;

/** Allowed placeholders for a code, or undefined for a custom code (any name; unchecked). */
export const allowedFor = (code: string): readonly string[] | undefined =>
  placeholdersFor(code.trim().toUpperCase());

export const isSystemCode = (code: string) => code.trim().toUpperCase() in SYSTEM_TEMPLATES;
export const systemPurpose = (code: string): NotificationPurpose | undefined =>
  (SYSTEM_TEMPLATES as Record<string, { purpose: NotificationPurpose }>)[code.trim().toUpperCase()]
    ?.purpose;

/** Reminder offset (minutes) as a label: 1440 -> "T-24h", 120 -> "T-2h", 90 -> "T-90m". */
export function offsetLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `T-${(minutes / 1440) * 24}h`;
  if (minutes % 60 === 0) return `T-${minutes / 60}h`;
  return `T-${minutes}m`;
}
