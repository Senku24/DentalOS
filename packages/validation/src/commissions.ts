import { z } from "zod";
import { basisPoints, idempotencyKey, mulDivRound } from "./billing";
import { dateOnly, isoDateTime, optionalText, pageQuery, staffUserId, uuid } from "./common";
import { type TransitionTable, canTransition } from "./state-machine";

// Dentist compensation: commission rules, ledger, settlements, statements (PRD 4.6, 2.5).
// Rules: docs/adr/0004-business-operations-rules.md §7 (PROPOSED — needs product sign-off; the PRD
// requires an explicit configuration specification before commission calculations are released).
// Never silently change a historical commission basis: rules are effective-dated and immutable (only
// closed), entries are an append-only ledger, attribution is copied from the invoice line and never rewritten.

export const COMMISSION_RULE_TYPES = [
  "PERCENT_OF_COLLECTED",
  "PERCENT_OF_BILLED",
  "FIXED_PER_PROCEDURE",
] as const;
export type CommissionRuleType = (typeof COMMISSION_RULE_TYPES)[number];
export const COMMISSION_ENTRY_KINDS = ["ACCRUAL", "REVERSAL", "ADJUSTMENT", "SETTLEMENT"] as const;
export type CommissionEntryKind = (typeof COMMISSION_ENTRY_KINDS)[number];
export const SETTLEMENT_STATUSES = ["DRAFT", "APPROVED", "PAID"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const commissionRuleType = z.enum(COMMISSION_RULE_TYPES);
export const commissionEntryKind = z.enum(COMMISSION_ENTRY_KINDS);
export const settlementStatus = z.enum(SETTLEMENT_STATUSES);

/** DRAFT -> APPROVED -> PAID (mirrors the settlement_guard trigger). Only a DRAFT can be deleted. */
export const SETTLEMENT_TRANSITIONS: TransitionTable<SettlementStatus> = {
  DRAFT: ["APPROVED"],
  APPROVED: ["PAID"],
  PAID: [],
};
export const canTransitionSettlement = (from: SettlementStatus, to: SettlementStatus) =>
  canTransition(SETTLEMENT_TRANSITIONS, from, to);

/** Stable error codes of the commissions API (409 unless noted). */
export const COMMISSION_ERROR_CODES = [
  "commission_rule_immutable",
  "commission_rule_overlap",
  "settlement_state",
  "settlement_total_mismatch",
  "settlement_item_mismatch",
  "settlement_self_approval",
  "settlement_nothing_to_settle",
  "settlement_period_overlap",
] as const;

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const ruleShape = z.object({
  /** Omitted = the default rule (applies to every dentist without a specific rule). */
  dentistUserId: staffUserId.optional(),
  type: commissionRuleType.default("PERCENT_OF_COLLECTED"),
  /** Required for PERCENT_* types: 0–10000 bp (e.g. 3000 = 30%). */
  percentBp: basisPoints.optional(),
  /** Required for FIXED_PER_PROCEDURE: paise per procedure unit. */
  fixedPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  /** Optional filter: only lines of this service category. */
  serviceCategoryId: uuid.optional(),
  /** First day the rule applies (≥ today: rules are never back-dated). */
  effectiveFrom: dateOnly,
  note: optionalText(500),
});
const ruleBasis = (r: z.infer<typeof ruleShape>, ctx: z.RefinementCtx) => {
  if (r.type === "FIXED_PER_PROCEDURE") {
    if (r.fixedPaise === undefined || r.percentBp !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "FIXED_PER_PROCEDURE needs fixedPaise only",
        path: ["fixedPaise"],
      });
  } else if (r.percentBp === undefined || r.fixedPaise !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: `${r.type} needs percentBp only`,
      path: ["percentBp"],
    });
  }
};

export const createCommissionRuleRequest = ruleShape.superRefine(ruleBasis);
export type CreateCommissionRuleRequest = z.infer<typeof createCommissionRuleRequest>;

/**
 * Rules are never edited. Supersede = close the open rule of the same scope the day before `effectiveFrom`
 * and insert the new one (one transaction). Same body as create; the scope is the old rule's.
 */
export const supersedeCommissionRuleRequest = ruleShape
  .omit({ dentistUserId: true, serviceCategoryId: true })
  .superRefine(ruleBasis);
export type SupersedeCommissionRuleRequest = z.infer<typeof supersedeCommissionRuleRequest>;

/** Ends an open rule (exclusive end date, after its start). No replacement: the scope falls back to broader rules. */
export const closeCommissionRuleRequest = z.object({ effectiveTo: dateOnly });
export type CloseCommissionRuleRequest = z.infer<typeof closeCommissionRuleRequest>;

export const listCommissionRulesQuery = pageQuery.extend({
  dentistUserId: staffUserId.optional(),
  serviceCategoryId: uuid.optional(),
  /** Only the default rules (dentistUserId IS NULL). */
  defaultsOnly: z.stringbool().optional(),
  /** Rules in force on this date (default: any). */
  asOf: dateOnly.optional(),
  /** Only open (not yet closed) rules. */
  open: z.stringbool().optional(),
});
export type ListCommissionRulesQuery = z.infer<typeof listCommissionRulesQuery>;

export const commissionRuleResponse = z.object({
  id: uuid,
  dentistUserId: z.string().nullable(),
  type: commissionRuleType,
  percentBp: z.number().int().nullable(),
  fixedPaise: z.number().int().nullable(),
  serviceCategoryId: uuid.nullable(),
  effectiveFrom: dateOnly,
  effectiveTo: dateOnly.nullable(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  endedBy: z.string().nullable(),
});
export type CommissionRuleResponse = z.infer<typeof commissionRuleResponse>;

/** The fields of a rule the calculation needs (dates as "YYYY-MM-DD"). */
export interface CommissionRuleLike {
  id: string;
  dentistUserId: string | null;
  type: CommissionRuleType;
  percentBp: number | null;
  fixedPaise: number | null;
  serviceCategoryId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** True when the rule is in force on `on` (start inclusive, end exclusive). */
export const ruleInForce = (r: CommissionRuleLike, on: string): boolean =>
  r.effectiveFrom <= on && (r.effectiveTo === null || on < r.effectiveTo);

/**
 * Picks the rule for one invoice line. Candidates are in force on `on` (the invoice's issue date — a
 * late payment never changes the basis the work was billed under) and match the dentist (own or default)
 * and category (own filter or none). Precedence: dentist+category > dentist > default+category > default.
 * Returns null when no rule applies (no commission).
 */
export function selectCommissionRule(
  rules: readonly CommissionRuleLike[],
  ctx: { dentistUserId: string | null; serviceCategoryId: string | null; on: string },
): CommissionRuleLike | null {
  let best: { rule: CommissionRuleLike; score: number } | null = null;
  for (const r of rules) {
    if (!ruleInForce(r, ctx.on)) continue;
    if (r.dentistUserId !== null && r.dentistUserId !== ctx.dentistUserId) continue;
    if (r.serviceCategoryId !== null && r.serviceCategoryId !== ctx.serviceCategoryId) continue;
    const score = (r.dentistUserId !== null ? 2 : 0) + (r.serviceCategoryId !== null ? 1 : 0);
    if (!best || score > best.score) best = { rule: r, score };
  }
  return best?.rule ?? null;
}

// ---------------------------------------------------------------------------------------------
// Calculation (pure) — ADR 0004 §7.3
// ---------------------------------------------------------------------------------------------

export interface CommissionLineInput {
  id: string;
  quantity: number;
  /** Tax-inclusive line total (what the patient pays for the line). */
  totalPaise: number;
  /** Ex-tax value GST is charged on, after discounts. */
  taxableValuePaise: number;
  /** Gross before any discount, as entered (tax-inclusive when the invoice is). */
  grossPaise: number;
  taxRateBp: number;
}

/**
 * Splits one (signed) payment allocation over the invoice's lines pro-rata to line totals
 * (largest-remainder on the magnitude, ties to the earlier line, sign kept). Σ result = allocation.
 * A refund reversal (negative allocation on the same invoice) therefore mirrors the original exactly.
 */
export function splitAllocationOverLines(
  allocationPaise: number,
  lines: ReadonlyArray<{ id: string; totalPaise: number }>,
): Map<string, number> {
  const out = new Map<string, number>(lines.map((l) => [l.id, 0]));
  const total = lines.reduce((a, l) => a + l.totalPaise, 0);
  if (allocationPaise === 0 || total === 0) return out;
  const sign = allocationPaise < 0 ? -1 : 1;
  const A = BigInt(Math.abs(allocationPaise));
  const S = BigInt(total);
  const base = lines.map((l) => (A * BigInt(l.totalPaise)) / S);
  const rem = lines.map((l, i) => ({ i, r: (A * BigInt(l.totalPaise)) % S }));
  let left = Number(A - base.reduce((a, b) => a + b, 0n));
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rem) {
    if (left <= 0) break;
    base[i] = (base[i] ?? 0n) + 1n;
    left--;
  }
  lines.forEach((l, i) => out.set(l.id, sign * Number(base[i])));
  return out;
}

export interface CommissionResult {
  /**
   * Signed ledger amount to WRITE for this allocation row: + ACCRUAL, − REVERSAL, 0 = write nothing. It is the
   * change in the line's cumulative commission target, so the entries of one (line, rule) always sum to that target.
   */
  amountPaise: number;
  /** Signed revenue-base movement, sign-aligned with `amountPaise` for the ledger CHECK (ACCRUAL ≥ 0, REVERSAL ≤ 0). */
  baseAmountPaise: number;
}

/** What a line has collected and already earned, as of AFTER the allocation being processed. */
export interface LineCommissionPosition {
  /**
   * Σ over ALL allocation rows of the invoice (including the one being processed, reversals negative) of this line's
   * tax-inclusive share (`splitAllocationOverLines`).
   */
  collectedSharePaise: number;
  /**
   * The line's total adjusted for the invoice's net credit / debit notes (`adjustedLineTotal`): the amount that has to
   * be collected for the line to count as fully paid.
   */
  adjustedTotalPaise: number;
  /** Σ amountPaise of the existing ACCRUAL / REVERSAL entries of this (line, rule). */
  accruedPaise: number;
  /** Σ baseAmountPaise of those entries. */
  accruedBasePaise: number;
}

/** The line's total scaled by the invoice's (total + net adjustments) / total; debit notes raise it, credit notes lower it. */
export function adjustedLineTotal(
  lineTotalPaise: number,
  invoiceTotalPaise: number,
  netAdjustmentPaise: number,
): number {
  if (invoiceTotalPaise === 0) return lineTotalPaise;
  return Math.max(
    0,
    mulDivRound(lineTotalPaise, invoiceTotalPaise + netAdjustmentPaise, invoiceTotalPaise),
  );
}

/** round(a × b × c / d), half up, for non-negative integers (no intermediate overflow). */
const mulMulDivRound = (a: number, b: number, c: number, d: number): number =>
  Number((BigInt(a) * BigInt(b) * BigInt(c) * 2n + BigInt(d)) / (BigInt(d) * 2n));

/**
 * Commission movement for ONE line when ONE allocation row has been added: CUMULATIVE, not per-row.
 *   target(rule, collected) =
 *     PERCENT_OF_COLLECTED: percentBp × (collected × taxable / total)            — cash collected net of tax
 *     PERCENT_OF_BILLED:    percentBp × billed-ex-tax × min(collected, adjTotal) / adjTotal
 *     FIXED_PER_PROCEDURE:  fixedPaise × quantity × min(collected, adjTotal) / adjTotal
 *   result = target(after) − what the line's entries already hold.
 * Properties (ADR 0004 §7.2-7.3): Σ entries of a line always equals the target of its cumulative position, so
 *  - many small instalments (1 paise each) earn the same as one payment — no per-row rounding loss;
 *  - a full refund reversal returns the position to 0 and the entries net to exactly 0;
 *  - FIXED / BILLED never exceed their contractual amount, whatever debit notes were collected, and a credit note
 *    shrinks the amount that has to be collected (`adjustedTotalPaise`) instead of leaving the line short;
 *  - PERCENT_OF_COLLECTED earns on every collected rupee (a debit note's cash included, a credit note collects nothing).
 * `billedBasePaise` for PERCENT_OF_BILLED is the line's pre-discount ex-tax value (`billedNetOfTax`), so a clinic
 * discount does not reduce the dentist's share.
 */
export function computeLineCommission(
  rule: CommissionRuleLike,
  line: CommissionLineInput,
  position: LineCommissionPosition,
  taxInclusive: boolean,
): CommissionResult {
  const collected = Math.max(0, position.collectedSharePaise);
  const total = line.totalPaise;
  const adj = position.adjustedTotalPaise;
  const settled = adj > 0 ? Math.min(collected, adj) : 0;
  let target = 0;
  let baseTarget = 0;
  if (total > 0) {
    if (rule.type === "PERCENT_OF_COLLECTED") {
      baseTarget = mulDivRound(collected, line.taxableValuePaise, total);
      target = mulDivRound(baseTarget, rule.percentBp ?? 0, 10_000);
    } else if (adj > 0) {
      if (rule.type === "PERCENT_OF_BILLED") {
        const billed = billedNetOfTax(line, taxInclusive);
        baseTarget = mulDivRound(billed, settled, adj);
        target = mulMulDivRound(billed, settled, rule.percentBp ?? 0, adj * 10_000);
      } else {
        baseTarget = mulDivRound(line.taxableValuePaise, settled, adj);
        target = mulDivRound((rule.fixedPaise ?? 0) * line.quantity, settled, adj);
      }
    }
  }
  const amountPaise = target - position.accruedPaise;
  if (amountPaise === 0) return { amountPaise: 0, baseAmountPaise: 0 };
  const baseDelta = baseTarget - position.accruedBasePaise;
  return {
    amountPaise,
    baseAmountPaise: amountPaise > 0 ? Math.max(0, baseDelta) : Math.min(0, baseDelta),
  };
}

/** A line's value before discounts and without tax: gross (exclusive) or gross × 10000/(10000+rate) (inclusive). */
export function billedNetOfTax(line: CommissionLineInput, taxInclusive: boolean): number {
  return taxInclusive
    ? mulDivRound(line.grossPaise, 10_000, 10_000 + line.taxRateBp)
    : line.grossPaise;
}

/** Σ of ledger entries (signed): what the clinic owes the dentist. */
export const commissionBalancePaise = (entries: ReadonlyArray<{ amountPaise: number }>) =>
  entries.reduce((a, e) => a + e.amountPaise, 0);

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

export const listCommissionEntriesQuery = pageQuery.extend({
  dentistUserId: staffUserId.optional(),
  branchId: uuid.optional(),
  invoiceId: uuid.optional(),
  kind: commissionEntryKind.optional(),
  /** true = already in a settlement, false = still unsettled. */
  settled: z.stringbool().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListCommissionEntriesQuery = z.infer<typeof listCommissionEntriesQuery>;

export const commissionEntryResponse = z.object({
  id: uuid,
  branchId: uuid,
  dentistUserId: z.string(),
  kind: commissionEntryKind,
  amountPaise: z.number().int(),
  baseAmountPaise: z.number().int(),
  ruleId: uuid.nullable(),
  invoiceId: uuid.nullable(),
  invoiceLineId: uuid.nullable(),
  paymentAllocationId: uuid.nullable(),
  encounterId: uuid.nullable(),
  settlementId: uuid.nullable(),
  /** Whether a settlement covers this entry. */
  settled: z.boolean(),
  reason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
});
export type CommissionEntryResponse = z.infer<typeof commissionEntryResponse>;

/** Manual correction (signed, reason required, audited). compensation:manage. */
export const createCommissionAdjustmentRequest = z.object({
  dentistUserId: staffUserId,
  branchId: uuid,
  amountPaise: z
    .number()
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((n) => n !== 0, "Amount must not be zero"),
  reason: z.string().trim().min(3).max(500),
  /** Replay key (RequestDedupe scope `commission.adjust`). */
  idempotencyKey,
});
export type CreateCommissionAdjustmentRequest = z.infer<typeof createCommissionAdjustmentRequest>;

// ---------------------------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------------------------

/**
 * Starts a settlement run for one dentist and period [periodStart, periodEnd). The server collects every
 * still-unsettled ledger entry created before `periodEnd` (earlier carry-overs and late reversals included)
 * into items and stores the total. Periods of one dentist never overlap.
 */
export const createSettlementRequest = z.object({
  dentistUserId: staffUserId,
  periodStart: dateOnly,
  periodEnd: dateOnly,
  notes: optionalText(500),
  /** Replay key (scope `commission.settlement`). */
  idempotencyKey,
});
export type CreateSettlementRequest = z.infer<typeof createSettlementRequest>;
export const approveSettlementRequest = z.object({ note: optionalText(500) });
export type ApproveSettlementRequest = z.infer<typeof approveSettlementRequest>;
/** Marks the payout as made (outside the app: payroll is out of scope) and writes the SETTLEMENT ledger entry. */
export const paySettlementRequest = z.object({
  paymentReference: z.string().trim().max(100).optional(),
  paidOn: dateOnly.optional(),
});
export type PaySettlementRequest = z.infer<typeof paySettlementRequest>;
export const listSettlementsQuery = pageQuery.extend({
  dentistUserId: staffUserId.optional(),
  status: settlementStatus.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListSettlementsQuery = z.infer<typeof listSettlementsQuery>;

export const settlementResponse = z.object({
  id: uuid,
  dentistUserId: z.string(),
  periodStart: dateOnly,
  periodEnd: dateOnly,
  status: settlementStatus,
  totalPaise: z.number().int(),
  itemCount: z.number().int().optional(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  approvedBy: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  paidBy: z.string().nullable(),
  paidAt: isoDateTime.nullable(),
  paymentReference: z.string().nullable(),
  notes: z.string().nullable(),
});
export type SettlementResponse = z.infer<typeof settlementResponse>;
export const settlementDetailResponse = settlementResponse.extend({
  items: z.array(
    z.object({
      id: uuid,
      entryId: uuid,
      amountPaise: z.number().int(),
      entry: commissionEntryResponse,
    }),
  ),
});
export type SettlementDetailResponse = z.infer<typeof settlementDetailResponse>;

// ---------------------------------------------------------------------------------------------
// Dentist statement (compensation:read — self for a dentist, any dentist for compensation:manage)
// ---------------------------------------------------------------------------------------------

export const dentistStatementQuery = z.object({
  /** Dentists see only themselves (omit = self). */
  dentistUserId: staffUserId.optional(),
  branchId: uuid.optional(),
  from: dateOnly,
  to: dateOnly,
});
export type DentistStatementQuery = z.infer<typeof dentistStatementQuery>;
export const dentistStatementResponse = z.object({
  dentistUserId: z.string(),
  from: dateOnly,
  to: dateOnly,
  accruedPaise: z.number().int(),
  reversedPaise: z.number().int(),
  adjustedPaise: z.number().int(),
  settledPaise: z.number().int(),
  /** Net movement in the period. */
  netPaise: z.number().int(),
  /** All-time unsettled balance owed to the dentist at `to`. */
  payableBalancePaise: z.number().int(),
  entries: z.array(commissionEntryResponse),
});
export type DentistStatementResponse = z.infer<typeof dentistStatementResponse>;
