import type { BadgeTone } from "@dentalos/ui";
import {
  type DiscountSpec,
  type GstLineInput,
  type InvoiceDetailResponse,
  type InvoiceStatus,
  type InvoiceSummary,
  type InvoiceTotals,
  type PaymentDetailResponse,
  type PaymentStatus,
  type RefundResponse,
  type RefundStatus,
  type ResolvedBillingSettings,
  checkDiscount,
  computeInvoiceTotals,
  isInterStateSupply,
  maxDiscountBpForRoles,
  refundablePaise,
} from "@dentalos/validation";

/**
 * Billing display rules. Money maths is NEVER re-implemented here: previews call the shared pure helpers
 * (`computeInvoiceTotals`, `checkDiscount`, `refundablePaise` …) from @dentalos/validation, the same code the
 * API runs, so a preview and the saved invoice agree to the paisa. The server stays the authority.
 */

// ---- Status presentation ----------------------------------------------------------------------------

export function invoiceTone(s: InvoiceStatus): BadgeTone {
  switch (s) {
    case "PAID":
      return "success";
    case "PARTIALLY_PAID":
      return "warning";
    case "ISSUED":
      return "info";
    case "VOID":
      return "danger";
    default:
      return "neutral";
  }
}
export const invoiceStatusLabel = (s: InvoiceStatus) =>
  ({
    DRAFT: "Draft",
    ISSUED: "Issued",
    PARTIALLY_PAID: "Partly paid",
    PAID: "Paid",
    VOID: "Void",
  })[s];

export function paymentTone(s: PaymentStatus): BadgeTone {
  return s === "RECORDED" ? "success" : s === "PENDING" ? "warning" : "danger";
}
export const paymentStatusLabel = (s: PaymentStatus) =>
  ({ RECORDED: "Recorded", PENDING: "Awaiting gateway", FAILED: "Failed" })[s];

export function refundTone(s: RefundStatus): BadgeTone {
  switch (s) {
    case "PROCESSED":
      return "success";
    case "APPROVED":
      return "info";
    case "REQUESTED":
      return "warning";
    default:
      return "danger";
  }
}
export const refundStatusLabel = (s: RefundStatus) =>
  ({
    REQUESTED: "Awaiting approval",
    APPROVED: "Approved, to process",
    PROCESSED: "Processed",
    REJECTED: "Rejected",
  })[s];

export const METHOD_LABELS: Record<string, string> = {
  CASH: "Cash",
  UPI: "UPI",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  CHEQUE: "Cheque",
  WALLET: "Wallet",
  OTHER: "Other",
};
export const methodLabel = (m: string) => METHOD_LABELS[m] ?? m;

// ---- Invoice state → what the UI offers (display only; the API enforces) ---------------------------------

export interface InvoiceCapabilities {
  editable: boolean;
  canIssue: boolean;
  /** DRAFT, or ISSUED with nothing paid / adjusted (the API's rule, `invoice_not_voidable` otherwise). */
  canVoid: boolean;
  canPay: boolean;
  canAdjust: boolean;
  canRefund: boolean;
}

export function invoiceCapabilities(
  inv: Pick<
    InvoiceDetailResponse,
    "status" | "paidPaise" | "adjustmentPaise" | "balancePaise" | "lines"
  >,
): InvoiceCapabilities {
  const open = inv.status === "ISSUED" || inv.status === "PARTIALLY_PAID" || inv.status === "PAID";
  return {
    editable: inv.status === "DRAFT",
    canIssue: inv.status === "DRAFT" && inv.lines.length > 0,
    canVoid:
      inv.status === "DRAFT" ||
      (inv.status === "ISSUED" && inv.paidPaise === 0 && inv.adjustmentPaise === 0),
    canPay: (inv.status === "ISSUED" || inv.status === "PARTIALLY_PAID") && inv.balancePaise > 0,
    canAdjust: open,
    canRefund: open && inv.paidPaise > 0,
  };
}

// ---- GST / totals preview ---------------------------------------------------------------------------------

export interface PreviewLine {
  quantity: number;
  unitPricePaise: number;
  /** Already converted to paise for this line (see `lineDiscountPaise`). */
  discountPaise: number;
  taxRateBp: number;
}

/** Percent / amount discount entered on a line → paise (half up) or an error message. */
export function lineDiscountPaise(
  spec: DiscountSpec | null,
  quantity: number,
  unitPricePaise: number,
): { paise: number } | { error: string } {
  if (!spec) return { paise: 0 };
  const gross = quantity * unitPricePaise;
  if (spec.kind === "AMOUNT") {
    return spec.amountPaise > gross
      ? { error: "A discount can't be more than the line amount." }
      : { paise: spec.amountPaise };
  }
  return { paise: Math.floor((gross * spec.percentBp + 5_000) / 10_000) };
}

export interface PreviewInput {
  lines: PreviewLine[];
  taxInclusive: boolean;
  supplierStateCode: string | null | undefined;
  placeOfSupplyStateCode: string | null | undefined;
  invoiceDiscount: DiscountSpec | null;
}

/** Totals via the shared `computeInvoiceTotals`; null with a message when the inputs are out of range. */
export function previewInvoice(
  input: PreviewInput,
): { ok: true; totals: InvoiceTotals; interState: boolean } | { ok: false; message: string } {
  const interState = isInterStateSupply(input.supplierStateCode, input.placeOfSupplyStateCode);
  const lines: GstLineInput[] = input.lines.map((l) => ({
    quantity: l.quantity,
    unitPricePaise: l.unitPricePaise,
    discountPaise: l.discountPaise,
    taxRateBp: l.taxRateBp,
  }));
  try {
    return {
      ok: true,
      interState,
      totals: computeInvoiceTotals({
        lines,
        taxInclusive: input.taxInclusive,
        interState,
        invoiceDiscount: input.invoiceDiscount,
      }),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Check the amounts." };
  }
}

/** Client-side mirror of the server's discount rules (`checkDiscount`), as a message or null. */
export function discountProblem(args: {
  discount: DiscountSpec | null;
  basePaise: number;
  reason: string;
  canApply: boolean;
  roles: readonly string[];
  settings: Pick<ResolvedBillingSettings, "discountLimitsBp"> | undefined;
}): string | null {
  if (!args.discount) return null;
  const r = checkDiscount({
    discount: args.discount,
    basePaise: args.basePaise,
    reason: args.reason,
    canApply: args.canApply,
    maxPercentBp: maxDiscountBpForRoles(args.roles, args.settings?.discountLimitsBp ?? {}),
  });
  if (r.ok) return null;
  return {
    discount_not_permitted: "You don't have permission to give discounts at this branch.",
    discount_reason_required: "Enter a reason for the discount (at least 3 characters).",
    discount_exceeds_base: "A discount can't be more than the amount it reduces.",
    discount_exceeds_limit: "That is above the discount limit for your role.",
  }[r.error];
}

// ---- Payments / refunds -----------------------------------------------------------------------------------

/** Net paise a payment has put towards one invoice (reversals are negative allocations). */
export function netAllocatedToInvoice(
  inv: Pick<InvoiceDetailResponse, "allocations">,
  paymentId: string,
): number {
  return inv.allocations
    .filter((a) => a.paymentId === paymentId)
    .reduce((s, a) => s + a.amountPaise, 0);
}

/**
 * Most that can be requested as a refund of `payment` against `invoice`: bounded by what the payment still
 * holds (`refundablePaise`, requests reserve their amount) and by what it paid towards this invoice.
 */
export function refundCapForInvoice(
  inv: Pick<InvoiceDetailResponse, "id" | "allocations">,
  payment: Pick<PaymentDetailResponse, "id" | "amountPaise" | "refunds">,
): number {
  const left = refundablePaise(payment.amountPaise, payment.refunds);
  const paid = netAllocatedToInvoice(inv, payment.id);
  const reserved = payment.refunds
    .filter((r) => r.status !== "REJECTED" && r.invoiceId === inv.id)
    .reduce((s, r) => s + r.amountPaise, 0);
  return Math.max(0, Math.min(left, paid - reserved));
}

/** Refund needs a second approver above the threshold; auto-approved at or below it. */
export const refundNeedsSecondApprover = (amountPaise: number, thresholdPaise: number) =>
  amountPaise > thresholdPaise;

/** What a refund row lets this user do next (display only). */
export function refundNextSteps(
  r: Pick<RefundResponse, "status" | "requestedBy" | "gateway">,
  me: string,
) {
  return {
    canApprove: r.status === "REQUESTED",
    /** The API refuses self-approval when `separateApprover` is on; the hint warns early. */
    approvingOwnRequest: r.status === "REQUESTED" && r.requestedBy === me,
    canReject: r.status === "REQUESTED" || r.status === "APPROVED",
    canProcess: r.status === "APPROVED" && r.gateway === "MANUAL",
    waitsForGateway: r.status === "APPROVED" && r.gateway !== "MANUAL",
  };
}

// ---- Idempotency keys ---------------------------------------------------------------------------------------

/**
 * One key per user action, reused on retry. The key is bound to a fingerprint of the request body: a retry of
 * the same body re-sends the same key (the API answers the original result = success), while a changed body
 * gets a new key (re-using a key with a different body is `409 idempotency_conflict`).
 */
export function createKeyer(prefix: string) {
  let last: { fingerprint: string; key: string } | null = null;
  const fresh = () => `${prefix}-${globalThis.crypto.randomUUID()}`;
  return {
    keyFor(fingerprint: string): string {
      if (!last || last.fingerprint !== fingerprint) last = { fingerprint, key: fresh() };
      return last.key;
    },
    /** Call after a success: the next action is a new action. */
    reset() {
      last = null;
    },
  };
}

// ---- Aging ------------------------------------------------------------------------------------------------

export const AGING_BUCKETS = [
  "Not yet due",
  "1–30 days",
  "31–60 days",
  "61–90 days",
  "Over 90 days",
] as const;
export interface AgingRow {
  bucket: (typeof AGING_BUCKETS)[number];
  count: number;
  balancePaise: number;
}

const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Days past due (<= 0 = not yet due or no due date). `today` is a local "YYYY-MM-DD". */
export function daysOverdue(dueDate: string | null, today: string): number {
  if (!dueDate) return 0;
  return dayNumber(today) - dayNumber(dueDate);
}

export function agingBuckets(
  invoices: Pick<InvoiceSummary, "dueDate" | "balancePaise">[],
  today: string,
): AgingRow[] {
  const rows: AgingRow[] = AGING_BUCKETS.map((bucket) => ({ bucket, count: 0, balancePaise: 0 }));
  for (const i of invoices) {
    const d = daysOverdue(i.dueDate, today);
    const idx = d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4;
    const row = rows[idx];
    if (!row) continue;
    row.count += 1;
    row.balancePaise += i.balancePaise;
  }
  return rows;
}

/** "YYYY-MM-DD" minus N days (calendar arithmetic, no time zone). */
export function dateMinusDays(day: string, n: number): string {
  return new Date((dayNumber(day) - n) * 86_400_000).toISOString().slice(0, 10);
}
