import type { Tx } from "@dentalos/db";
import {
  type CommissionLineInput,
  type CommissionRuleLike,
  adjustedLineTotal,
  computeLineCommission,
  selectCommissionRule,
  splitAllocationOverLines,
} from "@dentalos/validation";

/**
 * Commission accrual engine (ADR 0004 §7.2-7.3). Deliberately free of Nest imports (only `@dentalos/db` types and
 * `@dentalos/validation` helpers) so it can run inline in a billing transaction, behind a pg-boss handler
 * (./accrual.job.ts) or from the manual HTTP endpoint, and can be moved to a shared package unchanged.
 *
 * Given ONE PaymentAllocation row (positive = payment, negative = refund reversal) it works out, for every
 * invoice line with a dentist and a rule in force on the invoice's issue date, the CUMULATIVE commission target of
 * the line over ALL allocation rows of the invoice, and inserts the difference to what the line's ledger entries
 * already hold (+ ACCRUAL / − REVERSAL). Properties:
 *  - idempotent: at most one entry per (allocation, line) — also enforced by the unique index, so a retried job
 *    writes nothing;
 *  - order-independent for the sum: the entries of a line always add up to the target of its current position;
 *  - serialised per invoice by an advisory lock, so two allocations processed concurrently cannot both add the
 *    same delta;
 *  - attribution is `InvoiceLine.dentistUserId`, copied onto the entry and never rewritten after a dentist transfer;
 *  - a line with no dentist, or no rule in force, earns nothing (no rule => no commission).
 * The DB guard (`commission_entry_guard`) binds an ACCRUAL to a positive and a REVERSAL to a negative allocation. When
 * the delta computed for this allocation has the other sign (rows processed out of order), nothing is written for
 * that line and `skipped` explains why: the allocation of the matching sign carries the movement.
 */

export interface AccrualEntryResult {
  entryId: string;
  invoiceLineId: string;
  dentistUserId: string;
  kind: "ACCRUAL" | "REVERSAL";
  amountPaise: number;
  baseAmountPaise: number;
  ruleId: string;
}

export interface AccrualSkip {
  invoiceLineId: string | null;
  reason:
    | "no_dentist"
    | "no_rule"
    | "already_accrued"
    | "no_change"
    | "sign_mismatch"
    | "invoice_not_issued"
    | "allocation_not_found";
}

export interface AccrualResult {
  allocationId: string;
  /** "accrued" = at least one entry written; "noop" = nothing to write (replay / nothing earned); "not_found". */
  status: "accrued" | "noop" | "not_found";
  entries: AccrualEntryResult[];
  skipped: AccrualSkip[];
}

/** The calendar date of `at` in an IANA zone as "YYYY-MM-DD" (UTC when the zone is unknown). */
function localDay(timeZone: string | null | undefined, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export async function accrueAllocation(
  tx: Tx,
  tenantId: string,
  allocationId: string,
  actorId: string,
): Promise<AccrualResult> {
  const result: AccrualResult = { allocationId, status: "noop", entries: [], skipped: [] };

  const alloc = await tx.paymentAllocation.findFirst({ where: { id: allocationId, tenantId } });
  if (!alloc) {
    result.status = "not_found";
    result.skipped.push({ invoiceLineId: null, reason: "allocation_not_found" });
    return result;
  }

  // One accrual at a time per invoice (the cumulative maths reads all rows and all entries of the invoice).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission:${alloc.invoiceId}`}, 0))`;

  const invoice = await tx.invoice.findFirst({ where: { id: alloc.invoiceId, tenantId } });
  if (!invoice || !invoice.issuedAt) {
    result.skipped.push({ invoiceLineId: null, reason: "invoice_not_issued" });
    return result;
  }
  const branch = await tx.branch.findFirst({
    where: { id: invoice.branchId, tenantId },
    select: { timezone: true },
  });
  const issueDay = localDay(branch?.timezone, invoice.issuedAt);

  const [lines, allocations, entries] = await Promise.all([
    tx.invoiceLine.findMany({
      where: { invoiceId: invoice.id, tenantId },
      orderBy: { lineNo: "asc" },
    }),
    tx.paymentAllocation.findMany({
      where: { invoiceId: invoice.id, tenantId },
      select: { id: true, amountPaise: true },
    }),
    tx.commissionEntry.findMany({
      where: { invoiceId: invoice.id, tenantId, kind: { in: ["ACCRUAL", "REVERSAL"] } },
      select: {
        invoiceLineId: true,
        paymentAllocationId: true,
        amountPaise: true,
        baseAmountPaise: true,
      },
    }),
  ]);

  const dentists = [...new Set(lines.map((l) => l.dentistUserId).filter((d): d is string => !!d))];
  const ruleRows =
    dentists.length === 0
      ? []
      : await tx.commissionRule.findMany({
          where: { tenantId, OR: [{ dentistUserId: null }, { dentistUserId: { in: dentists } }] },
        });
  const rules: CommissionRuleLike[] = ruleRows.map((r) => ({
    id: r.id,
    dentistUserId: r.dentistUserId,
    type: r.type,
    percentBp: r.percentBp,
    fixedPaise: r.fixedPaise,
    serviceCategoryId: r.serviceCategoryId,
    effectiveFrom: day(r.effectiveFrom) as string,
    effectiveTo: day(r.effectiveTo),
  }));

  // Each line's tax-inclusive share of EVERY allocation row (refund reversals negative).
  const lineTotals = lines.map((l) => ({ id: l.id, totalPaise: l.totalPaise }));
  const collected = new Map<string, number>(lines.map((l) => [l.id, 0]));
  for (const a of allocations) {
    for (const [lineId, share] of splitAllocationOverLines(a.amountPaise, lineTotals))
      collected.set(lineId, (collected.get(lineId) ?? 0) + share);
  }

  for (const line of lines) {
    if (!line.dentistUserId) {
      result.skipped.push({ invoiceLineId: line.id, reason: "no_dentist" });
      continue;
    }
    const mine = entries.filter((e) => e.invoiceLineId === line.id);
    if (mine.some((e) => e.paymentAllocationId === alloc.id)) {
      result.skipped.push({ invoiceLineId: line.id, reason: "already_accrued" });
      continue;
    }
    const rule = selectCommissionRule(rules, {
      dentistUserId: line.dentistUserId,
      serviceCategoryId: line.serviceCategoryId,
      on: issueDay,
    });
    if (!rule) {
      result.skipped.push({ invoiceLineId: line.id, reason: "no_rule" });
      continue;
    }
    const input: CommissionLineInput = {
      id: line.id,
      quantity: line.quantity,
      totalPaise: line.totalPaise,
      taxableValuePaise: line.taxableValuePaise,
      grossPaise: line.grossPaise,
      taxRateBp: line.taxRateBp,
    };
    // Σ over the line's accrual/reversal entries whatever rule they were written under: if a more specific rule
    // began after earlier entries were written, the new target replaces (not adds to) what was already earned.
    const calc = computeLineCommission(
      rule,
      input,
      {
        collectedSharePaise: collected.get(line.id) ?? 0,
        adjustedTotalPaise: adjustedLineTotal(
          line.totalPaise,
          invoice.totalPaise,
          invoice.adjustmentPaise,
        ),
        accruedPaise: mine.reduce((a, e) => a + e.amountPaise, 0),
        accruedBasePaise: mine.reduce((a, e) => a + e.baseAmountPaise, 0),
      },
      invoice.taxInclusive,
    );
    if (calc.amountPaise === 0) {
      result.skipped.push({ invoiceLineId: line.id, reason: "no_change" });
      continue;
    }
    const kind = calc.amountPaise > 0 ? "ACCRUAL" : "REVERSAL";
    if ((kind === "ACCRUAL") !== alloc.amountPaise > 0) {
      result.skipped.push({ invoiceLineId: line.id, reason: "sign_mismatch" });
      continue;
    }
    const entry = await tx.commissionEntry.create({
      data: {
        tenantId,
        branchId: invoice.branchId,
        dentistUserId: line.dentistUserId,
        kind,
        amountPaise: calc.amountPaise,
        baseAmountPaise: calc.baseAmountPaise,
        ruleId: rule.id,
        invoiceId: invoice.id,
        invoiceLineId: line.id,
        paymentAllocationId: alloc.id,
        encounterId: line.encounterId ?? invoice.encounterId,
        createdBy: actorId,
      },
    });
    result.entries.push({
      entryId: entry.id,
      invoiceLineId: line.id,
      dentistUserId: line.dentistUserId,
      kind,
      amountPaise: calc.amountPaise,
      baseAmountPaise: calc.baseAmountPaise,
      ruleId: rule.id,
    });
  }
  if (result.entries.length > 0) result.status = "accrued";
  return result;
}
