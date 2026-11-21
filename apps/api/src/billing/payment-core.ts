import type { PaymentAllocation, Tx } from "@dentalos/db";
import type { ResolvedBillingSettings } from "@dentalos/validation";
import type { Principal } from "../auth/roles";
import { withBranchScope } from "../common/principal";
import { conflict, lockInvoice, notFound } from "./billing-common";

export interface AllocationRequest {
  invoiceId: string;
  amountPaise: number;
}
export interface PayLike {
  id: string;
  patientId: string;
  branchId: string;
}
/** Who writes: a staff principal, or a system actor (webhook) that has no branch scope of its own. */
export interface Writer {
  tenantId: string;
  userId: string;
  principal?: Principal;
}

/** Merges duplicate invoices and sorts by invoice id: a fixed lock order means no deadlock between payments. */
export function normaliseAllocations(allocs: AllocationRequest[]): AllocationRequest[] {
  const sums = new Map<string, number>();
  for (const a of allocs) sums.set(a.invoiceId, (sums.get(a.invoiceId) ?? 0) + a.amountPaise);
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([invoiceId, amountPaise]) => ({ invoiceId, amountPaise }));
}

/**
 * Inserts positive allocations of one payment (the DB trigger recalculates each invoice). `applied` = the money
 * comes from the payment's advance: every allocation is mirrored by an `APPLIED` credit entry. With `clamp` each
 * amount is cut to the invoice's current balance (checkout / auto allocation) instead of failing.
 * The payment row must already be locked by the caller (lock order Payment -> Invoice).
 */
export async function insertAllocations(
  tx: Tx,
  who: Writer,
  pay: PayLike,
  allocs: AllocationRequest[],
  opts: { applied: boolean; clamp?: boolean },
): Promise<PaymentAllocation[]> {
  const out: PaymentAllocation[] = [];
  for (const a of normaliseAllocations(allocs)) {
    const probe = await tx.invoice.findFirst({
      where: who.principal
        ? withBranchScope(who.principal, { id: a.invoiceId })
        : { id: a.invoiceId },
    });
    if (!probe) throw notFound("invoice_not_found");
    if (probe.patientId !== pay.patientId || probe.branchId !== pay.branchId)
      throw conflict("link_mismatch", { constraint: "PaymentAllocation_invoice_patient_branch" });
    await lockInvoice(tx, a.invoiceId);
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
    if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID") {
      if (opts.clamp) continue;
      throw conflict("invoice_not_payable", { status: inv.status });
    }
    let amount = a.amountPaise;
    if (amount > inv.balancePaise) {
      if (!opts.clamp) throw conflict("invoice_overpaid", { balancePaise: inv.balancePaise });
      amount = inv.balancePaise;
    }
    if (amount <= 0) continue;
    const alloc = await tx.paymentAllocation.create({
      data: {
        tenantId: who.tenantId,
        paymentId: pay.id,
        invoiceId: a.invoiceId,
        patientId: pay.patientId,
        branchId: pay.branchId,
        amountPaise: amount,
        allocatedBy: who.userId,
      },
    });
    out.push(alloc);
    if (opts.applied)
      await tx.patientCreditEntry.create({
        data: {
          tenantId: who.tenantId,
          patientId: pay.patientId,
          branchId: pay.branchId,
          kind: "APPLIED",
          amountPaise: -amount,
          paymentId: pay.id,
          allocationId: alloc.id,
          createdBy: who.userId,
        },
      });
  }
  return out;
}

/**
 * Everything that follows a freshly RECORDED payment (ADR 0004 §4.2-4.3, one transaction): allocations, the
 * unallocated remainder as patient advance (when allowed), and the PAYMENT ledger entry. The commission module reads
 * the new allocations (idempotent per allocation + line); nothing is called from here.
 */
export async function settleRecordedPayment(
  tx: Tx,
  who: Writer,
  pay: PayLike & { amountPaise: number },
  allocs: AllocationRequest[],
  settings: ResolvedBillingSettings,
  opts: { clamp?: boolean; occurredAt?: Date } = {},
): Promise<{ allocations: PaymentAllocation[]; advancePaise: number }> {
  const sum = allocs.reduce((a, x) => a + x.amountPaise, 0);
  if (sum > pay.amountPaise) throw conflict("allocation_exceeds_payment");
  const allocations = await insertAllocations(tx, who, pay, allocs, {
    applied: false,
    clamp: opts.clamp,
  });
  const allocated = allocations.reduce((a, x) => a + x.amountPaise, 0);
  const advancePaise = pay.amountPaise - allocated;
  if (advancePaise > 0) {
    if (!settings.allowAdvancePayments) throw conflict("advance_not_allowed");
    await tx.patientCreditEntry.create({
      data: {
        tenantId: who.tenantId,
        patientId: pay.patientId,
        branchId: pay.branchId,
        kind: "ADVANCE",
        amountPaise: advancePaise,
        paymentId: pay.id,
        createdBy: who.userId,
      },
    });
  }
  await tx.financeLedgerEntry.create({
    data: {
      tenantId: who.tenantId,
      branchId: pay.branchId,
      patientId: pay.patientId,
      kind: "PAYMENT",
      amountPaise: -pay.amountPaise,
      paymentId: pay.id,
      occurredAt: opts.occurredAt ?? new Date(),
      createdBy: who.userId,
    },
  });
  return { allocations, advancePaise };
}
