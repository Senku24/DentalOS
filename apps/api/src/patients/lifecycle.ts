import type { PATIENT_LIFECYCLE_STAGES } from "@dentalos/validation";

export type LifecycleStage = (typeof PATIENT_LIFECYCLE_STAGES)[number];

/**
 * Allowed patient lifecycle moves (PRD 4.2: registration → visits → treatment → follow-up → recall).
 * The journey is cyclical: a recall or follow-up visit can start a new course of treatment.
 * INACTIVE is reachable from anywhere (moved away, deceased, lost to follow-up) and only leaves via
 * reactivation to ACTIVE. Nothing returns to REGISTERED: it only means "registered, never seen".
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleStage, readonly LifecycleStage[]> = {
  REGISTERED: ["ACTIVE", "IN_TREATMENT", "INACTIVE"],
  ACTIVE: ["IN_TREATMENT", "FOLLOW_UP", "RECALL", "INACTIVE"],
  IN_TREATMENT: ["FOLLOW_UP", "ACTIVE", "INACTIVE"],
  FOLLOW_UP: ["RECALL", "IN_TREATMENT", "ACTIVE", "INACTIVE"],
  RECALL: ["ACTIVE", "IN_TREATMENT", "INACTIVE"],
  INACTIVE: ["ACTIVE"],
};

/** A same-stage "move" is a no-op and allowed. */
export function canTransition(from: LifecycleStage, to: LifecycleStage): boolean {
  return from === to || LIFECYCLE_TRANSITIONS[from].includes(to);
}
