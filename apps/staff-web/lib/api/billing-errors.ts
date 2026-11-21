import { ApiError, asApiError } from "./errors";

/**
 * Friendly copy for the M3 billing error codes (apps/api/src/billing, common/db-errors.ts, ADR 0004).
 * The frozen `errors.ts` only knows M1 codes, so the billing client re-labels its errors here; screens keep
 * using `err.message` / `err.fieldErrors` / `err.code` as everywhere else.
 */

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const human = (v: unknown) => (str(v) ?? "").replace(/_/g, " ").toLowerCase();

const rupees = (paise: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100);

export const BILLING_ERROR_MESSAGES: Record<string, string | ((b: Body) => string)> = {
  // Invoice lifecycle
  invoice_immutable:
    "This invoice has been issued and can no longer be edited. Issue a credit or debit note to correct it.",
  invoice_invalid_transition: "That status change isn't allowed for this invoice.",
  invoice_not_voidable:
    "Only a draft, or an issued invoice with no payments or credit/debit notes, can be voided. Refund the payments and issue a credit note instead.",
  invoice_totals_mismatch:
    "The invoice total doesn't match its lines. Reload the invoice and try again.",
  invoice_not_payable: (b) =>
    `This invoice is ${human(b.status) || "not open"}, so it can't take a payment.`,
  invoice_not_adjustable: (b) =>
    `A credit or debit note can only be issued on an issued invoice (this one is ${human(b.status) || "not issued"}).`,
  invoice_overpaid: (b) =>
    num(b.balancePaise) !== undefined
      ? `That is more than the invoice balance (${rupees(num(b.balancePaise) as number)}).`
      : "That is more than the invoice balance.",
  invoice_empty: "Add at least one line before issuing the invoice.",
  invoice_not_issued: "This invoice hasn't been issued yet, so it has no printable tax invoice.",
  invoice_not_found: "That invoice no longer exists.",
  invoice_line_not_found: "That line no longer exists.",
  // Plan billing
  plan_item_not_billable:
    "Only accepted, scheduled, in-progress or completed plan items can be billed.",
  plan_item_already_billed: "One of those plan items is already on another invoice.",
  plan_nothing_to_bill: "Everything on this plan has already been billed.",
  plan_item_plan_mismatch: "One of those items belongs to a different plan.",
  plan_item_not_found: "One of those plan items no longer exists.",
  plan_not_found: "That treatment plan no longer exists.",
  plan_version_not_found: "That plan version no longer exists.",
  service_inactive: "That service is inactive in the catalogue.",
  procedure_not_billable: "Only completed procedures can be billed.",
  // Discounts and prices
  price_override_not_allowed:
    "Catalogue and plan lines are billed at the server's price. Give a discount (with a reason) instead of editing the price.",
  discount_not_permitted: "You don't have permission to give discounts at this branch.",
  discount_reason_required: "A discount needs a reason (at least 3 characters).",
  discount_exceeds_limit: "That discount is above the limit for your role. Ask a manager or owner.",
  discount_exceeds_base: "A discount can't be more than the amount it reduces.",
  // Payments
  idempotency_conflict:
    "This request was already submitted with different details. Review it and submit again.",
  payment_immutable: "Payments can't be edited. Record a refund to correct a mistake.",
  payment_not_recorded: "Only a recorded payment can be allocated or refunded.",
  payment_not_pending: "This payment is no longer waiting for the gateway.",
  payment_reversal_not_allowed:
    "Payments can't be reversed. Record a refund to return money, or adjust the patient's advance.",
  payment_method_not_allowed: (b) =>
    `${human(b.method) ? `${human(b.method)} payments are` : "That payment method is"} not accepted at this branch.`,
  allocation_exceeds_payment: "You allocated more than this payment holds.",
  advance_not_allowed:
    "This clinic doesn't keep patient advances: allocate the whole payment to invoices.",
  credit_insufficient: "The patient's advance balance isn't enough for that.",
  credit_link_mismatch: "That advance entry doesn't match the patient or branch.",
  gateway_not_configured: "Online payments aren't set up for this clinic.",
  // Refunds
  refund_immutable: "Refunds can't be edited once recorded.",
  refund_exceeds_payment: "That is more than is left to refund on this payment.",
  refund_exceeds_allocation: "That is more than this payment paid towards the invoice.",
  refund_reversal_mismatch: "The refund doesn't match the invoice payment it reverses.",
  refund_approval_required:
    "This refund is above the approval threshold and must be approved first.",
  refund_self_approval: "A different person with refund approval rights must approve this refund.",
  refund_invalid_state: (b) =>
    `That can't be done while the refund is ${human(b.status) || "in this state"}.`,
  refund_not_approved: "The refund must be approved before it is processed.",
  refund_gateway_confirmation_required:
    "This is a gateway refund: it completes when the gateway confirms it.",
  refund_not_found: "That refund no longer exists.",
  payment_not_found: "That payment no longer exists.",
  // Notes
  tax_exceeds_amount: "The GST part can't be more than the note amount.",
  // Reports
  invalid_range: "The end date is before the start date.",
  range_too_large: "Pick a shorter date range (up to about two years).",
  // Misc
  webhook_amount_mismatch: "The gateway reported a different amount than expected.",
  link_patient_mismatch: "That record belongs to a different patient.",
  link_mismatch: "Those records don't belong to the same patient and branch.",
  constraint_violated: "That change breaks a billing rule, so it wasn't saved.",
  duplicate:
    "A document number was already used, so nothing was saved. Try again; if it keeps happening, contact support.",
  retry_later:
    "The system was busy (a number or balance was being updated). Try again in a moment.",
  tenant_mismatch:
    "A billing number couldn't be allocated. Try again; if it keeps happening, contact support.",
  invalid_cursor: "That page is no longer available. Reload the list.",
  invalid_settings: "Those billing settings aren't valid.",
  not_a_member: "That person is not a member of this organisation.",
  branch_not_found: "That branch no longer exists.",
  service_not_found: "That service is not in the catalogue.",
};

/** Copy for a known code (undefined for codes this module does not own). */
export function billingErrorMessage(code: string | undefined, body: Body = {}): string | undefined {
  if (!code) return undefined;
  const m = BILLING_ERROR_MESSAGES[code];
  return typeof m === "function" ? m(body) : m;
}

/** Re-labels an ApiError with billing copy and maps `{ field }` bodies onto `fieldErrors`. */
export function withBillingMessage(e: unknown): ApiError {
  const err = asApiError(e);
  const message = billingErrorMessage(err.code, err.body);
  if (!message) return err;
  const field = str(err.body.field);
  const fieldErrors =
    field && err.kind === "validation" && !(field in err.fieldErrors)
      ? { ...err.fieldErrors, [field]: message }
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

/** True for the codes that mean "the invoice is frozen": screens reload and drop the edit controls. */
export const isImmutableInvoiceError = (e: unknown) => asApiError(e).code === "invoice_immutable";
