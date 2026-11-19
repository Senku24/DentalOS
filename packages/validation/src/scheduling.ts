import { z } from "zod";
import {
  dateOnly,
  isoDateTime,
  optionalText,
  staffUserId,
  timeZone,
  trimmed,
  uuid,
} from "./common";
import { patientSummary } from "./patients";
import { type TransitionTable, allowedTransitions, canTransition } from "./state-machine";

// Scheduling & front desk (PRD 4.3): chairs, working hours, availability, appointments, check-in.
// State machine and knobs: docs/adr/0003-clinical-domain-rules.md (PROPOSED — needs product sign-off).

export const WORKING_HOURS_SCOPES = ["BRANCH", "DENTIST", "CHAIR"] as const;
export const APPOINTMENT_STATUSES = [
  "BOOKED",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_CHAIR",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "RESCHEDULED",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export const APPOINTMENT_SOURCES = ["SCHEDULED", "WALK_IN", "URGENT"] as const;
/** Initial catalogue (DB column is text so it can grow without a migration). */
export const APPOINTMENT_TYPES = [
  "CONSULTATION",
  "CHECKUP",
  "TREATMENT",
  "FOLLOW_UP",
  "HYGIENE",
  "EMERGENCY",
  "REVIEW",
  "OTHER",
] as const;

export const workingHoursScope = z.enum(WORKING_HOURS_SCOPES);
export const appointmentStatus = z.enum(APPOINTMENT_STATUSES);
export const appointmentSource = z.enum(APPOINTMENT_SOURCES);
export const appointmentType = z.enum(APPOINTMENT_TYPES);

/**
 * Statuses that occupy a dentist/chair slot. MUST equal the `status IN (...)` list of the
 * Appointment_*_no_overlap exclusion constraints in migration 0006 (asserted in apps/api tests).
 */
export const ACTIVE_APPOINTMENT_STATUSES = [
  "BOOKED",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_CHAIR",
] as const satisfies readonly AppointmentStatus[];

/**
 * ADR 0003 (proposed). Rescheduling never edits times in place: the old row moves to RESCHEDULED
 * and a NEW row (rescheduledFromId -> old) is BOOKED — mark the old row first, in the same
 * transaction, or the exclusion constraint sees both. Cancel needs a reason (DB CHECK).
 * NO_SHOW only once `startsAt + noShowGraceMinutes` has passed (see `isNoShowEligible`).
 */
export const APPOINTMENT_TRANSITIONS: TransitionTable<AppointmentStatus> = {
  BOOKED: ["CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW", "RESCHEDULED"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW", "RESCHEDULED"],
  CHECKED_IN: ["IN_CHAIR", "CANCELLED"],
  IN_CHAIR: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  RESCHEDULED: [],
};

export const canTransitionAppointment = (from: AppointmentStatus, to: AppointmentStatus) =>
  canTransition(APPOINTMENT_TRANSITIONS, from, to);
export const allowedAppointmentTransitions = (from: AppointmentStatus) =>
  allowedTransitions(APPOINTMENT_TRANSITIONS, from);

/** Target statuses that need a reason (stored as cancelReason / AppointmentEvent.reason). */
export const APPOINTMENT_REASON_REQUIRED: readonly AppointmentStatus[] = [
  "CANCELLED",
  "RESCHEDULED",
];

/**
 * Permission needed to move an appointment INTO a status (any one of the list), checked with the
 * appointment's branch. Strings are @dentalos/contracts permission names (asserted in apps/api).
 * Dentists move IN_CHAIR/COMPLETED through clinical:write (e.g. when opening/closing an encounter).
 */
export const APPOINTMENT_TRANSITION_PERMISSIONS: Readonly<
  Record<AppointmentStatus, readonly string[]>
> = {
  BOOKED: ["appointment:write"],
  CONFIRMED: ["appointment:write"],
  CHECKED_IN: ["appointment:checkin"],
  IN_CHAIR: ["appointment:checkin", "clinical:write"],
  COMPLETED: ["appointment:checkin", "clinical:write"],
  CANCELLED: ["appointment:write"],
  NO_SHOW: ["appointment:checkin"],
  RESCHEDULED: ["appointment:write"],
};

// ---------------------------------------------------------------------------------------------
// Per-branch knobs (Branch.settings.scheduling) — ADR 0003 "Configuration knobs"
// ---------------------------------------------------------------------------------------------

export const DEFAULT_NO_SHOW_GRACE_MINUTES = 15;

const schedulingSettingsShape = {
  /** Minutes after startsAt before an un-arrived appointment may be marked NO_SHOW. */
  noShowGraceMinutes: z.number().int().min(0).max(240),
  /** Calendar grid / availability step. */
  slotMinutes: z.number().int().min(5).max(120),
  /** PRD 4.3 permits unassigned dentists; a branch may require assignment at booking. */
  allowUnassignedDentist: z.boolean(),
  /** When false, nobody may book outside working hours (not even with schedule:manage + reason). */
  allowOutsideHoursBooking: z.boolean(),
};
export const schedulingSettings = z.strictObject({
  noShowGraceMinutes: schedulingSettingsShape.noShowGraceMinutes.default(
    DEFAULT_NO_SHOW_GRACE_MINUTES,
  ),
  slotMinutes: schedulingSettingsShape.slotMinutes.default(15),
  allowUnassignedDentist: schedulingSettingsShape.allowUnassignedDentist.default(true),
  allowOutsideHoursBooking: schedulingSettingsShape.allowOutsideHoursBooking.default(true),
});
export type SchedulingSettings = z.infer<typeof schedulingSettings>;

/** Branch.settings JSON. Unknown keys rejected so typos never silently become no-ops. */
export const branchSettings = z.strictObject({ scheduling: schedulingSettings.optional() });
export type BranchSettings = z.infer<typeof branchSettings>;

/** PATCH: no defaults (absent keys keep the stored value). */
export const updateSchedulingSettingsRequest = z.strictObject({
  noShowGraceMinutes: schedulingSettingsShape.noShowGraceMinutes.optional(),
  slotMinutes: schedulingSettingsShape.slotMinutes.optional(),
  allowUnassignedDentist: schedulingSettingsShape.allowUnassignedDentist.optional(),
  allowOutsideHoursBooking: schedulingSettingsShape.allowOutsideHoursBooking.optional(),
});
export type UpdateSchedulingSettingsRequest = z.infer<typeof updateSchedulingSettingsRequest>;

export const schedulingSettingsResponse = z.object({
  branchId: uuid,
  ...schedulingSettingsShape,
});
export type SchedulingSettingsResponse = z.infer<typeof schedulingSettingsResponse>;

/** Effective knobs for a branch from its raw `settings` JSON; anything missing/invalid -> defaults. */
export function resolveSchedulingSettings(rawBranchSettings: unknown): SchedulingSettings {
  const raw =
    rawBranchSettings && typeof rawBranchSettings === "object"
      ? (rawBranchSettings as { scheduling?: unknown }).scheduling
      : undefined;
  const parsed = schedulingSettings.safeParse(raw ?? {});
  return parsed.success ? parsed.data : schedulingSettings.parse({});
}

/** True once the grace period after `startsAt` has elapsed. */
export function isNoShowEligible(
  startsAt: Date,
  now: Date,
  graceMinutes = DEFAULT_NO_SHOW_GRACE_MINUTES,
): boolean {
  return now.getTime() >= startsAt.getTime() + graceMinutes * 60_000;
}

// ---------------------------------------------------------------------------------------------
// Time helpers (Intl only — no date library). Working hours are local branch time.
// ---------------------------------------------------------------------------------------------

/** 570 -> "09:30". */
export function minutesToHHMM(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "09:30" -> 570; "24:00" -> 1440 (end of day). */
export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new RangeError(`Expected HH:MM, got ${hhmm}`);
  const total = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || total > 1440) throw new RangeError(`Out of range: ${hhmm}`);
  return total;
}

function offsetMinutes(instant: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Local wall-clock (`date` "YYYY-MM-DD" + minutes after midnight) in `tz` -> UTC instant. */
export function zonedToUtc(date: string, minuteOfDay: number, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, 0, minuteOfDay);
  const first = offsetMinutes(new Date(guess), tz);
  const t = guess - first * 60_000;
  const second = offsetMinutes(new Date(t), tz);
  return new Date(second === first ? t : guess - second * 60_000);
}

/** UTC instant -> local date, weekday (0 = Sunday) and minute of day in `tz`. */
export function utcToZoned(
  instant: Date,
  tz: string,
): { date: string; weekday: number; minuteOfDay: number } {
  const local = new Date(instant.getTime() + offsetMinutes(instant, tz) * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    minuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

// ---------------------------------------------------------------------------------------------
// Chairs
// ---------------------------------------------------------------------------------------------

/** Stored upper-case, unique per branch (DB CHECK + unique index). */
export const chairCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,15}$/, "1-16 chars: letters, digits, _ or -");

export const createChairRequest = z.object({
  branchId: uuid,
  code: chairCode,
  name: trimmed(80),
});
export type CreateChairRequest = z.infer<typeof createChairRequest>;

/** PATCH. A chair is deactivated, never deleted. */
export const updateChairRequest = z.object({
  code: chairCode.optional(),
  name: trimmed(80).optional(),
  active: z.boolean().optional(),
});
export type UpdateChairRequest = z.infer<typeof updateChairRequest>;

export const listChairsQuery = z.object({
  branchId: uuid.optional(),
  active: z.stringbool().optional(),
});
export type ListChairsQuery = z.infer<typeof listChairsQuery>;

export const chairResponse = z.object({
  id: uuid,
  branchId: uuid,
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  createdAt: isoDateTime,
});
export type ChairResponse = z.infer<typeof chairResponse>;

// ---------------------------------------------------------------------------------------------
// Working hours (effective-dated; weekday 0 = Sunday; minutes after local midnight, [start, end))
// ---------------------------------------------------------------------------------------------

export const workingHoursSession = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .refine((s) => s.startMinute < s.endMinute, "startMinute must be before endMinute");
export type WorkingHoursSession = z.infer<typeof workingHoursSession>;

/**
 * Replaces the subject's weekly schedule from `effectiveFrom`: the API closes the open rows
 * (effectiveTo = effectiveFrom) and inserts `sessions`. An empty list = closed from that date.
 */
export const setWorkingHoursRequest = z
  .object({
    scope: workingHoursScope,
    branchId: uuid,
    userId: staffUserId.optional(),
    chairId: uuid.optional(),
    effectiveFrom: dateOnly,
    sessions: z.array(workingHoursSession).max(28),
    reason: optionalText(500),
  })
  .superRefine((v, ctx) => {
    const needsUser = v.scope === "DENTIST";
    const needsChair = v.scope === "CHAIR";
    if (needsUser !== (v.userId !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "userId is required iff scope is DENTIST",
        path: ["userId"],
      });
    if (needsChair !== (v.chairId !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "chairId is required iff scope is CHAIR",
        path: ["chairId"],
      });
    const sorted = [...v.sessions].sort(
      (x, y) => x.weekday - y.weekday || x.startMinute - y.startMinute,
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev && cur && prev.weekday === cur.weekday && prev.endMinute > cur.startMinute) {
        ctx.addIssue({ code: "custom", message: "Sessions overlap", path: ["sessions"] });
        break;
      }
    }
  });
export type SetWorkingHoursRequest = z.infer<typeof setWorkingHoursRequest>;

export const listWorkingHoursQuery = z.object({
  branchId: uuid,
  scope: workingHoursScope.optional(),
  userId: staffUserId.optional(),
  chairId: uuid.optional(),
  /** Rows in force on this local date (default: today in the branch time zone). */
  on: dateOnly.optional(),
  /** Include closed and future rows. */
  includeHistory: z.stringbool().default(false),
});
export type ListWorkingHoursQuery = z.infer<typeof listWorkingHoursQuery>;

export const workingHoursResponse = z.object({
  id: uuid,
  scope: workingHoursScope,
  branchId: uuid,
  userId: z.string().nullable(),
  chairId: uuid.nullable(),
  weekday: z.number().int(),
  startMinute: z.number().int(),
  endMinute: z.number().int(),
  effectiveFrom: dateOnly,
  effectiveTo: dateOnly.nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
});
export type WorkingHoursResponse = z.infer<typeof workingHoursResponse>;

// ---------------------------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------------------------

export const availabilityQuery = z.object({
  branchId: uuid,
  /** Local date in the branch time zone. */
  date: dateOnly,
  durationMin: z.coerce.number().int().min(5).max(480),
  dentistUserId: staffUserId.optional(),
  chairId: uuid.optional(),
  /** Defaults to the branch's slotMinutes. */
  stepMin: z.coerce.number().int().min(5).max(120).optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuery>;

export const availabilitySlot = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /** Active chairs free for the whole slot (just `chairId` when one was requested). */
  chairIds: z.array(uuid),
});
export const availabilityResponse = z.object({
  branchId: uuid,
  date: dateOnly,
  timeZone,
  durationMin: z.number().int(),
  slots: z.array(availabilitySlot),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponse>;

// ---------------------------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------------------------

const durationMin = z.number().int().min(5).max(720);
const outsideHoursReason = trimmed(500).min(3);

export const bookAppointmentRequest = z.object({
  patientId: uuid,
  branchId: uuid,
  startsAt: isoDateTime,
  durationMin,
  /** Omit for an unassigned booking (PRD 4.3) unless the branch disallows it. */
  dentistUserId: staffUserId.optional(),
  chairId: uuid.optional(),
  appointmentType: appointmentType.default("CONSULTATION"),
  source: appointmentSource.default("SCHEDULED"),
  /** Links the visit to a treatment-plan item (FK only). */
  planItemId: uuid.optional(),
  notes: optionalText(2000),
  /** Required (with schedule:manage) when the slot is outside working hours -> else 409 outside_working_hours. */
  outsideHoursReason: outsideHoursReason.optional(),
});
export type BookAppointmentRequest = z.infer<typeof bookAppointmentRequest>;

/** Walk-in / urgent visit: starts now (or `startsAt`) and is checked in immediately by default. */
export const createWalkInRequest = z.object({
  patientId: uuid,
  branchId: uuid,
  source: z.enum(["WALK_IN", "URGENT"]).default("WALK_IN"),
  startsAt: isoDateTime.optional(),
  durationMin: durationMin.default(30),
  dentistUserId: staffUserId.optional(),
  chairId: uuid.optional(),
  appointmentType: appointmentType.optional(),
  notes: optionalText(2000),
  checkIn: z.boolean().default(true),
});
export type CreateWalkInRequest = z.infer<typeof createWalkInRequest>;

/**
 * Creates a NEW appointment linked to the old one (old -> RESCHEDULED). Omitted fields are copied
 * from the old appointment; `null` clears the dentist/chair.
 */
export const rescheduleAppointmentRequest = z.object({
  startsAt: isoDateTime,
  durationMin: durationMin.optional(),
  dentistUserId: staffUserId.nullable().optional(),
  chairId: uuid.nullable().optional(),
  reason: trimmed(500).min(3),
  outsideHoursReason: outsideHoursReason.optional(),
});
export type RescheduleAppointmentRequest = z.infer<typeof rescheduleAppointmentRequest>;

export const cancelAppointmentRequest = z.object({ reason: trimmed(500).min(3) });
export type CancelAppointmentRequest = z.infer<typeof cancelAppointmentRequest>;

/** POST /appointments/:id/status — cancel and reschedule have their own endpoints. */
export const appointmentTransitionRequest = z.object({
  to: appointmentStatus.extract(["CONFIRMED", "CHECKED_IN", "IN_CHAIR", "COMPLETED", "NO_SHOW"]),
  reason: optionalText(500),
});
export type AppointmentTransitionRequest = z.infer<typeof appointmentTransitionRequest>;

/** PATCH (no time changes — use reschedule). `null` clears; re-assignment is conflict-checked. */
export const updateAppointmentRequest = z.object({
  appointmentType: appointmentType.optional(),
  dentistUserId: staffUserId.nullable().optional(),
  chairId: uuid.nullable().optional(),
  planItemId: uuid.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateAppointmentRequest = z.infer<typeof updateAppointmentRequest>;

/** "BOOKED,CONFIRMED" (query string) -> ["BOOKED", "CONFIRMED"]. */
const statusList = z
  .string()
  .max(200)
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(appointmentStatus).min(1));

export const MAX_APPOINTMENT_RANGE_DAYS = 42;

/** Calendar (day/week/month) needs from+to (<= 42 days); a patient's history needs only patientId. */
export const listAppointmentsQuery = z
  .object({
    branchId: uuid.optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    dentistUserId: staffUserId.optional(),
    chairId: uuid.optional(),
    patientId: uuid.optional(),
    status: statusList.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from === undefined || v.to === undefined) {
      if (v.patientId === undefined)
        ctx.addIssue({ code: "custom", message: "from and to are required", path: ["from"] });
      return;
    }
    const span = Date.parse(v.to) - Date.parse(v.from);
    if (span <= 0) ctx.addIssue({ code: "custom", message: "to must be after from", path: ["to"] });
    else if (span > MAX_APPOINTMENT_RANGE_DAYS * 86_400_000)
      ctx.addIssue({ code: "custom", message: "Range too large", path: ["to"] });
  });
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuery>;

export const appointmentResponse = z.object({
  id: uuid,
  patientId: uuid,
  branchId: uuid,
  dentistUserId: z.string().nullable(),
  chairId: uuid.nullable(),
  appointmentType: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  status: appointmentStatus,
  source: appointmentSource,
  rescheduledFromId: uuid.nullable(),
  /** Successor when this row was RESCHEDULED. */
  rescheduledToId: uuid.nullable().optional(),
  planItemId: uuid.nullable(),
  cancelReason: z.string().nullable(),
  outsideHoursReason: z.string().nullable(),
  notes: z.string().nullable(),
  checkedInAt: isoDateTime.nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /** Included by calendar/queue endpoints for display. */
  patient: patientSummary.optional(),
});
export type AppointmentResponse = z.infer<typeof appointmentResponse>;

export const appointmentEventResponse = z.object({
  id: uuid,
  appointmentId: uuid,
  fromStatus: appointmentStatus.nullable(),
  toStatus: appointmentStatus,
  actorId: z.string(),
  reason: z.string().nullable(),
  at: isoDateTime,
});
export type AppointmentEventResponse = z.infer<typeof appointmentEventResponse>;

export const appointmentDetailResponse = appointmentResponse.extend({
  events: z.array(appointmentEventResponse),
});
export type AppointmentDetailResponse = z.infer<typeof appointmentDetailResponse>;

// ---------------------------------------------------------------------------------------------
// Check-in & waiting queue
// ---------------------------------------------------------------------------------------------

export const checkInQueueQuery = z.object({
  branchId: uuid,
  /** Local date (default: today in the branch time zone). */
  date: dateOnly.optional(),
});
export type CheckInQueueQuery = z.infer<typeof checkInQueueQuery>;

export const queueEntryResponse = z.object({
  /** 1-based, ordered by checkedInAt (urgent visits first). */
  position: z.number().int().min(1),
  appointment: appointmentResponse,
  patient: patientSummary,
  waitingSince: isoDateTime.nullable(),
});
export const checkInQueueResponse = z.object({
  branchId: uuid,
  date: dateOnly,
  /** CHECKED_IN (waiting) and IN_CHAIR entries. */
  items: z.array(queueEntryResponse),
});
export type CheckInQueueResponse = z.infer<typeof checkInQueueResponse>;

/** Realtime (EventBus/SSE `data`) — ids and statuses only, never names or clinical text. */
export const SCHEDULING_EVENT_TYPES = [
  "appointment.created",
  "appointment.updated",
  "appointment.status_changed",
  "appointment.rescheduled",
  "appointment.cancelled",
] as const;
export const schedulingEventData = z.object({
  appointmentId: uuid,
  patientId: uuid,
  fromStatus: appointmentStatus.nullable(),
  toStatus: appointmentStatus,
  startsAt: isoDateTime,
  /** Set on appointment.rescheduled. */
  newAppointmentId: uuid.optional(),
});
export type SchedulingEventData = z.infer<typeof schedulingEventData>;

// ---------------------------------------------------------------------------------------------
// Error bodies the UI must handle
// ---------------------------------------------------------------------------------------------

/** 409 — exclusion constraint (SQLSTATE 23P01) or pre-check. */
export const slotConflictError = z.object({
  error: z.literal("slot_conflict"),
  resource: z.enum(["dentist", "chair"]),
  message: z.string().optional(),
});
/** 409 — booking outside working hours without schedule:manage + outsideHoursReason. */
export const outsideWorkingHoursError = z.object({
  error: z.literal("outside_working_hours"),
  message: z.string().optional(),
});
/** 409 — any state-machine violation (appointments, plan items, plans). */
export const invalidTransitionError = z.object({
  error: z.literal("invalid_transition"),
  from: z.string(),
  to: z.string(),
  allowed: z.array(z.string()),
});
export type SlotConflictError = z.infer<typeof slotConflictError>;
export type InvalidTransitionError = z.infer<typeof invalidTransitionError>;
