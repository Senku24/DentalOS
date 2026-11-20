import { z } from "zod";
import { dateOnly, isoDateTime, optionalText, pageQuery, staffRole, trimmed, uuid } from "./common";
import { type TransitionTable, allowedTransitions, canTransition } from "./state-machine";

// Estimates, invoices, payments, refunds, credit notes and patient credit (PRD 4.6, 2.5, 7.5).
// Rules: docs/adr/0004-business-operations-rules.md (PROPOSED — needs product sign-off). The DB enforces
// the integrity rules (migration 0008): issued invoices are immutable, payments / allocations /
// adjustments / ledgers are append-only, balances follow allocations. All money is integer paise.

// ---------------------------------------------------------------------------------------------
// Enumerations (mirror schema.prisma; kept in sync by hand — there are no automated tests right now)
// ---------------------------------------------------------------------------------------------

export const INVOICE_STATUSES = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const PAYMENT_METHODS = [
  "CASH",
  "UPI",
  "CARD",
  "BANK_TRANSFER",
  "CHEQUE",
  "WALLET",
  "OTHER",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_STATUSES = ["RECORDED", "PENDING", "FAILED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const REFUND_STATUSES = ["REQUESTED", "APPROVED", "PROCESSED", "REJECTED"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const ADJUSTMENT_KINDS = ["CREDIT", "DEBIT"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];
export const LEDGER_ENTRY_KINDS = [
  "INVOICE",
  "INVOICE_VOID",
  "PAYMENT",
  "REFUND",
  "CREDIT_NOTE",
  "DEBIT_NOTE",
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];
export const CREDIT_ENTRY_KINDS = ["ADVANCE", "APPLIED", "REFUNDED", "ADJUSTMENT"] as const;
export type CreditEntryKind = (typeof CREDIT_ENTRY_KINDS)[number];
/** InvoiceCounter.series. */
export const DOCUMENT_SERIES = ["INV", "CN", "DN", "RCP"] as const;
export type DocumentSeries = (typeof DOCUMENT_SERIES)[number];
/** Payment gateway providers shipped in M3 (a real gateway is added later; `Payment.gateway` is text). */
export const GATEWAY_PROVIDERS = ["MANUAL", "STUB"] as const;
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

export const invoiceStatus = z.enum(INVOICE_STATUSES);
export const paymentMethod = z.enum(PAYMENT_METHODS);
export const paymentStatus = z.enum(PAYMENT_STATUSES);
export const refundStatus = z.enum(REFUND_STATUSES);
export const adjustmentKind = z.enum(ADJUSTMENT_KINDS);
export const ledgerEntryKind = z.enum(LEDGER_ENTRY_KINDS);
export const creditEntryKind = z.enum(CREDIT_ENTRY_KINDS);

/** Stable error codes of the billing API (409 unless noted). DB trigger codes are mapped in common/db-errors.ts. */
export const BILLING_ERROR_CODES = [
  "invoice_immutable",
  "invoice_invalid_transition",
  "invoice_not_voidable",
  "invoice_totals_mismatch",
  "invoice_not_payable",
  "invoice_not_adjustable",
  "invoice_overpaid",
  "invoice_empty",
  "payment_immutable",
  "payment_not_recorded",
  "payment_reversal_not_allowed",
  "allocation_exceeds_payment",
  "refund_immutable",
  "refund_exceeds_payment",
  "refund_exceeds_allocation",
  "refund_reversal_mismatch",
  "refund_approval_required",
  "refund_self_approval",
  "credit_insufficient",
  "credit_link_mismatch",
  "price_override_not_allowed",
  "discount_not_permitted",
  "discount_reason_required",
  "discount_exceeds_limit",
  "discount_exceeds_base",
  "idempotency_conflict",
  "plan_item_not_billable",
  "plan_item_already_billed",
  "webhook_signature_invalid",
] as const;
export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Strictly positive paise (payments, refunds, notes). Upper bound ₹1 crore like `paise`. */
export const positivePaise = z.number().int().min(1).max(1_000_000_000);
/** Basis points: 1 bp = 0.01%, 10000 = 100%. */
export const basisPoints = z.number().int().min(0).max(10_000);
/**
 * Client-supplied replay key for every payment / refund / money-moving request (unique per tenant). Payments,
 * refunds and gateway checkouts store it on their own row; every other append-only write (credit / debit notes,
 * advance application and adjustment, allocations of an existing payment, commission adjustments and settlements,
 * stock receipts / consumption / adjustments / waste / transfers) inserts a `RequestDedupe(scope, key)` row first
 * in the same transaction: a unique violation (23505) means "replay, write nothing, answer with the stored refId".
 */
export const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/, "Letters, digits and . _ : - only");
/** Two-digit GST state code ("29" = Karnataka). */
export const gstStateCode = z
  .string()
  .trim()
  .regex(/^[0-9]{2}$/);
/** 15-character GSTIN, upper-case. */
export const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z0-9]{13}$/);
/** HSN (goods) / SAC (services), 4–8 digits. */
export const hsnSac = z
  .string()
  .trim()
  .regex(/^[0-9]{4,8}$/);
const reasonText = z.string().trim().min(3).max(500);

// ---------------------------------------------------------------------------------------------
// Invoice state machine (ADR 0004 §1)
// ---------------------------------------------------------------------------------------------

/**
 * DRAFT -> ISSUED (number assigned, lines frozen) -> PARTIALLY_PAID -> PAID. A zero-total invoice goes
 * DRAFT -> PAID. VOID only from DRAFT or an unpaid, unadjusted ISSUED invoice (with a reason). The
 * moves between ISSUED / PARTIALLY_PAID / PAID are made by the database when allocations, refund
 * reversals and credit/debit notes change the balance — the API never sets them directly.
 */
export const INVOICE_TRANSITIONS: TransitionTable<InvoiceStatus> = {
  DRAFT: ["ISSUED", "PAID", "VOID"],
  ISSUED: ["PARTIALLY_PAID", "PAID", "VOID"],
  PARTIALLY_PAID: ["ISSUED", "PAID"],
  PAID: ["PARTIALLY_PAID", "ISSUED"],
  VOID: [],
};
export const canTransitionInvoice = (from: InvoiceStatus, to: InvoiceStatus) =>
  canTransition(INVOICE_TRANSITIONS, from, to);
export const allowedInvoiceTransitions = (from: InvoiceStatus) =>
  allowedTransitions(INVOICE_TRANSITIONS, from);
/** Moves a staff request may ask for (issue, void); everything else is derived from money movements. */
export const INVOICE_USER_TRANSITIONS: readonly InvoiceStatus[] = ["ISSUED", "VOID"];
/** Lines, discounts and header of an invoice are editable only in these statuses. */
export const INVOICE_EDITABLE_STATUSES: readonly InvoiceStatus[] = ["DRAFT"];
/** Statuses that accept payments, credit/debit notes. */
export const INVOICE_OPEN_STATUSES: readonly InvoiceStatus[] = ["ISSUED", "PARTIALLY_PAID", "PAID"];
/** Statuses with an amount still to collect. */
export const INVOICE_OUTSTANDING_STATUSES: readonly InvoiceStatus[] = ["ISSUED", "PARTIALLY_PAID"];

/** REQUESTED -> APPROVED -> PROCESSED; REQUESTED / APPROVED -> REJECTED. (Mirrors the refund_guard trigger.) */
export const REFUND_TRANSITIONS: TransitionTable<RefundStatus> = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["PROCESSED", "REJECTED"],
  PROCESSED: [],
  REJECTED: [],
};
export const canTransitionRefund = (from: RefundStatus, to: RefundStatus) =>
  canTransition(REFUND_TRANSITIONS, from, to);

// ---------------------------------------------------------------------------------------------
// Pure helpers: integer money maths (BigInt inside, so ₹1 crore × 10 000 never loses precision)
// ---------------------------------------------------------------------------------------------

/** round-half-up(n / d) for n >= 0, d > 0. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("divisor must be positive");
  if (n < 0n) throw new RangeError("dividend must not be negative");
  return (n + d / 2n) / d;
}

/** round-half-up(n × num / den) for non-negative integers; returns a plain number. */
export function mulDivRound(n: number, num: number, den: number): number {
  return Number(divRoundHalfUp(BigInt(n) * BigInt(num), BigInt(den)));
}

/** Signed variant (rounds the magnitude half up, keeps the sign): refunds mirror payments exactly. */
export function mulDivRoundSigned(n: number, num: number, den: number): number {
  return n < 0 ? -mulDivRound(-n, num, den) : mulDivRound(n, num, den);
}

// ---------------------------------------------------------------------------------------------
// GST (ADR 0004 §3). India intra-state default: CGST + SGST; IGST when place of supply differs.
// ---------------------------------------------------------------------------------------------

export interface GstLineInput {
  quantity: number;
  /** Unit price as entered; includes GST when `taxInclusive`. */
  unitPricePaise: number;
  /** Line-level discount (tax-inclusive amount when `taxInclusive`, else ex-tax). */
  discountPaise?: number;
  /** GST rate in basis points (1800 = 18%). 0 = exempt / no GST. */
  taxRateBp: number;
}
export interface GstLineOptions {
  taxInclusive: boolean;
  /** true -> IGST; false -> CGST + SGST. */
  interState: boolean;
  /** This line's share of the invoice-level discount (see `allocateInvoiceDiscount`). */
  allocatedDiscountPaise?: number;
}
export interface GstLineAmounts {
  grossPaise: number;
  discountPaise: number;
  allocatedDiscountPaise: number;
  /** Value GST is charged on (ex-tax). */
  taxableValuePaise: number;
  taxRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  /** taxableValue + cgst + sgst + igst. */
  totalPaise: number;
}

/**
 * GST for one line. Rounding rule (proposed, ADR 0004 §3.4): everything in integer paise, **half up per
 * line**, then sums of the rounded lines.
 *  - exclusive: net = gross − discounts; taxable = net; tax = round(net × rate / 10000)
 *  - inclusive: net = gross − discounts; taxable = round(net × 10000 / (10000 + rate)); tax = net − taxable
 *  - intra-state: cgst = floor(tax / 2), sgst = tax − cgst (the odd paisa goes to SGST); inter-state: igst = tax
 * Throws RangeError when discounts exceed the gross amount.
 */
export function computeGstLine(input: GstLineInput, opts: GstLineOptions): GstLineAmounts {
  const { quantity, unitPricePaise, taxRateBp } = input;
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError("quantity must be >= 1");
  if (!Number.isInteger(unitPricePaise) || unitPricePaise < 0)
    throw new RangeError("unit price must be a non-negative integer");
  if (!Number.isInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 10_000)
    throw new RangeError("tax rate must be 0-10000 bp");
  const discountPaise = input.discountPaise ?? 0;
  const allocatedDiscountPaise = opts.allocatedDiscountPaise ?? 0;
  const gross = BigInt(quantity) * BigInt(unitPricePaise);
  const net = gross - BigInt(discountPaise) - BigInt(allocatedDiscountPaise);
  if (discountPaise < 0 || allocatedDiscountPaise < 0 || net < 0n)
    throw new RangeError("discounts exceed the line amount");
  const rate = BigInt(taxRateBp);
  let taxable: bigint;
  let tax: bigint;
  if (opts.taxInclusive) {
    taxable = divRoundHalfUp(net * 10_000n, 10_000n + rate);
    tax = net - taxable;
  } else {
    taxable = net;
    tax = divRoundHalfUp(net * rate, 10_000n);
  }
  const cgst = opts.interState ? 0n : tax / 2n;
  const sgst = opts.interState ? 0n : tax - cgst;
  const igst = opts.interState ? tax : 0n;
  return {
    grossPaise: Number(gross),
    discountPaise,
    allocatedDiscountPaise,
    taxableValuePaise: Number(taxable),
    taxRateBp,
    cgstPaise: Number(cgst),
    sgstPaise: Number(sgst),
    igstPaise: Number(igst),
    totalPaise: Number(taxable + tax),
  };
}

/** Inter-state supply when both state codes are known and differ; unknown -> intra-state (default). */
export function isInterStateSupply(
  supplierStateCode: string | null | undefined,
  placeOfSupplyStateCode: string | null | undefined,
): boolean {
  return Boolean(
    supplierStateCode && placeOfSupplyStateCode && supplierStateCode !== placeOfSupplyStateCode,
  );
}

/**
 * Pro-rata split of an invoice-level discount over lines (largest-remainder, deterministic: ties go to
 * the earlier line). `basePaise[i]` is the line amount after its own discount. Σ result = discount.
 */
export function allocateInvoiceDiscount(basePaise: number[], discountPaise: number): number[] {
  const total = basePaise.reduce((a, b) => a + b, 0);
  if (discountPaise < 0 || discountPaise > total)
    throw new RangeError("invoice discount exceeds the invoice amount");
  if (discountPaise === 0 || total === 0) return basePaise.map(() => 0);
  const D = BigInt(discountPaise);
  const S = BigInt(total);
  const shares = basePaise.map((b) => (D * BigInt(b)) / S);
  const rems = basePaise.map((b, i) => ({ i, r: (D * BigInt(b)) % S }));
  let left = Number(D - shares.reduce((a, b) => a + b, 0n));
  rems.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rems) {
    if (left <= 0) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left--;
  }
  return shares.map(Number);
}

export type DiscountSpec =
  | { kind: "PERCENT"; percentBp: number }
  | { kind: "AMOUNT"; amountPaise: number };

/** Discount amount for a base (percent rounded half up). Throws when it would exceed the base. */
export function discountAmount(spec: DiscountSpec, basePaise: number): number {
  const amount =
    spec.kind === "PERCENT" ? mulDivRound(basePaise, spec.percentBp, 10_000) : spec.amountPaise;
  if (amount < 0 || amount > basePaise) throw new RangeError("discount exceeds the base amount");
  return amount;
}

export interface InvoiceTotalsInput {
  lines: GstLineInput[];
  taxInclusive: boolean;
  interState: boolean;
  /** Invoice-level discount (percent of Σ line amounts after line discounts, or a fixed amount). */
  invoiceDiscount?: DiscountSpec | null;
}
export interface InvoiceTotals {
  lines: GstLineAmounts[];
  subtotalPaise: number;
  /** Line discounts + invoice-level discount. */
  discountPaise: number;
  invoiceDiscountPaise: number;
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

/**
 * Whole-invoice amounts. Invariant (also a DB CHECK): total = subtotal − discount + (exclusive ? tax : 0).
 * Lines are computed individually (half-up) and summed — never recomputed from totals.
 */
export function computeInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  const bases = input.lines.map((l) => l.quantity * l.unitPricePaise - (l.discountPaise ?? 0));
  const baseSum = bases.reduce((a, b) => a + b, 0);
  const invoiceDiscountPaise = input.invoiceDiscount
    ? discountAmount(input.invoiceDiscount, baseSum)
    : 0;
  const shares = allocateInvoiceDiscount(bases, invoiceDiscountPaise);
  const lines = input.lines.map((l, i) =>
    computeGstLine(l, {
      taxInclusive: input.taxInclusive,
      interState: input.interState,
      allocatedDiscountPaise: shares[i] ?? 0,
    }),
  );
  const sum = (f: (l: GstLineAmounts) => number) => lines.reduce((a, l) => a + f(l), 0);
  const cgstPaise = sum((l) => l.cgstPaise);
  const sgstPaise = sum((l) => l.sgstPaise);
  const igstPaise = sum((l) => l.igstPaise);
  return {
    lines,
    subtotalPaise: sum((l) => l.grossPaise),
    discountPaise: sum((l) => l.discountPaise + l.allocatedDiscountPaise),
    invoiceDiscountPaise,
    taxPaise: cgstPaise + sgstPaise + igstPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalPaise: sum((l) => l.totalPaise),
  };
}

// ---------------------------------------------------------------------------------------------
// Financial year + document numbers (ADR 0004 §2)
// ---------------------------------------------------------------------------------------------

/** Indian financial year (1 Apr – 31 Mar) of an instant in a time zone, as "25-26". */
export function financialYearOf(at: Date, timeZone = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "numeric" })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const start = month >= 4 ? year : year - 1;
  const yy = (n: number) => String(n % 100).padStart(2, "0");
  return `${yy(start)}-${yy(start + 1)}`;
}

/**
 * Number text of a gap-free document. Invoices: "BR1/25-26/000123". Credit notes, debit notes and receipts
 * carry their series: "BR1/CN/25-26/000007". The sequence comes from `allocate_document_seq()` (SQL).
 */
export function formatDocumentNumber(args: {
  branchCode: string;
  financialYear: string;
  seq: number;
  series?: DocumentSeries;
}): string {
  if (!Number.isInteger(args.seq) || args.seq < 1) throw new RangeError("sequence must be >= 1");
  const seq = String(args.seq).padStart(6, "0");
  const series = args.series ?? "INV";
  return series === "INV"
    ? `${args.branchCode}/${args.financialYear}/${seq}`
    : `${args.branchCode}/${series}/${args.financialYear}/${seq}`;
}
/** Invoice number convenience wrapper. */
export const formatInvoiceNumber = (branchCode: string, financialYear: string, seq: number) =>
  formatDocumentNumber({ branchCode, financialYear, seq, series: "INV" });

/** Splits a document number back into its parts (null when it does not match). */
export function parseDocumentNumber(
  n: string,
): { branchCode: string; series: DocumentSeries; financialYear: string; seq: number } | null {
  const m = /^(.+?)\/(?:(CN|DN|RCP)\/)?(\d{2}-\d{2})\/(\d{6,})$/.exec(n);
  if (!m) return null;
  return {
    branchCode: m[1] as string,
    series: (m[2] as DocumentSeries | undefined) ?? "INV",
    financialYear: m[3] as string,
    seq: Number(m[4]),
  };
}

// ---------------------------------------------------------------------------------------------
// Discounts (ADR 0004 §3.5): need discount:apply, a reason, and stay within the role/branch limit
// ---------------------------------------------------------------------------------------------

export const discountInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PERCENT"), percentBp: basisPoints }),
  z.object({ kind: z.literal("AMOUNT"), amountPaise: positivePaise }),
]);
export type DiscountInput = z.infer<typeof discountInput>;

/** Highest discount % (bp) any of the roles may give; roles without an entry get 0. */
export function maxDiscountBpForRoles(
  roles: readonly string[],
  limits: Partial<Record<string, number>>,
): number {
  return roles.reduce((m, r) => Math.max(m, limits[r] ?? 0), 0);
}

export type DiscountCheck =
  | { ok: true; amountPaise: number; percentBp: number }
  | {
      ok: false;
      error:
        | "discount_not_permitted"
        | "discount_reason_required"
        | "discount_exceeds_base"
        | "discount_exceeds_limit";
    };

/**
 * Validates a discount on `basePaise` (the amount before this discount). `canApply` = principal holds
 * discount:apply at the branch; `maxPercentBp` = `maxDiscountBpForRoles(...)`. Returns the amount and the
 * effective percentage (bp, rounded down, for display); the limit itself is compared exactly.
 */
export function checkDiscount(args: {
  discount: DiscountSpec;
  basePaise: number;
  reason: string | null | undefined;
  canApply: boolean;
  maxPercentBp: number;
}): DiscountCheck {
  if (!args.canApply) return { ok: false, error: "discount_not_permitted" };
  if (!args.reason || args.reason.trim().length < 3)
    return { ok: false, error: "discount_reason_required" };
  let amountPaise: number;
  try {
    amountPaise = discountAmount(args.discount, args.basePaise);
  } catch {
    return { ok: false, error: "discount_exceeds_base" };
  }
  const percentBp =
    args.basePaise === 0 ? 0 : Number((BigInt(amountPaise) * 10_000n) / BigInt(args.basePaise));
  // Exact integer comparison (amount / base <= max / 10000): flooring the percentage to bp first would let a
  // discount slightly above the ceiling (e.g. 5.009% against 5%) through.
  if (BigInt(amountPaise) * 10_000n > BigInt(args.maxPercentBp) * BigInt(args.basePaise))
    return { ok: false, error: "discount_exceeds_limit" };
  return { ok: true, amountPaise, percentBp };
}

// ---------------------------------------------------------------------------------------------
// Refund / payment arithmetic (mirrors the DB triggers; the DB is the final authority)
// ---------------------------------------------------------------------------------------------

/** Still refundable on a payment: amount − Σ refunds that are not REJECTED (requests reserve their amount). */
export function refundablePaise(
  paymentAmountPaise: number,
  refunds: ReadonlyArray<{ amountPaise: number; status: RefundStatus }>,
): number {
  const reserved = refunds
    .filter((r) => r.status !== "REJECTED")
    .reduce((a, r) => a + r.amountPaise, 0);
  return Math.max(0, paymentAmountPaise - reserved);
}
/** Refunds above the threshold need approval by a second person with `refund:approve`. */
export const refundNeedsApproval = (amountPaise: number, thresholdPaise: number) =>
  amountPaise > thresholdPaise;
/**
 * Unallocated (advance) part of a payment: amount − Σ PROCESSED refunds − Σ REQUESTED/APPROVED advance refunds
 * (invoiceId NULL: they reserve their amount, exactly like `allocation_guard`) − Σ allocations (net of reversals).
 */
export function unallocatedPaise(
  paymentAmountPaise: number,
  processedRefundsPaise: number,
  netAllocatedPaise: number,
  pendingAdvanceRefundsPaise = 0,
): number {
  return (
    paymentAmountPaise - processedRefundsPaise - pendingAdvanceRefundsPaise - netAllocatedPaise
  );
}

// ---------------------------------------------------------------------------------------------
// Settings knobs: Tenant.settings.billing / Branch.settings.billing (ADR 0004 §10)
// ---------------------------------------------------------------------------------------------

/** Default discount ceilings (bp) by role: owner unlimited, manager 20%, accountant 10%, reception 5%. */
export const DEFAULT_DISCOUNT_LIMITS_BP: Readonly<Record<string, number>> = {
  OWNER: 10_000,
  MANAGER: 2_000,
  ACCOUNTANT: 1_000,
  RECEPTIONIST: 500,
  DENTIST: 0,
};
/** Refunds above ₹5,000 need approval by default. */
export const DEFAULT_REFUND_APPROVAL_THRESHOLD_PAISE = 500_000;
export const DEFAULT_GST_RATE_BP = 1_800;

const discountLimitsBp = z.partialRecord(staffRole, basisPoints);

/** Tenant-wide billing knobs. Unknown keys rejected. */
export const tenantBillingSettings = z.strictObject({
  /** Line prices include GST (default false = GST added on top). Frozen on each invoice. */
  taxInclusive: z.boolean().optional(),
  /** Supplier state code used for place of supply (a branch may override). */
  stateCode: gstStateCode.optional(),
  /** GST rate for taxable services that have no `gstRateBp` of their own. */
  defaultGstRateBp: basisPoints.optional(),
  /** Days from issue to due date (0 = due on issue). */
  invoiceDueDays: z.number().int().min(0).max(365).optional(),
  discountLimitsBp: discountLimitsBp.optional(),
  /** Refunds above this need approval (paise). */
  refundApprovalThresholdPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  /** The approver of a refund / settlement must differ from the requester / creator. */
  separateApprover: z.boolean().optional(),
  /** Accept more than the invoice balance: the rest becomes patient advance. */
  allowAdvancePayments: z.boolean().optional(),
  allowedPaymentMethods: z.array(paymentMethod).min(1).optional(),
  /** Online payments provider; MANUAL = staff record payments only. */
  gatewayProvider: z.enum(GATEWAY_PROVIDERS).optional(),
});
export type TenantBillingSettings = z.infer<typeof tenantBillingSettings>;

/** Branch overrides (every key optional; absent = inherit the tenant value). */
export const branchBillingSettings = z.strictObject({
  gstin: gstin.optional(),
  stateCode: gstStateCode.optional(),
  taxInclusive: z.boolean().optional(),
  invoiceDueDays: z.number().int().min(0).max(365).optional(),
  discountLimitsBp: discountLimitsBp.optional(),
  refundApprovalThresholdPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  allowedPaymentMethods: z.array(paymentMethod).min(1).optional(),
});
export type BranchBillingSettings = z.infer<typeof branchBillingSettings>;

export interface ResolvedBillingSettings {
  taxInclusive: boolean;
  stateCode: string | null;
  gstin: string | null;
  defaultGstRateBp: number;
  invoiceDueDays: number;
  discountLimitsBp: Record<string, number>;
  refundApprovalThresholdPaise: number;
  separateApprover: boolean;
  allowAdvancePayments: boolean;
  allowedPaymentMethods: PaymentMethod[];
  gatewayProvider: GatewayProvider;
}

/**
 * Effective billing knobs: branch override > tenant setting > default. `rawTenantSettings` /
 * `rawBranchSettings` are the raw JSON columns; invalid sections are ignored (defaults), never thrown.
 * The tenant GSTIN is `Tenant.settings.gstin` (M1); a branch GSTIN overrides it.
 */
export function resolveBillingSettings(
  rawTenantSettings: unknown,
  rawBranchSettings?: unknown,
): ResolvedBillingSettings {
  const section = (raw: unknown) =>
    raw && typeof raw === "object" ? (raw as { billing?: unknown }).billing : undefined;
  const t = tenantBillingSettings.safeParse(section(rawTenantSettings) ?? {}).data ?? {};
  const b = branchBillingSettings.safeParse(section(rawBranchSettings) ?? {}).data ?? {};
  const tenantGstin =
    rawTenantSettings && typeof rawTenantSettings === "object"
      ? ((rawTenantSettings as { gstin?: unknown }).gstin as string | undefined)
      : undefined;
  return {
    taxInclusive: b.taxInclusive ?? t.taxInclusive ?? false,
    stateCode: b.stateCode ?? t.stateCode ?? null,
    gstin: b.gstin ?? tenantGstin ?? null,
    defaultGstRateBp: t.defaultGstRateBp ?? DEFAULT_GST_RATE_BP,
    invoiceDueDays: b.invoiceDueDays ?? t.invoiceDueDays ?? 0,
    discountLimitsBp: {
      ...DEFAULT_DISCOUNT_LIMITS_BP,
      ...(t.discountLimitsBp ?? {}),
      ...(b.discountLimitsBp ?? {}),
    },
    refundApprovalThresholdPaise:
      b.refundApprovalThresholdPaise ??
      t.refundApprovalThresholdPaise ??
      DEFAULT_REFUND_APPROVAL_THRESHOLD_PAISE,
    separateApprover: t.separateApprover ?? true,
    allowAdvancePayments: t.allowAdvancePayments ?? true,
    allowedPaymentMethods: b.allowedPaymentMethods ??
      t.allowedPaymentMethods ?? [...PAYMENT_METHODS],
    gatewayProvider: t.gatewayProvider ?? "MANUAL",
  };
}

/** GST rate (bp) for one line: not taxable -> 0; else the service's rate, else the tenant default. */
export function lineTaxRateBp(
  service: { taxable: boolean; gstRateBp: number | null } | null | undefined,
  defaultGstRateBp: number,
): number {
  if (!service || !service.taxable) return 0;
  return service.gstRateBp ?? defaultGstRateBp;
}

/** PATCH /billing/settings. Scope = tenant, or one branch when `branchId` is given. No defaults. */
export const updateTenantBillingSettingsRequest = tenantBillingSettings;
export const updateBranchBillingSettingsRequest = branchBillingSettings;
export const billingSettingsQuery = z.object({ branchId: uuid.optional() });
export const billingSettingsResponse = z.object({
  branchId: uuid.nullable(),
  /** What is stored at this scope (tenant or branch). */
  stored: z.record(z.string(), z.unknown()),
  /** Effective values after inheritance + defaults. */
  effective: z.object({
    taxInclusive: z.boolean(),
    stateCode: z.string().nullable(),
    gstin: z.string().nullable(),
    defaultGstRateBp: z.number().int(),
    invoiceDueDays: z.number().int(),
    discountLimitsBp: z.record(z.string(), z.number().int()),
    refundApprovalThresholdPaise: z.number().int(),
    separateApprover: z.boolean(),
    allowAdvancePayments: z.boolean(),
    allowedPaymentMethods: z.array(paymentMethod),
    gatewayProvider: z.enum(GATEWAY_PROVIDERS),
  }),
});
export type BillingSettingsResponse = z.infer<typeof billingSettingsResponse>;

/** Service GST classification (HSN/SAC + rate). Stored on Service.hsnSac / gstRateBp. */
export const updateServiceTaxProfileRequest = z.object({
  hsnSac: hsnSac.nullable().optional(),
  gstRateBp: basisPoints.nullable().optional(),
});
export type UpdateServiceTaxProfileRequest = z.infer<typeof updateServiceTaxProfileRequest>;
export const serviceTaxProfileResponse = z.object({
  serviceId: uuid,
  code: z.string(),
  name: z.string(),
  taxable: z.boolean(),
  hsnSac: z.string().nullable(),
  gstRateBp: z.number().int().nullable(),
});
export type ServiceTaxProfileResponse = z.infer<typeof serviceTaxProfileResponse>;

// ---------------------------------------------------------------------------------------------
// Estimates (plan items with frozen prices — distinct from invoices, PRD 4.6)
// ---------------------------------------------------------------------------------------------

export const estimateQuery = z.object({
  planId: uuid,
  /** Default: the plan's current version. */
  planVersion: z.coerce.number().int().min(1).optional(),
});
export type EstimateQuery = z.infer<typeof estimateQuery>;

export const estimateLineResponse = z.object({
  planItemId: uuid,
  serviceId: uuid,
  description: z.string(),
  toothCode: z.number().int().nullable(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
  grossPaise: z.number().int(),
  taxRateBp: z.number().int(),
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
  status: z.string(),
  billed: z.boolean(),
});
export const estimateResponse = z.object({
  planId: uuid,
  planVersion: z.number().int(),
  patientId: uuid,
  branchId: uuid,
  taxInclusive: z.boolean(),
  lines: z.array(estimateLineResponse),
  subtotalPaise: z.number().int(),
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
});
export type EstimateResponse = z.infer<typeof estimateResponse>;

// ---------------------------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------------------------

/**
 * One line of a draft. With `serviceId` and no `unitPricePaise` the server prices it from the catalogue
 * (branch effective price, `catalog/pricing.ts`); plan-item lines are billed at the plan's frozen estimate price;
 * only AD HOC lines (no serviceId, no planItemId) carry a caller-set `unitPricePaise` and `description`. Changing
 * the price of a catalogue or plan line is a discount: use `discount` (needs discount:apply, a reason, the role
 * limit, and is audited) — never an edited unit price (ADR 0004 §3.5).
 */
export const invoiceLineInput = z
  .object({
    serviceId: uuid.optional(),
    description: trimmed(300).optional(),
    quantity: z.number().int().min(1).max(10_000).default(1),
    unitPricePaise: z.number().int().min(0).max(1_000_000_000).optional(),
    discount: discountInput.optional(),
    discountReason: reasonText.optional(),
    planItemId: uuid.optional(),
    procedureRecordId: uuid.optional(),
    encounterId: uuid.optional(),
    /** Attribution (PRD 2.5). Defaults to the procedure's / encounter's treating dentist. */
    dentistUserId: z.string().trim().min(1).max(200).optional(),
    toothCode: z.number().int().min(11).max(85).optional(),
  })
  .refine(
    (l) =>
      l.serviceId !== undefined ||
      l.planItemId !== undefined ||
      (l.description && l.unitPricePaise !== undefined),
    { message: "Provide serviceId or planItemId, or description and unitPricePaise" },
  )
  .refine(
    (l) =>
      l.unitPricePaise === undefined || (l.serviceId === undefined && l.planItemId === undefined),
    {
      message:
        "Catalogue and plan lines are priced by the server; use a discount (discount:apply + reason) to reduce the price",
      path: ["unitPricePaise"],
    },
  )
  .refine((l) => l.discount === undefined || l.discountReason !== undefined, {
    message: "A discount needs discountReason",
    path: ["discountReason"],
  });
export type InvoiceLineInput = z.infer<typeof invoiceLineInput>;

/** True when a line may carry / change a caller-set unit price (ad hoc lines only). Services check it on PATCH. */
export const isAdHocLine = (l: { serviceId?: string | null; planItemId?: string | null }) =>
  !l.serviceId && !l.planItemId;

/**
 * PATCH of a draft line: every field optional, `quantity` has no default. `unitPricePaise` is accepted only for an
 * AD HOC line (`isAdHocLine`): the service answers 400 `price_override_not_allowed` for a catalogue / plan line.
 */
export const updateInvoiceLineRequest = z.object({
  description: trimmed(300).optional(),
  quantity: z.number().int().min(1).max(10_000).optional(),
  unitPricePaise: z.number().int().min(0).max(1_000_000_000).optional(),
  discount: discountInput.nullable().optional(),
  discountReason: reasonText.nullable().optional(),
  dentistUserId: z.string().trim().min(1).max(200).nullable().optional(),
  toothCode: z.number().int().min(11).max(85).nullable().optional(),
});
export type UpdateInvoiceLineRequest = z.infer<typeof updateInvoiceLineRequest>;

export const createInvoiceRequest = z.object({
  patientId: uuid,
  branchId: uuid,
  encounterId: uuid.optional(),
  planId: uuid.optional(),
  dueDate: dateOnly.optional(),
  /** Default: stateCode of the branch. */
  placeOfSupplyStateCode: gstStateCode.optional(),
  /** Not settable here: `taxInclusive` is frozen at creation from the effective billing.taxInclusive knob (ADR §3.2). */
  notes: optionalText(1000),
  lines: z.array(invoiceLineInput).max(200).optional(),
  /** Invoice-level discount (needs discount:apply + reason). */
  invoiceDiscount: discountInput.optional(),
  discountReason: reasonText.optional(),
});
export type CreateInvoiceRequest = z.infer<typeof createInvoiceRequest>;

/**
 * Invoice from accepted / completed plan items at the plan's frozen estimate (plan version recorded on the
 * invoice). `planItemIds` omitted = every ACCEPTED/SCHEDULED/IN_PROGRESS/COMPLETED item not yet billed.
 */
export const createInvoiceFromPlanRequest = z.object({
  planId: uuid,
  planItemIds: z.array(uuid).min(1).max(200).optional(),
  encounterId: uuid.optional(),
  dueDate: dateOnly.optional(),
  placeOfSupplyStateCode: gstStateCode.optional(),
  notes: optionalText(1000),
});
export type CreateInvoiceFromPlanRequest = z.infer<typeof createInvoiceFromPlanRequest>;

/** PATCH of a DRAFT header (no defaults; nullable clears). */
export const updateInvoiceRequest = z.object({
  dueDate: dateOnly.nullable().optional(),
  placeOfSupplyStateCode: gstStateCode.nullable().optional(),
  notes: optionalText(1000).nullable(),
});
export type UpdateInvoiceRequest = z.infer<typeof updateInvoiceRequest>;

/** Sets (or clears with `discount: null`) the invoice-level discount of a DRAFT. */
export const setInvoiceDiscountRequest = z.object({
  discount: discountInput.nullable(),
  reason: reasonText.optional(),
});
export type SetInvoiceDiscountRequest = z.infer<typeof setInvoiceDiscountRequest>;

/** Issuing assigns the gap-free number and freezes lines and amounts. */
export const issueInvoiceRequest = z.object({
  /** Default: issue date + invoiceDueDays. */
  dueDate: dateOnly.optional(),
});
export type IssueInvoiceRequest = z.infer<typeof issueInvoiceRequest>;

/** Only a DRAFT or an unpaid, unadjusted ISSUED invoice can be voided. */
export const voidInvoiceRequest = z.object({ reason: reasonText });
export type VoidInvoiceRequest = z.infer<typeof voidInvoiceRequest>;

export const listInvoicesQuery = pageQuery.extend({
  branchId: uuid.optional(),
  patientId: uuid.optional(),
  planId: uuid.optional(),
  status: invoiceStatus.optional(),
  /** Matches the invoice number (prefix). */
  q: z.string().trim().max(60).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  /** Only invoices past their due date with a balance. */
  overdue: z.stringbool().optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuery>;

export const invoiceLineResponse = z.object({
  id: uuid,
  lineNo: z.number().int(),
  serviceId: uuid.nullable(),
  serviceCategoryId: uuid.nullable(),
  description: z.string(),
  hsnSac: z.string().nullable(),
  quantity: z.number().int(),
  unitPricePaise: z.number().int(),
  grossPaise: z.number().int(),
  discountPaise: z.number().int(),
  discountReason: z.string().nullable(),
  allocatedDiscountPaise: z.number().int(),
  taxableValuePaise: z.number().int(),
  taxRateBp: z.number().int(),
  cgstPaise: z.number().int(),
  sgstPaise: z.number().int(),
  igstPaise: z.number().int(),
  totalPaise: z.number().int(),
  planItemId: uuid.nullable(),
  procedureRecordId: uuid.nullable(),
  encounterId: uuid.nullable(),
  dentistUserId: z.string().nullable(),
  toothCode: z.number().int().nullable(),
});
export type InvoiceLineResponse = z.infer<typeof invoiceLineResponse>;

export const invoiceSummary = z.object({
  id: uuid,
  number: z.string().nullable(),
  status: invoiceStatus,
  branchId: uuid,
  patientId: uuid,
  patientName: z.string().optional(),
  issuedAt: isoDateTime.nullable(),
  dueDate: dateOnly.nullable(),
  currency: z.literal("INR"),
  totalPaise: z.number().int(),
  adjustmentPaise: z.number().int(),
  paidPaise: z.number().int(),
  balancePaise: z.number().int(),
  planId: uuid.nullable(),
  createdAt: isoDateTime,
});
export type InvoiceSummary = z.infer<typeof invoiceSummary>;

export const invoiceResponse = invoiceSummary.extend({
  taxInclusive: z.boolean(),
  supplierGstin: z.string().nullable(),
  supplierStateCode: z.string().nullable(),
  placeOfSupplyStateCode: z.string().nullable(),
  subtotalPaise: z.number().int(),
  discountPaise: z.number().int(),
  invoiceDiscountPaise: z.number().int(),
  invoiceDiscountPercentBp: z.number().int().nullable(),
  discountReason: z.string().nullable(),
  taxPaise: z.number().int(),
  planVersion: z.number().int().nullable(),
  encounterId: uuid.nullable(),
  notes: z.string().nullable(),
  issuedBy: z.string().nullable(),
  voidReason: z.string().nullable(),
  voidedBy: z.string().nullable(),
  voidedAt: isoDateTime.nullable(),
  createdBy: z.string(),
});
export type InvoiceResponse = z.infer<typeof invoiceResponse>;

export const paymentAllocationResponse = z.object({
  id: uuid,
  paymentId: uuid,
  invoiceId: uuid,
  amountPaise: z.number().int(),
  refundId: uuid.nullable(),
  allocatedBy: z.string(),
  createdAt: isoDateTime,
});
export type PaymentAllocationResponse = z.infer<typeof paymentAllocationResponse>;

export const adjustmentResponse = z.object({
  id: uuid,
  invoiceId: uuid,
  branchId: uuid,
  kind: adjustmentKind,
  number: z.string(),
  amountPaise: z.number().int(),
  taxPaise: z.number().int(),
  reason: z.string(),
  issuedBy: z.string(),
  issuedAt: isoDateTime,
});
export type AdjustmentResponse = z.infer<typeof adjustmentResponse>;

export const invoiceDetailResponse = invoiceResponse.extend({
  lines: z.array(invoiceLineResponse),
  allocations: z.array(paymentAllocationResponse),
  adjustments: z.array(adjustmentResponse),
});
export type InvoiceDetailResponse = z.infer<typeof invoiceDetailResponse>;

/** GST summary row for printing (grouped by HSN/SAC + rate). */
export const taxSummaryRow = z.object({
  hsnSac: z.string().nullable(),
  taxRateBp: z.number().int(),
  taxableValuePaise: z.number().int(),
  cgstPaise: z.number().int(),
  sgstPaise: z.number().int(),
  igstPaise: z.number().int(),
});

/**
 * GET /invoices/:id/print — everything a printable tax invoice needs (no PDF in M3; the UI prints HTML).
 * Supplier/patient blocks hold display data only; `amountInWords` comes from `amountInWordsINR`.
 */
export const invoicePrintResponse = z.object({
  invoice: invoiceDetailResponse,
  supplier: z.object({
    name: z.string(),
    branchName: z.string(),
    branchCode: z.string(),
    gstin: z.string().nullable(),
    stateCode: z.string().nullable(),
    addressLines: z.array(z.string()),
    phone: z.string().nullable(),
  }),
  patient: z.object({ name: z.string(), phone: z.string().nullable(), mrn: z.string().nullable() }),
  taxSummary: z.array(taxSummaryRow),
  amountInWords: z.string(),
  /** "ORIGINAL" for the first print; reprints are marked DUPLICATE by the UI. */
  copy: z.enum(["ORIGINAL", "DUPLICATE"]),
});
export type InvoicePrintResponse = z.infer<typeof invoicePrintResponse>;

/** Groups lines by (HSN/SAC, rate) for the tax summary of a printed invoice. */
export function summarizeTax(
  lines: ReadonlyArray<{
    hsnSac: string | null;
    taxRateBp: number;
    taxableValuePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
  }>,
): z.infer<typeof taxSummaryRow>[] {
  const map = new Map<string, z.infer<typeof taxSummaryRow>>();
  for (const l of lines) {
    const key = `${l.hsnSac ?? ""}|${l.taxRateBp}`;
    const row = map.get(key) ?? {
      hsnSac: l.hsnSac,
      taxRateBp: l.taxRateBp,
      taxableValuePaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 0,
    };
    row.taxableValuePaise += l.taxableValuePaise;
    row.cgstPaise += l.cgstPaise;
    row.sgstPaise += l.sgstPaise;
    row.igstPaise += l.igstPaise;
    map.set(key, row);
  }
  return [...map.values()];
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below1000(value: number): string {
  const parts: string[] = [];
  let n = value;
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)] as string);
    if (n % 10) parts.push(ONES[n % 10] as string);
  } else if (n > 0) {
    parts.push(ONES[n] as string);
  }
  return parts.join(" ");
}
/** "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only". */
export function amountInWordsINR(amountPaise: number): string {
  if (!Number.isInteger(amountPaise) || amountPaise < 0)
    throw new RangeError("amount must be a non-negative integer");
  const rupees = Math.floor(amountPaise / 100);
  const paisa = amountPaise % 100;
  const units: Array<[number, string]> = [
    [10_000_000, "Crore"],
    [100_000, "Lakh"],
    [1000, "Thousand"],
  ];
  let rest = rupees;
  const words: string[] = [];
  for (const [size, label] of units) {
    if (rest >= size) {
      words.push(`${below1000(Math.floor(rest / size))} ${label}`);
      rest %= size;
    }
  }
  if (rest > 0) words.push(below1000(rest));
  const rupeeText = words.length ? words.join(" ") : "Zero";
  const paiseText = paisa ? ` and ${below1000(paisa)} Paise` : "";
  return `Rupees ${rupeeText}${paiseText} Only`;
}

// ---------------------------------------------------------------------------------------------
// Payments (append-only), allocations, gateway
// ---------------------------------------------------------------------------------------------

const allocationInput = z.object({ invoiceId: uuid, amountPaise: positivePaise });

/** https, or http on a loopback host (local development). Rejects javascript:, data:, ftp: and plain http. */
export const isSafeReturnUrl = (value: string) => {
  try {
    const u = new URL(value);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
};

/** Luhn check (card numbers). */
const luhnValid = (digits: string) => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};
/** A payment reference must not be (or contain only) a full card number: 12-19 digits passing Luhn. */
export const looksLikeCardNumber = (v: string) => {
  const digits = v.replace(/[\s-]/g, "");
  return /^[0-9]{12,19}$/.test(digits) && luhnValid(digits);
};
const paymentReference = z
  .string()
  .trim()
  .max(100)
  .refine((v) => !looksLikeCardNumber(v), "Never store a full card number; use the last 4 digits");
const RECEIVED_AT_FUTURE_SKEW_MS = 5 * 60_000;
const RECEIVED_AT_MAX_AGE_MS = 400 * 86_400_000;
const isPlausibleReceivedAt = (v: string) => {
  const t = Date.parse(v);
  const now = Date.now();
  return (
    Number.isFinite(t) && t <= now + RECEIVED_AT_FUTURE_SKEW_MS && t >= now - RECEIVED_AT_MAX_AGE_MS
  );
};

/**
 * Records money received. `allocations` apply it to invoices of the same patient AND branch; whatever is not
 * allocated becomes patient advance (when `allowAdvancePayments`). `idempotencyKey` is required: replaying the
 * same key returns the original payment (409 idempotency_conflict if the body differs). Never trust a
 * client-side success flag for online payments — those are confirmed by the gateway webhook only.
 */
export const recordPaymentRequest = z.object({
  patientId: uuid,
  branchId: uuid,
  method: paymentMethod,
  amountPaise: positivePaise,
  /** UPI txn id, cheque number, card last-4 + auth code, bank reference. Never full card numbers (rejected). */
  reference: paymentReference.optional(),
  /**
   * Default: now. Not more than 5 minutes in the future and not older than 400 days (it drives the receipt's
   * financial year; the service additionally refuses a date in a closed period).
   */
  receivedAt: isoDateTime
    .refine(isPlausibleReceivedAt, "receivedAt must be recent and not in the future")
    .optional(),
  notes: optionalText(500),
  idempotencyKey,
  allocations: z.array(allocationInput).max(50).optional(),
  /** When no explicit allocations: apply to the patient's outstanding invoices at this branch, oldest first. */
  autoAllocate: z.boolean().optional(),
});
export type RecordPaymentRequest = z.infer<typeof recordPaymentRequest>;

/** Allocate the still-unallocated part of a RECORDED payment to invoices. */
export const allocatePaymentRequest = z.object({
  allocations: z.array(allocationInput).min(1).max(50),
  idempotencyKey,
});
export type AllocatePaymentRequest = z.infer<typeof allocatePaymentRequest>;

/** Spend the patient's advance on an invoice (the service picks the source payments, oldest first). */
export const applyAdvanceRequest = z.object({
  invoiceId: uuid,
  amountPaise: positivePaise,
  idempotencyKey,
});
export type ApplyAdvanceRequest = z.infer<typeof applyAdvanceRequest>;

export const listPaymentsQuery = pageQuery.extend({
  branchId: uuid.optional(),
  patientId: uuid.optional(),
  method: paymentMethod.optional(),
  status: paymentStatus.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  /** Only payments with an unallocated (advance) remainder. */
  hasAdvance: z.stringbool().optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuery>;

export const paymentResponse = z.object({
  id: uuid,
  branchId: uuid,
  patientId: uuid,
  method: paymentMethod,
  amountPaise: z.number().int(),
  reference: z.string().nullable(),
  receivedAt: isoDateTime,
  receivedBy: z.string(),
  gateway: z.string(),
  gatewayRef: z.string().nullable(),
  status: paymentStatus,
  receiptNumber: z.string().nullable(),
  notes: z.string().nullable(),
  allocatedPaise: z.number().int(),
  refundedPaise: z.number().int(),
  /** amount − processed refunds − net allocations (patient advance still on this payment). */
  unallocatedPaise: z.number().int(),
  createdAt: isoDateTime,
});
export type PaymentResponse = z.infer<typeof paymentResponse>;

export const refundResponse = z.object({
  id: uuid,
  branchId: uuid,
  patientId: uuid,
  paymentId: uuid,
  invoiceId: uuid.nullable(),
  amountPaise: z.number().int(),
  method: paymentMethod,
  reference: z.string().nullable(),
  reason: z.string(),
  status: refundStatus,
  requestedBy: z.string(),
  requestedAt: isoDateTime,
  approvedBy: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  rejectedBy: z.string().nullable(),
  rejectedAt: isoDateTime.nullable(),
  rejectionReason: z.string().nullable(),
  processedBy: z.string().nullable(),
  processedAt: isoDateTime.nullable(),
  gateway: z.string(),
  gatewayRef: z.string().nullable(),
  createdAt: isoDateTime,
});
export type RefundResponse = z.infer<typeof refundResponse>;

export const paymentDetailResponse = paymentResponse.extend({
  allocations: z.array(paymentAllocationResponse),
  refunds: z.array(refundResponse),
});
export type PaymentDetailResponse = z.infer<typeof paymentDetailResponse>;

/** POST /payments/gateway/checkout — starts an online payment (PENDING until the webhook confirms). */
export const createGatewayCheckoutRequest = z.object({
  patientId: uuid,
  branchId: uuid,
  amountPaise: positivePaise,
  /** Invoices the money is meant for (allocated automatically once the payment is RECORDED). */
  invoiceIds: z.array(uuid).max(20).optional(),
  idempotencyKey,
  /** https only (http solely for localhost in development); the service also checks the origin against config. */
  returnUrl: z
    .url()
    .max(500)
    .refine((u) => isSafeReturnUrl(u), "returnUrl must be an https URL")
    .optional(),
});
export type CreateGatewayCheckoutRequest = z.infer<typeof createGatewayCheckoutRequest>;
export const gatewayCheckoutResponse = z.object({
  paymentId: uuid,
  gateway: z.string(),
  status: paymentStatus,
  gatewayRef: z.string(),
  /** Stub gateway: a fake checkout page. A real gateway returns its hosted checkout. */
  checkoutUrl: z.string(),
  expiresAt: isoDateTime,
});
export type GatewayCheckoutResponse = z.infer<typeof gatewayCheckoutResponse>;

/** Webhook transport (ADR 0004 §5): header `X-DentalOS-Signature: t=<unix seconds>,v1=<hex hmac-sha256>`. */
export const GATEWAY_SIGNATURE_HEADER = "x-dentalos-signature";
export const GATEWAY_WEBHOOK_TOLERANCE_SECONDS = 300;
const webhookBase = {
  /** Provider event id — the idempotency key of webhook processing. */
  eventId: z.string().trim().min(1).max(200),
  /** `Payment.gatewayRef` / `Refund.gatewayRef`. */
  gatewayRef: z.string().trim().min(1).max(200),
  occurredAt: isoDateTime,
};
/** The amount is REQUIRED for success events: the service checks it against the PENDING payment / refund (ADR §5). */
export const gatewayWebhookPayload = z.discriminatedUnion("type", [
  z.object({ ...webhookBase, type: z.literal("payment.succeeded"), amountPaise: positivePaise }),
  z.object({
    ...webhookBase,
    type: z.literal("payment.failed"),
    failureCode: z.string().trim().min(1).max(100),
    amountPaise: positivePaise.optional(),
  }),
  z.object({ ...webhookBase, type: z.literal("refund.processed"), amountPaise: positivePaise }),
]);
export type GatewayWebhookPayload = z.infer<typeof gatewayWebhookPayload>;

/** Parses "t=1700000000,v1=abc,v1=def" (several v1 allow secret rotation). */
export function parseWebhookSignatureHeader(
  header: string | null | undefined,
): { timestamp: number; signatures: string[] } | null {
  if (!header) return null;
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v) timestamp = Number(v);
    else if (k === "v1" && v) signatures.push(v);
  }
  return Number.isInteger(timestamp) && signatures.length > 0 ? { timestamp, signatures } : null;
}
/** Rejects replayed webhooks: the signed timestamp must be within the tolerance of `nowSeconds`. */
export const isWebhookTimestampFresh = (
  timestamp: number,
  nowSeconds: number,
  toleranceSeconds = GATEWAY_WEBHOOK_TOLERANCE_SECONDS,
) => Math.abs(nowSeconds - timestamp) <= toleranceSeconds;

// ---------------------------------------------------------------------------------------------
// Refunds (ADR 0004 §4)
// ---------------------------------------------------------------------------------------------

/**
 * Requests a refund of (part of) a payment. `invoiceId` set = the money came from that invoice's allocation:
 * processing reopens its balance (negative allocation). Without it the refund comes out of the payment's
 * unallocated advance. At or below the approval threshold the refund is auto-approved; above it a different
 * user with `refund:approve` must approve it.
 */
export const requestRefundRequest = z.object({
  paymentId: uuid,
  invoiceId: uuid.optional(),
  amountPaise: positivePaise,
  /** Default: the payment's method. */
  method: paymentMethod.optional(),
  reason: reasonText,
  idempotencyKey,
});
export type RequestRefundRequest = z.infer<typeof requestRefundRequest>;
export const approveRefundRequest = z.object({ note: optionalText(500) });
export type ApproveRefundRequest = z.infer<typeof approveRefundRequest>;
export const rejectRefundRequest = z.object({ reason: reasonText });
export type RejectRefundRequest = z.infer<typeof rejectRefundRequest>;
/** Marks the money as returned (cash handed back, bank transfer sent, gateway refund confirmed). */
export const processRefundRequest = z.object({
  reference: z.string().trim().max(100).optional(),
  method: paymentMethod.optional(),
});
export type ProcessRefundRequest = z.infer<typeof processRefundRequest>;
export const listRefundsQuery = pageQuery.extend({
  branchId: uuid.optional(),
  patientId: uuid.optional(),
  paymentId: uuid.optional(),
  status: refundStatus.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListRefundsQuery = z.infer<typeof listRefundsQuery>;

// ---------------------------------------------------------------------------------------------
// Credit / debit notes (the only way to correct an issued invoice)
// ---------------------------------------------------------------------------------------------

/**
 * Issues a credit note (reduces what the patient owes) or a debit note (increases it) against an ISSUED /
 * PARTIALLY_PAID / PAID invoice. A credit note cannot exceed the current balance (refund first, then credit).
 * `amountPaise` is tax-inclusive; `taxPaise` is the GST part for reporting (0 when exempt).
 */
export const issueAdjustmentRequest = z.object({
  kind: adjustmentKind,
  amountPaise: positivePaise,
  taxPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  reason: reasonText,
  idempotencyKey,
});
export type IssueAdjustmentRequest = z.infer<typeof issueAdjustmentRequest>;
export const listAdjustmentsQuery = pageQuery.extend({
  branchId: uuid.optional(),
  patientId: uuid.optional(),
  invoiceId: uuid.optional(),
  kind: adjustmentKind.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListAdjustmentsQuery = z.infer<typeof listAdjustmentsQuery>;

// ---------------------------------------------------------------------------------------------
// Patient credit (advance) and account statement
// ---------------------------------------------------------------------------------------------

export const creditEntryResponse = z.object({
  id: uuid,
  patientId: uuid,
  branchId: uuid,
  kind: creditEntryKind,
  amountPaise: z.number().int(),
  paymentId: uuid.nullable(),
  allocationId: uuid.nullable(),
  refundId: uuid.nullable(),
  reason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
});
export type CreditEntryResponse = z.infer<typeof creditEntryResponse>;
export const patientCreditResponse = z.object({
  patientId: uuid,
  balancePaise: z.number().int(),
  entries: z.array(creditEntryResponse),
});
export type PatientCreditResponse = z.infer<typeof patientCreditResponse>;
export const patientCreditQuery = pageQuery;
/** Manual correction of the advance balance (finance:report-level trust; reason required, audited). */
export const adjustPatientCreditRequest = z.object({
  amountPaise: z
    .number()
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((n) => n !== 0, "Amount must not be zero"),
  branchId: uuid,
  reason: reasonText,
  idempotencyKey,
});
export type AdjustPatientCreditRequest = z.infer<typeof adjustPatientCreditRequest>;

export const ledgerEntryResponse = z.object({
  id: uuid,
  branchId: uuid,
  patientId: uuid,
  kind: ledgerEntryKind,
  /** Effect on what the patient owes: INVOICE +, VOID −, PAYMENT −, REFUND +, CREDIT_NOTE −, DEBIT_NOTE +. */
  amountPaise: z.number().int(),
  invoiceId: uuid.nullable(),
  paymentId: uuid.nullable(),
  refundId: uuid.nullable(),
  adjustmentId: uuid.nullable(),
  occurredAt: isoDateTime,
  createdBy: z.string(),
});
export type LedgerEntryResponse = z.infer<typeof ledgerEntryResponse>;

export const patientStatementQuery = z.object({
  patientId: uuid,
  branchId: uuid.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type PatientStatementQuery = z.infer<typeof patientStatementQuery>;
export const patientStatementResponse = z.object({
  patientId: uuid,
  from: dateOnly.nullable(),
  to: dateOnly.nullable(),
  /** Σ ledger before `from` (positive = patient owes). */
  openingBalancePaise: z.number().int(),
  entries: z.array(ledgerEntryResponse.extend({ runningBalancePaise: z.number().int() })),
  closingBalancePaise: z.number().int(),
  outstandingInvoices: z.array(invoiceSummary),
  advanceBalancePaise: z.number().int(),
});
export type PatientStatementResponse = z.infer<typeof patientStatementResponse>;

// ---------------------------------------------------------------------------------------------
// Finance reporting (finance:report)
// ---------------------------------------------------------------------------------------------

export const REVENUE_GROUPS = ["branch", "dentist", "method", "day"] as const;
export const revenueReportQuery = z.object({
  /** Omitted = every branch in the principal's scope (org-wide for orgWide principals). */
  branchId: uuid.optional(),
  from: dateOnly,
  to: dateOnly,
  groupBy: z.enum(REVENUE_GROUPS).default("branch"),
});
export type RevenueReportQuery = z.infer<typeof revenueReportQuery>;
export const revenueReportRow = z.object({
  key: z.string(),
  label: z.string().nullable(),
  billedPaise: z.number().int(),
  discountPaise: z.number().int(),
  taxPaise: z.number().int(),
  collectedPaise: z.number().int(),
  refundedPaise: z.number().int(),
  netCollectedPaise: z.number().int(),
  outstandingPaise: z.number().int(),
});
export const revenueReportResponse = z.object({
  from: dateOnly,
  to: dateOnly,
  groupBy: z.enum(REVENUE_GROUPS),
  rows: z.array(revenueReportRow),
  totals: revenueReportRow.omit({ key: true, label: true }),
});
export type RevenueReportResponse = z.infer<typeof revenueReportResponse>;
