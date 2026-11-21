import { ApiError, asApiError } from "./errors";

/**
 * Friendly copy for the compensation API's error codes (ADR 0004 §7, apps/api/src/commissions).
 * Re-labelled by the commissions client; screens keep using `err.message` / `err.fieldErrors`.
 */

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export const COMMISSION_ERROR_MESSAGES: Record<string, string | ((b: Body) => string)> = {
  commission_rule_immutable:
    "Commission rules are never edited. Replace the rule (it ends the day before the new one starts) or close it.",
  commission_rule_overlap:
    "Another rule already covers that dentist and service category for these dates. Replace or close the rule in force first.",
  commission_rule_closed: "That rule has already ended, so it can't be replaced or closed again.",
  commission_rule_not_found: "That rule no longer exists.",
  settlement_state: (b) =>
    `This settlement is ${str(b.status)?.toLowerCase() ?? "no longer in the right state"}, so that step isn't available. Refresh to see its current status.`,
  settlement_total_mismatch:
    "The settlement's items no longer add up to its total. Delete this draft and create a new one.",
  settlement_item_mismatch:
    "A settled ledger entry changed after it was frozen. Delete this draft and create a new one.",
  settlement_self_approval:
    "The person who created a settlement can't approve it. Ask another approver (maker-checker).",
  settlement_nothing_to_settle:
    "There is no positive unsettled balance for that dentist up to the period end, so there is nothing to settle.",
  settlement_period_overlap:
    "That dentist already has a settlement covering part of this period. Pick a period that doesn't overlap.",
  settlement_not_found: "That settlement no longer exists.",
  allocation_not_found: "That payment allocation id was not found.",
  not_a_member: "That person is not a member of this organisation.",
  service_category_not_found: "That service category no longer exists.",
  branch_not_found: "That branch no longer exists.",
  not_permitted: "You don't have permission to do that.",
  idempotency_conflict:
    "This request key was already used with different details. Close the form and start again.",
  link_mismatch: "One of the linked records doesn't belong here.",
  concurrent_edit: "Someone else changed this at the same time. Refresh and try again.",
};

export function commissionErrorMessage(code: string | undefined, body: Body = {}) {
  if (!code) return undefined;
  const m = COMMISSION_ERROR_MESSAGES[code];
  return typeof m === "function" ? m(body) : m;
}

export function withCommissionMessage(e: unknown): ApiError {
  const err = asApiError(e);
  const message = commissionErrorMessage(err.code, err.body);
  if (!message) return err;
  return new ApiError({
    kind: err.kind,
    status: err.status,
    message,
    code: err.code,
    fieldErrors: err.fieldErrors,
    body: err.body,
  });
}
