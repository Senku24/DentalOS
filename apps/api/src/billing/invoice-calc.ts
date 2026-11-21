import type { Tx } from "@dentalos/db";
import {
  type DiscountSpec,
  type ResolvedBillingSettings,
  computeInvoiceTotals,
  isInterStateSupply,
  maxDiscountBpForRoles,
  mulDivRound,
} from "@dentalos/validation";
import { ForbiddenException } from "@nestjs/common";
import { badRequest, conflict } from "./billing-common";

/** Discount rule violations -> HTTP (ADR 0004 §3.5): permission 403, missing reason 400, limit / base 409. */
export function discountError(error: string): never {
  if (error === "discount_not_permitted") throw new ForbiddenException({ error });
  if (error === "discount_reason_required") throw badRequest(error);
  throw conflict(error);
}

/** Invoice-level discount as entered (percent or fixed), with who gave it and why. */
export interface InvoiceDiscountState {
  amountPaise: number;
  percentBp: number | null;
  reason: string | null;
  appliedBy: string | null;
}
export const NO_INVOICE_DISCOUNT: InvoiceDiscountState = {
  amountPaise: 0,
  percentBp: null,
  reason: null,
  appliedBy: null,
};

/**
 * Recomputes every line (GST, apportioned invoice discount) and the header of a DRAFT from the stored unit prices,
 * quantities, line discounts and tax rates. The header is always Σ lines (the DB checks it at issue).
 *
 * The invoice-level discount stays "as entered": a percentage is re-derived on the new base, a fixed amount is kept
 * and must still fit the base AND the percentage limit of the user who applied it (otherwise deleting lines could
 * inflate a discount's percentage past what that user was allowed to give).
 */
export async function recomputeDraft(
  tx: Tx,
  tenantId: string,
  invoiceId: string,
  settings: ResolvedBillingSettings,
  /** A discount being set in this same call: written together with the totals (the header checks are immediate). */
  override?: InvoiceDiscountState,
): Promise<void> {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (inv.status !== "DRAFT") throw conflict("invoice_immutable");
  const lines = await tx.invoiceLine.findMany({
    where: { invoiceId },
    orderBy: { lineNo: "asc" },
  });
  const base = lines.reduce((a, l) => a + l.quantity * l.unitPricePaise - l.discountPaise, 0);

  const st: InvoiceDiscountState = override ?? {
    amountPaise: inv.invoiceDiscountPaise,
    percentBp: inv.invoiceDiscountPercentBp,
    reason: inv.discountReason,
    appliedBy: inv.discountAppliedBy,
  };
  let invoiceDiscountPaise = 0;
  if (st.amountPaise > 0 || st.percentBp !== null) {
    const percent = st.percentBp;
    invoiceDiscountPaise = percent !== null ? mulDivRound(base, percent, 10_000) : st.amountPaise;
    if (invoiceDiscountPaise > base) throw conflict("discount_exceeds_base");
    if (percent === null && invoiceDiscountPaise > 0) {
      const applier = st.appliedBy
        ? await tx.membership.findUnique({
            where: { tenantId_userId: { tenantId, userId: st.appliedBy } },
          })
        : null;
      const maxBp = applier ? maxDiscountBpForRoles(applier.roles, settings.discountLimitsBp) : 0;
      if (BigInt(invoiceDiscountPaise) * 10_000n > BigInt(maxBp) * BigInt(base))
        throw conflict("discount_exceeds_limit");
    }
  }

  const spec: DiscountSpec | null =
    invoiceDiscountPaise > 0 ? { kind: "AMOUNT", amountPaise: invoiceDiscountPaise } : null;
  let totals: ReturnType<typeof computeInvoiceTotals>;
  try {
    totals = computeInvoiceTotals({
      lines: lines.map((l) => ({
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        discountPaise: l.discountPaise,
        taxRateBp: l.taxRateBp,
      })),
      taxInclusive: inv.taxInclusive,
      interState: isInterStateSupply(settings.stateCode, inv.placeOfSupplyStateCode),
      invoiceDiscount: spec,
    });
  } catch (e) {
    if (e instanceof RangeError) throw conflict("discount_exceeds_base");
    throw e;
  }

  for (const [i, l] of lines.entries()) {
    const a = totals.lines[i];
    if (!a) continue;
    if (
      l.grossPaise === a.grossPaise &&
      l.allocatedDiscountPaise === a.allocatedDiscountPaise &&
      l.taxableValuePaise === a.taxableValuePaise &&
      l.cgstPaise === a.cgstPaise &&
      l.sgstPaise === a.sgstPaise &&
      l.igstPaise === a.igstPaise &&
      l.totalPaise === a.totalPaise
    )
      continue;
    await tx.invoiceLine.update({
      where: { id: l.id },
      data: {
        grossPaise: a.grossPaise,
        allocatedDiscountPaise: a.allocatedDiscountPaise,
        taxableValuePaise: a.taxableValuePaise,
        cgstPaise: a.cgstPaise,
        sgstPaise: a.sgstPaise,
        igstPaise: a.igstPaise,
        totalPaise: a.totalPaise,
      },
    });
  }
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      subtotalPaise: totals.subtotalPaise,
      discountPaise: totals.discountPaise,
      invoiceDiscountPaise: totals.invoiceDiscountPaise,
      taxPaise: totals.taxPaise,
      totalPaise: totals.totalPaise,
      ...(override
        ? totals.invoiceDiscountPaise > 0
          ? {
              invoiceDiscountPercentBp: override.percentBp,
              discountReason: override.reason,
              discountAppliedBy: override.appliedBy,
            }
          : { invoiceDiscountPercentBp: null, discountReason: null, discountAppliedBy: null }
        : {}),
    },
  });
}
