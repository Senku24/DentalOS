import { ApiError, asApiError } from "./errors";

/**
 * Friendly copy for the notification error codes (apps/api/src/notifications, NOTIFICATION_ERROR_CODES).
 * The frozen `errors.ts` does not know them, so the notifications client re-labels its errors here.
 * Codes: notification_state, template_not_found, template_placeholder_unknown, template_body_too_long,
 * address_invalid, channel_disabled, webhook_signature_invalid (+ outbox_not_found, template_exists,
 * patient_not_found, service_not_found, retry_later).
 */
type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const human = (v: unknown) => (str(v) ?? "").replace(/_/g, " ").toLowerCase();

export const NOTIFICATION_ERROR_MESSAGES: Record<string, string | ((b: Body) => string)> = {
  notification_state: (b) =>
    `This message is already ${human(b.status) || "finished"}, so it can't be changed. Only queued messages can be cancelled and only failed ones retried. Refresh the list.`,
  outbox_not_found: "That message no longer exists or belongs to another branch.",
  template_not_found: "No active template exists for that code, channel and language.",
  template_exists: (b) =>
    `A ${str(b.code) ?? ""} template for ${human(b.channel)} in language "${str(b.language) ?? ""}" already exists. Open it and publish a new version instead.`,
  template_placeholder_unknown: (b) => {
    const bad = Array.isArray(b.placeholders) ? b.placeholders.map(String) : [];
    const allowed = Array.isArray(b.allowed) ? b.allowed.map(String) : [];
    return `Unknown placeholder${bad.length === 1 ? "" : "s"}: ${bad.map((x) => `{{${x}}}`).join(", ") || "see the text"}.${
      allowed.length ? ` Allowed: ${allowed.map((x) => `{{${x}}}`).join(", ")}.` : ""
    }`;
  },
  template_body_too_long: "The text is longer than this channel allows. Shorten it.",
  address_invalid: "That address isn't valid for the channel (use a 10-digit mobile or an email).",
  channel_disabled: "That channel is switched off for your clinic. Enable it in Settings first.",
  webhook_signature_invalid:
    "Delivery receipts need a signed provider webhook. The console provider doesn't use webhooks.",
  patient_not_found: "That patient no longer exists.",
  service_not_found: "That service is not in the catalogue.",
  retry_later: "The server was busy. Try again in a moment.",
  validation_failed: "Some details need fixing.",
};

export function notificationErrorMessage(
  code: string | undefined,
  body: Body = {},
): string | undefined {
  if (!code) return undefined;
  const m = NOTIFICATION_ERROR_MESSAGES[code];
  return typeof m === "function" ? m(body) : m;
}

/** Re-labels an ApiError; `address_invalid` also lands on the `toAddress` field. */
export function withNotificationMessage(e: unknown): ApiError {
  const err = asApiError(e);
  const message = notificationErrorMessage(err.code, err.body);
  if (!message) return err;
  const fieldErrors =
    err.code === "address_invalid" && !("toAddress" in err.fieldErrors)
      ? { ...err.fieldErrors, toAddress: message }
      : err.fieldErrors;
  return new ApiError({
    kind: err.kind,
    status: err.status,
    message,
    code: err.code,
    fieldErrors,
    body: err.body,
  });
}
