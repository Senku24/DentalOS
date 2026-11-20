import type { BranchPriceOverride, Prisma, Service, Tx } from "@dentalos/db";

/** Override rows in force at `at`: started (effectiveFrom <= at) and not yet ended (effectiveTo exclusive). */
export const activeAt = (at: Date): Prisma.BranchPriceOverrideWhereInput => ({
  effectiveFrom: { lte: at },
  OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
});

/** Map serviceId -> override in force at `at` for one branch. */
export async function overridesFor(
  tx: Tx,
  tenantId: string,
  branchId: string,
  serviceIds: string[] | undefined,
  at = new Date(),
) {
  const rows = await tx.branchPriceOverride.findMany({
    where: {
      tenantId,
      branchId,
      ...(serviceIds ? { serviceId: { in: serviceIds } } : {}),
      ...activeAt(at),
    },
  });
  return new Map(rows.map((r) => [r.serviceId, r]));
}

export function effectivePrice(s: Service, branchId: string, o: BranchPriceOverride | undefined) {
  return {
    serviceId: s.id,
    branchId,
    pricePaise: o ? o.pricePaise : s.basePricePaise,
    source: o ? ("OVERRIDE" as const) : ("BASE" as const),
    overrideId: o?.id ?? null,
  };
}

export const toService = (s: Service, effectivePricePaise?: number) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  description: s.description,
  categoryId: s.categoryId,
  durationMin: s.durationMin,
  basePricePaise: s.basePricePaise,
  taxable: s.taxable,
  active: s.active,
  ...(effectivePricePaise !== undefined ? { effectivePricePaise } : {}),
});

export const toOverride = (o: BranchPriceOverride) => ({
  id: o.id,
  serviceId: o.serviceId,
  branchId: o.branchId,
  pricePaise: o.pricePaise,
  reason: o.reason,
  setBy: o.setBy,
  effectiveFrom: o.effectiveFrom,
  effectiveTo: o.effectiveTo,
  /** Why / by whom the override was closed (superseded or cleared); null while in force. */
  endedReason: o.endedReason,
  endedBy: o.endedBy,
});
