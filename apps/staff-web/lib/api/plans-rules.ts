import {
  PLAN_ITEM_DECISIONS,
  PLAN_ITEM_REASON_REQUIRED,
  type PlanItemStatus,
  type TreatmentPlanStatus,
  type UpdatePlanItemRequest,
  allowedPlanItemTransitions,
  canTransitionPlanItem,
  isStatusEndpointTransition,
} from "@dentalos/validation";
import { changedFields } from "../forms";

/**
 * Display-side mirrors of the plan rules in apps/api/src/plans (ADR 0003 §3 + Wave 1 addendum), so
 * the UI only offers moves the API accepts. The API stays the authority (409 on anything else).
 */

/** Items that can still be edited / re-priced (PlansService EDITABLE_ITEM_STATUSES). */
export const EDITABLE_ITEM_STATUSES: readonly PlanItemStatus[] = ["PROPOSED", "DEFERRED"];

/** Items whose sessions can be planned (SessionsService SCHEDULABLE_ITEM_STATUSES). */
export const SCHEDULABLE_ITEM_STATUSES: readonly PlanItemStatus[] = [
  "ACCEPTED",
  "SCHEDULED",
  "IN_PROGRESS",
];

/** Items a procedure may link to (clinical-common PLAN_ITEM_LINKABLE). */
export const LINKABLE_ITEM_STATUSES: readonly PlanItemStatus[] = SCHEDULABLE_ITEM_STATUSES;

export type Decision = (typeof PLAN_ITEM_DECISIONS)[number];

/** PlansService.isDecisionTransition: patient decisions never start from SCHEDULED. */
export const isDecisionTransition = (from: PlanItemStatus, to: PlanItemStatus) =>
  from !== "SCHEDULED" &&
  (PLAN_ITEM_DECISIONS as readonly string[]).includes(to) &&
  canTransitionPlanItem(from, to);

/** Decisions the patient can still make on an item (accept / reject / defer). */
export const decisionTargets = (from: PlanItemStatus): Decision[] =>
  PLAN_ITEM_DECISIONS.filter((d) => isDecisionTransition(from, d));

/** Clinician moves on POST /plan-items/:id/status. */
export const clinicianTargets = (from: PlanItemStatus): PlanItemStatus[] =>
  allowedPlanItemTransitions(from).filter((t) => isStatusEndpointTransition(from, t));

export const needsReason = (to: PlanItemStatus) => PLAN_ITEM_REASON_REQUIRED.includes(to);

export const isPlanClosed = (s: TreatmentPlanStatus) => s === "COMPLETED" || s === "CANCELLED";

/** Approvable once decided (PlansService.approve). */
export const isPlanDecided = (s: TreatmentPlanStatus) =>
  s === "ACCEPTED" || s === "PARTIALLY_ACCEPTED";

/** Items can be deleted only from a never-presented DRAFT; otherwise they are cancelled. */
export const canDeleteItems = (plan: { status: TreatmentPlanStatus; currentVersion: number }) =>
  plan.status === "DRAFT" && plan.currentVersion === 0;

type EditableItem = {
  id: string;
  phase: number;
  sequence: number;
  toothCode: number | null;
  surfaces: string[];
  quantity: number;
  notes: string | null;
};

/**
 * PATCH /plan-items/:id body from the edit form: only what changed (lib/forms `changedFields`).
 * The API applies every key it receives and, on a presented plan, commits a new plan version for
 * any non-empty change (which outdates consent signed for the previous version), so an unchanged
 * form must send nothing: returns null then. `phase` / `sequence` are never sent here (use
 * `reorderToPhase` + POST /plans/:id/items/reorder, which renumbers sequences). The server resets
 * surfaces when only the tooth is sent, so tooth and surfaces always travel together.
 */
export function planItemPatch(
  item: EditableItem,
  form: Pick<
    UpdatePlanItemRequest,
    "toothCode" | "surfaces" | "quantity" | "notes" | "reprice" | "reason"
  >,
): UpdatePlanItemRequest | null {
  const fields = changedFields(
    {
      toothCode: form.toothCode ?? null,
      surfaces: form.surfaces ?? [],
      quantity: form.quantity,
      notes: form.notes || null,
    },
    item,
  );
  const patch: UpdatePlanItemRequest = { ...fields };
  if ("toothCode" in fields || "surfaces" in fields) {
    patch.toothCode = form.toothCode ?? null;
    patch.surfaces = form.surfaces ?? [];
  }
  if (form.reprice) patch.reprice = true;
  if (Object.keys(patch).length === 0) return null;
  if (form.reason) patch.reason = form.reason;
  return patch;
}

/**
 * Full POST /plans/:id/items/reorder list that moves one item to the end of another phase and
 * keeps every other item in its current order (the server renumbers sequences 1..n per phase).
 */
export function reorderToPhase(
  items: readonly { id: string; phase: number; sequence: number }[],
  itemId: string,
  phase: number,
): { itemId: string; phase: number }[] {
  const ordered = [...items].sort((a, b) => a.phase - b.phase || a.sequence - b.sequence);
  const item = ordered.find((i) => i.id === itemId);
  if (!item) return ordered.map((i) => ({ itemId: i.id, phase: i.phase }));
  const rest = ordered.filter((i) => i.id !== itemId);
  const lastIdx = rest.reduce((at, i, k) => (i.phase <= phase ? k : at), -1);
  const next = [...rest.slice(0, lastIdx + 1), { ...item, phase }, ...rest.slice(lastIdx + 1)];
  return next.map((i) => ({ itemId: i.id, phase: i.phase }));
}
