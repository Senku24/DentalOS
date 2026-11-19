import {
  ACTIVE_APPOINTMENT_STATUSES,
  type TransitionTable,
  allowedTransitions,
  canTransition,
} from "@dentalos/validation";

/**
 * PlanItemSession status (proposed addition to ADR 0003 §3.1 — needs product sign-off).
 *
 * The status is SERVER-DERIVED; clients never pick SCHEDULED or COMPLETED:
 *  - PLANNED    — default; no active appointment linked.
 *  - SCHEDULED  — an appointment is linked and is active (BOOKED / CONFIRMED / CHECKED_IN /
 *                 IN_CHAIR) or COMPLETED (visit done, treatment not yet recorded).
 *  - COMPLETED  — the linked encounter is SIGNED, or it holds a COMPLETED ProcedureRecord for this
 *                 plan item, or the explicit `POST /plan-item-sessions/:id/complete` action.
 *  - CANCELLED  — explicit cancel (PATCH `{ status: "CANCELLED" }`); sessions are never deleted.
 *
 * | From \ To | PLANNED | SCHEDULED | COMPLETED | CANCELLED |
 * |---|---|---|---|---|
 * | PLANNED   |   | ✔ appointment linked | ✔ encounter / procedure / complete | ✔ |
 * | SCHEDULED | ✔ appointment unlinked or cancelled / no-show / rescheduled | | ✔ | ✔ |
 * | COMPLETED / CANCELLED | terminal (notes only) | | | |
 *
 * The status is (re)computed whenever the session is written. A later change made by another module
 * (e.g. the appointment cancelled in scheduling) is picked up on the next session write.
 *
 * Side effects on the item (when the item table allows it): session SCHEDULED moves an ACCEPTED
 * item to SCHEDULED; session COMPLETED moves an ACCEPTED / SCHEDULED item to IN_PROGRESS; the item
 * goes back SCHEDULED -> ACCEPTED when its last scheduled session leaves SCHEDULED. Completing the
 * item itself stays an explicit clinician action (POST /plan-items/:id/status).
 *
 * Item-driven rules: item CANCELLED cancels its open sessions; item COMPLETED is refused (409
 * `item_has_scheduled_sessions`) while a session is SCHEDULED and cancels leftover PLANNED ones;
 * the SCHEDULED -> ACCEPTED undo and the ACCEPTED -> DEFERRED decision are refused (409
 * `item_still_scheduled`) while the item has a SCHEDULED session or an active appointment bound to
 * it. Appointment binding (`Appointment.planItemId`): one item per appointment (409
 * `appointment_linked_elsewhere`); cleared when the last open session of the item lets go of it
 * (unlink, replace or cancel).
 */
export type SessionStatus = "PLANNED" | "SCHEDULED" | "COMPLETED" | "CANCELLED";

export const PLAN_ITEM_SESSION_TRANSITIONS: TransitionTable<SessionStatus> = {
  PLANNED: ["SCHEDULED", "COMPLETED", "CANCELLED"],
  SCHEDULED: ["PLANNED", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const canTransitionSession = (from: SessionStatus, to: SessionStatus) =>
  canTransition(PLAN_ITEM_SESSION_TRANSITIONS, from, to);
export const allowedSessionTransitions = (from: SessionStatus) =>
  allowedTransitions(PLAN_ITEM_SESSION_TRANSITIONS, from);
export const isClosedSession = (s: SessionStatus) => s === "COMPLETED" || s === "CANCELLED";

/** Appointment statuses that make a linked session SCHEDULED. */
export const SCHEDULING_APPOINTMENT_STATUSES: readonly string[] = [
  ...ACTIVE_APPOINTMENT_STATUSES,
  "COMPLETED",
];

/**
 * Pure derivation from the facts the server loaded. `current` terminal states are sticky.
 */
export function deriveSessionStatus(
  current: SessionStatus,
  facts: {
    appointmentStatus: string | null;
    encounterSigned: boolean;
    procedureCompleted: boolean;
  },
): SessionStatus {
  if (isClosedSession(current)) return current;
  if (facts.encounterSigned || facts.procedureCompleted) return "COMPLETED";
  if (facts.appointmentStatus && SCHEDULING_APPOINTMENT_STATUSES.includes(facts.appointmentStatus))
    return "SCHEDULED";
  return "PLANNED";
}
