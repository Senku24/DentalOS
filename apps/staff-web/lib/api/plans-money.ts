import { type PlanItemStatus, type PlanTotals, planTotals } from "@dentalos/validation";
import type { PhaseTotals, PlanDetail, PlanItemDetail } from "./clinical-types";

/**
 * Plan money helpers. Estimates are frozen by the server in integer paise when an item is proposed
 * (ADR 0003 §3.1); the UI never recomputes prices, it only groups and sums what the server returned.
 * Server totals (`totals`, `phaseTotals`, `lineTotalPaise`) win; the shared `planTotals` rule is the
 * fallback so a plan from an older API (or a snapshot) still shows the same buckets.
 */

type Priced = { status: PlanItemStatus; estimatePricePaise: number; quantity: number };

/** Unit estimate × quantity (paise). */
export function lineTotalPaise(i: Priced & { lineTotalPaise?: number }): number {
  return i.lineTotalPaise ?? i.estimatePricePaise * i.quantity;
}

/** True when the line counts towards the estimate (not rejected or cancelled). */
export const countsTowardsEstimate = (s: PlanItemStatus) => s !== "REJECTED" && s !== "CANCELLED";

export interface PhaseGroup {
  phase: number;
  /** Ordered by sequence. */
  items: PlanItemDetail[];
  totals: PlanTotals;
}

/** Items grouped by phase (ascending), each with its totals. */
export function groupByPhase(plan: Pick<PlanDetail, "items" | "phaseTotals">): PhaseGroup[] {
  const phases = [...new Set(plan.items.map((i) => i.phase))].sort((a, b) => a - b);
  const server = new Map((plan.phaseTotals ?? []).map((t: PhaseTotals) => [t.phase, t]));
  return phases.map((phase) => {
    const items = plan.items
      .filter((i) => i.phase === phase)
      .sort((a, b) => a.sequence - b.sequence);
    const s = server.get(phase);
    return {
      phase,
      items,
      totals: s
        ? {
            estimatePaise: s.estimatePaise,
            acceptedPaise: s.acceptedPaise,
            completedPaise: s.completedPaise,
            pendingPaise: s.pendingPaise,
          }
        : planTotals(items),
    };
  });
}

/** Plan-level totals (server first). */
export function totalsOf(plan: Pick<PlanDetail, "items"> & { totals?: PlanTotals }): PlanTotals {
  return plan.totals ?? planTotals(plan.items);
}

/** Next free phase number for "Add phase". */
export function nextPhase(items: readonly { phase: number }[]): number {
  return Math.min(20, items.reduce((m, i) => Math.max(m, i.phase), 0) + 1);
}
