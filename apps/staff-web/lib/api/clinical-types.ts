import type {
  PlanDiff,
  PlanItemResponse,
  PlanTotals,
  TreatmentPlanResponse,
} from "@dentalos/validation";

/**
 * Response shapes of the M2 controllers that go beyond the shared DTOs in @dentalos/validation
 * (extra fields returned by apps/api/src/plans/plan-common.ts `toPlan` / `toItem` and by
 * PlansService.diff). Candidates for promotion to packages/validation in Wave 3.
 */

/** `toItem` adds the line total (unit estimate × quantity, integer paise). */
export type PlanItemDetail = PlanItemResponse & { lineTotalPaise?: number };

/** `phaseTotals(items)`: same buckets as the plan totals, per phase (ascending). */
export type PhaseTotals = PlanTotals & { phase: number };

/** GET /plans/:id and every plan write. */
export type PlanDetail = Omit<TreatmentPlanResponse, "items"> & {
  items: PlanItemDetail[];
  phaseTotals?: PhaseTotals[];
};

/** GET /plans/:id/versions/:a/diff/:b. */
export type PlanDiffResponse = PlanDiff & { fromVersion: number; toVersion: number };
