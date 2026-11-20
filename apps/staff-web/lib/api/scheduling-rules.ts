import type { Permission } from "@dentalos/contracts";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITION_PERMISSIONS,
  type AppointmentStatus,
  DEFAULT_NO_SHOW_GRACE_MINUTES,
  MAX_APPOINTMENT_LIST,
  type TreatmentPlanStatus,
  allowedAppointmentTransitions,
  isNoShowEligible,
} from "@dentalos/validation";
import { asApiError } from "./errors";
import { formatTime, fullDayLabel, localOf, todayIn } from "./scheduling-time";

/**
 * Front-desk rules the UI mirrors for DISPLAY only (the API re-checks every one):
 *  - which status buttons to show: allowedAppointmentTransitions ∩ the caller's permission for the
 *    target status (APPOINTMENT_TRANSITION_PERMISSIONS, against the appointment's branch);
 *  - when check-in / no-show are disabled (check-in day rule, no-show grace — ADR 0003 + addendum);
 *  - how every scheduling 409/400 is explained (slot_conflict → which resource, outside hours, …).
 */

export type CanFn = (perm: Permission, resource?: { branchId?: string }) => boolean;

/** API walk-in window (appointments.service.ts WALK_IN_WINDOW_MIN). */
export const WALK_IN_WINDOW_MIN = 30;

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  BOOKED: "Booked",
  CONFIRMED: "Confirmed",
  CHECKED_IN: "Waiting",
  IN_CHAIR: "In chair",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "No-show",
  RESCHEDULED: "Rescheduled",
};

export type StatusTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";
export const STATUS_TONES: Record<AppointmentStatus, StatusTone> = {
  BOOKED: "neutral",
  CONFIRMED: "info",
  CHECKED_IN: "warning",
  IN_CHAIR: "brand",
  COMPLETED: "success",
  CANCELLED: "danger",
  NO_SHOW: "danger",
  RESCHEDULED: "neutral",
};

export const isActiveStatus = (s: AppointmentStatus) =>
  (ACTIVE_APPOINTMENT_STATUSES as readonly AppointmentStatus[]).includes(s);

/** Status moves made through POST /appointments/:id/status (cancel/reschedule have their own). */
export const STATUS_ROUTE_TARGETS = [
  "CONFIRMED",
  "CHECKED_IN",
  "IN_CHAIR",
  "COMPLETED",
  "NO_SHOW",
] as const satisfies readonly AppointmentStatus[];
export type StatusRouteTarget = (typeof STATUS_ROUTE_TARGETS)[number];

const ACTION_LABELS: Record<StatusRouteTarget, string> = {
  CONFIRMED: "Confirm",
  CHECKED_IN: "Check in",
  IN_CHAIR: "Seat in chair",
  COMPLETED: "Complete visit",
  NO_SHOW: "Mark no-show",
};

export function mayMoveInto(can: CanFn, to: AppointmentStatus, branchId: string): boolean {
  return (APPOINTMENT_TRANSITION_PERMISSIONS[to] as readonly Permission[]).some((perm) =>
    can(perm, { branchId }),
  );
}

export type CheckInWindow =
  | { ok: true }
  | { ok: false; reason: "too_early"; eligibleDay: string }
  | { ok: false; reason: "too_late"; day: string };

/**
 * Mirrors assertCheckInDay (appointments.service.ts): allowed within ±30 min of start, else only on
 * the visit's own branch-local day.
 */
export function checkInWindow(startsAt: string, timeZone: string, now: Date): CheckInWindow {
  const start = Date.parse(startsAt);
  if (Math.abs(start - now.getTime()) <= WALK_IN_WINDOW_MIN * 60_000) return { ok: true };
  const day = localOf(startsAt, timeZone).date;
  const today = todayIn(timeZone, now);
  if (day > today) return { ok: false, reason: "too_early", eligibleDay: day };
  if (day < today) return { ok: false, reason: "too_late", day };
  return { ok: true };
}

export interface StatusAction {
  to: StatusRouteTarget;
  label: string;
  enabled: boolean;
  /** Why it is disabled (shown next to / as the description of the button). */
  reason?: string;
}

export interface AppointmentLike {
  status: AppointmentStatus;
  startsAt: string;
  branchId: string;
}

/** Status buttons for an appointment. Moves the caller may not make are omitted, not disabled. */
export function statusActions(
  a: AppointmentLike,
  opts: { can: CanFn; now: Date; timeZone: string; noShowGraceMinutes?: number },
): StatusAction[] {
  const grace = opts.noShowGraceMinutes ?? DEFAULT_NO_SHOW_GRACE_MINUTES;
  const out: StatusAction[] = [];
  for (const to of allowedAppointmentTransitions(a.status)) {
    if (!(STATUS_ROUTE_TARGETS as readonly string[]).includes(to)) continue;
    const target = to as StatusRouteTarget;
    if (!mayMoveInto(opts.can, target, a.branchId)) continue;
    const action: StatusAction = { to: target, label: ACTION_LABELS[target], enabled: true };
    if (target === "CHECKED_IN") {
      const w = checkInWindow(a.startsAt, opts.timeZone, opts.now);
      if (!w.ok) {
        action.enabled = false;
        action.reason =
          w.reason === "too_early"
            ? `Check-in opens on ${fullDayLabel(w.eligibleDay)}.`
            : `This visit was on ${fullDayLabel(w.day)}. Mark it as a no-show or reschedule it.`;
      }
    }
    if (target === "NO_SHOW" && !isNoShowEligible(new Date(a.startsAt), opts.now, grace)) {
      const at = new Date(Date.parse(a.startsAt) + grace * 60_000).toISOString();
      action.enabled = false;
      action.reason = `No-show can be recorded from ${formatTime(at, opts.timeZone)} (${grace} min grace).`;
    }
    out.push(action);
  }
  return out;
}

export interface ManageActions {
  cancel: boolean;
  reschedule: boolean;
  /** PATCH dentist/chair/type/notes (allowed while the visit is active). */
  edit: boolean;
}

/**
 * The closed-state note on the detail page depends on the STATUS, not on the caller's permission:
 * an active visit the caller can't edit is not "closed" (e.g. a DENTIST without appointment:write
 * can still seat a checked-in patient).
 */
export function closedNote(a: AppointmentLike, manage: ManageActions): string | null {
  if (allowedAppointmentTransitions(a.status).length === 0)
    return `This appointment is ${STATUS_LABELS[a.status].toLowerCase()} and can no longer change.`;
  if (!manage.edit && !manage.cancel && !manage.reschedule)
    return "Your role can't edit, reschedule or cancel appointments.";
  return null;
}

export function manageActions(a: AppointmentLike, can: CanFn): ManageActions {
  const allowed = allowedAppointmentTransitions(a.status);
  const write = can("appointment:write", { branchId: a.branchId });
  return {
    cancel: write && allowed.includes("CANCELLED"),
    reschedule: write && allowed.includes("RESCHEDULED"),
    edit: write && isActiveStatus(a.status),
  };
}

// ---------------------------------------------------------------------------------------------
// Calendar list window
// ---------------------------------------------------------------------------------------------

/** GET /appointments stops at this many rows (no cursor) and then answers `truncated: true`. */
export const APPOINTMENT_LIST_CAP = MAX_APPOINTMENT_LIST;

/**
 * Statuses the calendar asks for, so closed rows the grid would hide don't use up the 1000-row cap:
 * active + COMPLETED, plus CANCELLED and NO_SHOW when "show cancelled and no-shows" is on.
 * RESCHEDULED is never shown (its successor is).
 */
export function calendarStatuses(showClosed: boolean): AppointmentStatus[] {
  const base = [
    ...(ACTIVE_APPOINTMENT_STATUSES as readonly AppointmentStatus[]),
    "COMPLETED",
  ] as AppointmentStatus[];
  return showClosed ? [...base, "CANCELLED", "NO_SHOW"] : base;
}

/**
 * True when GET /appointments cut the list at its cap (later rows missing). Uses the server's
 * `truncated` flag; a response without it (older server) is judged by its length.
 */
export const listTruncated = (r: { items: readonly unknown[]; truncated?: boolean }) =>
  r.truncated ?? r.items.length >= APPOINTMENT_LIST_CAP;

// ---------------------------------------------------------------------------------------------
// Plan-item link
// ---------------------------------------------------------------------------------------------

/**
 * Plans whose ACCEPTED items a booking may link to. The API (scheduling/plan-link.ts) only checks
 * the ITEM status (ACCEPTED); PARTIALLY_ACCEPTED plans hold accepted items too. Typed against
 * TreatmentPlanStatus so an invalid status fails typecheck.
 */
export const BOOKABLE_PLAN_STATUSES = [
  "PRESENTED",
  "ACCEPTED",
  "PARTIALLY_ACCEPTED",
] as const satisfies readonly TreatmentPlanStatus[];

export const isBookablePlan = (p: { status: TreatmentPlanStatus }) =>
  (BOOKABLE_PLAN_STATUSES as readonly TreatmentPlanStatus[]).includes(p.status);

// ---------------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------------

export interface SchedulingProblem {
  code: string;
  title: string;
  message: string;
  /** Form field to mark invalid ("dentistUserId", "chairId", "startsAt", "patientId", …). */
  field?: string;
  /** slot_conflict: which resource is double-booked. */
  resource?: "dentist" | "chair";
  /** outside_working_hours and the caller may override with a reason. */
  offerOutsideHoursReason?: boolean;
  /** patient_merged: the surviving record to use instead. */
  survivorId?: string;
  /** Per-field messages from a 400 validation_failed. */
  fieldErrors?: Record<string, string>;
}

export interface ProblemContext {
  /** Display-only schedule:manage on the booking's branch. */
  canManageSchedule?: boolean;
  timeZone?: string;
  dentistLabel?: string;
  chairLabel?: string;
}

const STATUS_NAME = (s: unknown) =>
  typeof s === "string" && s in STATUS_LABELS ? STATUS_LABELS[s as AppointmentStatus] : String(s);

/** Turns any scheduling API failure into copy + the field to highlight. Pure: unit tested. */
export function describeSchedulingError(e: unknown, ctx: ProblemContext = {}): SchedulingProblem {
  const err = asApiError(e);
  const b = err.body;
  const code = err.code ?? err.kind;
  const tz = ctx.timeZone;
  const when = (iso: unknown) =>
    typeof iso === "string" && tz
      ? `${fullDayLabel(localOf(iso, tz).date)} ${formatTime(iso, tz)}`
      : "";

  switch (code) {
    case "slot_conflict": {
      const resource = b.resource === "chair" ? "chair" : "dentist";
      const who =
        resource === "chair"
          ? ctx.chairLabel
            ? `Chair ${ctx.chairLabel}`
            : "The chair"
          : (ctx.dentistLabel ?? "The dentist");
      return {
        code,
        resource,
        field: resource === "chair" ? "chairId" : "dentistUserId",
        title: resource === "chair" ? "Chair already booked" : "Dentist already booked",
        message: `${who} already has an appointment that overlaps this time. Pick another time, ${
          resource === "chair" ? "another chair or leave the chair unassigned" : "another dentist"
        }.`,
      };
    }
    case "outside_working_hours": {
      const branchForbids =
        typeof b.message === "string" && /does not allow/i.test(b.message as string);
      const offer = !branchForbids && Boolean(ctx.canManageSchedule);
      return {
        code,
        field: "startsAt",
        offerOutsideHoursReason: offer,
        title: "Outside working hours",
        message: branchForbids
          ? "This branch does not allow bookings outside working hours. Choose a time within the branch, dentist and chair hours."
          : offer
            ? "This time is outside the branch, dentist or chair working hours. Add a reason to book it anyway, or choose another time."
            : "This time is outside the branch, dentist or chair working hours. Choose another time, or ask a manager to book it.",
      };
    }
    case "invalid_transition": {
      const allowed = Array.isArray(b.allowed) ? (b.allowed as unknown[]).map(STATUS_NAME) : [];
      return {
        code,
        title: "Status changed",
        message: `This appointment can't move from ${STATUS_NAME(b.from)} to ${STATUS_NAME(b.to)}${
          allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (it is closed)"
        }. It may have been updated elsewhere; refresh to see the latest.`,
      };
    }
    case "check_in_too_early":
      return {
        code,
        title: "Too early to check in",
        message: `Check-in is only possible on the day of the visit${
          when(b.eligibleFrom) ? ` (from ${when(b.eligibleFrom)})` : ""
        }.`,
      };
    case "check_in_too_late":
      return {
        code,
        title: "Visit day has passed",
        message: `This visit was scheduled for ${
          when(b.startsAt) || "an earlier day"
        }. Mark it as a no-show or reschedule it.`,
      };
    case "no_show_too_early":
      return {
        code,
        title: "Too early for no-show",
        message: `A no-show can be recorded after the grace period${
          when(b.eligibleAt) ? ` (from ${when(b.eligibleAt)})` : ""
        }.`,
      };
    case "patient_merged": {
      const survivor = err.mergedSurvivorId;
      return {
        code,
        field: "patientId",
        survivorId: survivor,
        title: "Patient record was merged",
        message:
          "This patient was merged into another record. Book for the surviving record instead.",
      };
    }
    case "dentist_required":
      return {
        code,
        field: "dentistUserId",
        title: "Dentist required",
        message: "This branch requires a dentist on every booking.",
      };
    case "dentist_not_assigned":
      return {
        code,
        field: typeof b.field === "string" ? (b.field as string) : "dentistUserId",
        title: "Dentist not at this branch",
        message: "The dentist is not assigned to this branch on that date.",
      };
    case "not_a_dentist":
    case "not_a_member":
      return {
        code,
        field: typeof b.field === "string" ? (b.field as string) : "dentistUserId",
        title: "Not a dentist here",
        message: "The selected person is not a dentist in this organisation.",
      };
    case "chair_inactive":
      return {
        code,
        field: "chairId",
        title: "Chair inactive",
        message: "That chair is deactivated. Choose another chair.",
      };
    case "chair_not_found":
      return {
        code,
        field: "chairId",
        title: "Chair not found",
        message: "That chair does not belong to this branch.",
      };
    case "chair_code_taken":
      return {
        code,
        field: "code",
        title: "Code in use",
        message: "Another chair at this branch already uses that code.",
      };
    case "branch_inactive":
      return {
        code,
        title: "Branch inactive",
        message: "This branch is inactive and cannot take bookings.",
      };
    case "appointment_closed":
      return {
        code,
        title: "Appointment closed",
        message: `This appointment is ${STATUS_NAME(b.status)} and can no longer be edited.`,
      };
    case "appointment_changed":
    case "plan_item_changed":
      return {
        code,
        title: "Changed elsewhere",
        message: "Someone else changed this at the same time. Refresh and try again.",
      };
    case "plan_item_not_found":
    case "plan_item_patient_mismatch":
      return {
        code,
        field: "planItemId",
        title: "Plan item unavailable",
        message: "That treatment-plan item can't be linked to this patient's booking.",
      };
    case "reason_required":
      return {
        code,
        field: "reason",
        title: "Reason required",
        message: "Give a reason (at least 3 characters).",
      };
    case "working_hours_in_force":
      return {
        code,
        field: "effectiveFrom",
        title: "Hours already in force today",
        message:
          "These hours already took effect today. Set the change from tomorrow or a later date.",
      };
    case "working_hours_overlap":
      return {
        code,
        field: "sessions",
        title: "Overlapping hours",
        message:
          "These sessions overlap existing hours for this subject (a dentist's sessions may not overlap across branches).",
      };
    case "validation_failed":
      return {
        code,
        title: "Check the details",
        message: Object.values(err.fieldErrors)[0] ?? err.message,
        fieldErrors: err.fieldErrors,
        field: Object.keys(err.fieldErrors)[0],
      };
    default:
      return { code, title: "Couldn't save", message: err.message };
  }
}
