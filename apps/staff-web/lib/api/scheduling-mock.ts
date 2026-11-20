import type { Permission } from "@dentalos/contracts";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_REASON_REQUIRED,
  type AppointmentResponse,
  type AppointmentStatus,
  type BranchResponse,
  MAX_APPOINTMENT_LIST,
  type PatientResponse,
  type SchedulingEventData,
  type WorkingHoursResponse,
  allowedAppointmentTransitions,
  appointmentTransitionRequest,
  availabilityQuery,
  bookAppointmentRequest,
  canTransitionAppointment,
  cancelAppointmentRequest,
  checkInQueueQuery,
  createChairRequest,
  createWalkInRequest,
  isNoShowEligible,
  listAppointmentsQuery,
  listChairsQuery,
  listWorkingHoursQuery,
  rescheduleAppointmentRequest,
  setWorkingHoursRequest,
  updateAppointmentRequest,
  updateChairRequest,
  updateSchedulingSettingsRequest,
  type z,
} from "@dentalos/validation";
import type { Method, MockHandler } from "./client";
import { mapHttpError } from "./errors";
import * as F from "./fixtures";
import { mockHandler as sharedMockHandler } from "./mock";
import { API_PREFIX } from "./routes";
import { BRANCH_DENTISTS, buildSchedulingFixtures } from "./scheduling-fixtures";
import { covers, effectiveHours } from "./scheduling-hours";
import { WALK_IN_WINDOW_MIN, checkInWindow, mayMoveInto } from "./scheduling-rules";
import { addDays, localOf, todayIn, zonedIso } from "./scheduling-time";

/**
 * In-memory fake of the scheduling API (mock mode). Mirrors apps/api/src/scheduling: same zod
 * request schemas, same error bodies (409 slot_conflict {resource}, outside_working_hours,
 * invalid_transition {from,to,allowed}, check_in_too_early/late, patient_merged, working_hours_in_force,
 * no_show_too_early). Every other path falls through to the shared M1 mock, which also supplies the
 * patients (so patients registered at the desk in this session can be booked).
 */

const LATENCY_MS = 180;
const ACTIVE = ACTIVE_APPOINTMENT_STATUSES as readonly AppointmentStatus[];

let db = buildSchedulingFixtures();
let seq = 5000;
const newId = (kind: string) => F.fid(kind, ++seq);
const nowIso = () => new Date().toISOString();

/** Tests: rebuild state for a fixed clock. */
export function resetSchedulingMock(now: Date = new Date()) {
  db = buildSchedulingFixtures(now);
}
export const schedulingMockDb = () => db;

/** Display-only principal used by the mock; overridable in tests. */
let canFn: (perm: Permission, resource?: { branchId?: string }) => boolean = () => true;
let actorId = "dev-user";
export function setMockPrincipal(
  can: (perm: Permission, resource?: { branchId?: string }) => boolean,
  actor = "dev-user",
) {
  canFn = can;
  actorId = actor;
}
let principalLoaded = false;
async function ensurePrincipal() {
  if (principalLoaded) return;
  principalLoaded = true;
  try {
    const s = await import("../session");
    canFn = s.canDo;
    actorId = s.DEV_PRINCIPAL.userId;
  } catch {
    // Tests without the session module keep the permissive default.
  }
}

// ---- Realtime (mock SSE) ----------------------------------------------------------------------

export interface MockEvent {
  type: string;
  data: SchedulingEventData & { branchId: string };
}
const listeners = new Set<(e: MockEvent) => void>();
export function subscribeMockEvents(fn: (e: MockEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function publish(
  type: string,
  a: AppointmentResponse,
  fromStatus: AppointmentStatus | null,
  extra: { newAppointmentId?: string } = {},
) {
  const e: MockEvent = {
    type,
    data: {
      appointmentId: a.id,
      patientId: a.patientId,
      fromStatus,
      toStatus: a.status,
      startsAt: a.startsAt,
      branchId: a.branchId,
      ...extra,
    },
  };
  // Async like a network push, after the HTTP response resolves.
  setTimeout(() => {
    for (const l of listeners) l(e);
  }, 30);
}

// ---- Helpers --------------------------------------------------------------------------------

const fail = (
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  issues?: { path: string; message: string }[],
): never => {
  throw mapHttpError(status, { error, issues, ...extra });
};

function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    fail(
      400,
      "validation_failed",
      {},
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  return (r as { data: z.output<T> }).data;
}

const assertCan = (perm: Permission, branchId?: string) => {
  if (!canFn(perm, branchId ? { branchId } : undefined)) fail(403, "forbidden");
};
const assertMove = (to: AppointmentStatus, branchId: string) => {
  if (!mayMoveInto(canFn, to, branchId)) fail(403, "forbidden");
};

function branchOr404(id: string): BranchResponse {
  const b = F.branches.find((x) => x.id === id);
  if (!b) return fail(404, "branch_not_found");
  return b;
}
const tzOf = (branchId: string) => branchOr404(branchId).timezone;
const settingsOf = (branchId: string) =>
  db.settings[branchId] ?? {
    noShowGraceMinutes: 15,
    slotMinutes: 15,
    allowUnassignedDentist: true,
    allowOutsideHoursBooking: true,
  };

async function patientOr404(id: string): Promise<PatientResponse> {
  try {
    return (await sharedMockHandler("GET", `/patients/${id}`, {}, undefined)) as PatientResponse;
  } catch {
    return fail(404, "patient_not_found");
  }
}
/** Writes to a merged patient: 409 patient_merged + the survivor (M1 contract). */
async function activePatient(id: string): Promise<PatientResponse> {
  const p = await patientOr404(id);
  if (p.mergedIntoId)
    fail(409, "patient_merged", {
      message: "This patient was merged; edit the surviving record",
      mergedIntoId: p.mergedIntoId,
      survivorId: p.mergedIntoId,
    });
  return p;
}
const summary = (p: PatientResponse) => F.toPatientSummary(p);

function appointmentOr404(id: string) {
  const a = db.appointments.find((x) => x.id === id);
  if (!a) return fail(404, "appointment_not_found");
  return a;
}

function assertDentist(branchId: string, userId: string) {
  const staff = F.staff.find((s) => s.userId === userId);
  if (!staff) fail(400, "not_a_member", { field: "dentistUserId" });
  if (!staff?.roles.includes("DENTIST")) fail(400, "not_a_dentist", { field: "dentistUserId" });
  if (!(BRANCH_DENTISTS[branchId] ?? []).includes(userId))
    fail(400, "dentist_not_assigned", { field: "dentistUserId" });
}
function bookableChair(branchId: string, chairId: string) {
  const c = db.chairs.find((x) => x.id === chairId && x.branchId === branchId);
  if (!c) return fail(404, "chair_not_found");
  if (!c.active) fail(409, "chair_inactive");
  return c;
}

/** Same rule as the exclusion constraints: active rows of the same dentist or chair overlapping [s, e). */
function conflictResource(
  c: { startsAt: string; endsAt: string; dentistUserId: string | null; chairId: string | null },
  ignoreId?: string,
): "dentist" | "chair" | null {
  for (const a of db.appointments) {
    if (a.id === ignoreId || !ACTIVE.includes(a.status)) continue;
    if (!(a.startsAt < c.endsAt && a.endsAt > c.startsAt)) continue;
    if (c.dentistUserId && a.dentistUserId === c.dentistUserId) return "dentist";
    if (c.chairId && a.chairId === c.chairId) return "chair";
  }
  return null;
}

function insideHours(
  branchId: string,
  startsAt: string,
  durationMin: number,
  dentistUserId: string | null,
  chairId: string | null,
) {
  const tz = tzOf(branchId);
  const local = localOf(startsAt, tz);
  const hours = effectiveHours(db.hours, branchOr404(branchId), local.date, {
    dentistUserId,
    chairId,
  });
  return covers(hours, local.minuteOfDay, local.minuteOfDay + durationMin);
}

/** checkSlot (appointments.service.ts): validate refs, then the working-hours rule. */
function checkSlot(s: {
  branchId: string;
  startsAt: string;
  durationMin: number;
  dentistUserId: string | null;
  chairId: string | null;
  outsideHoursReason?: string;
}): string | null {
  if (s.dentistUserId) assertDentist(s.branchId, s.dentistUserId);
  if (s.chairId) bookableChair(s.branchId, s.chairId);
  if (insideHours(s.branchId, s.startsAt, s.durationMin, s.dentistUserId, s.chairId)) return null;
  if (!settingsOf(s.branchId).allowOutsideHoursBooking)
    fail(409, "outside_working_hours", {
      message: "This branch does not allow bookings outside working hours",
    });
  if (!canFn("schedule:manage", { branchId: s.branchId }) || !s.outsideHoursReason)
    fail(409, "outside_working_hours", {
      message: "Outside working hours: needs schedule:manage and outsideHoursReason",
    });
  return s.outsideHoursReason ?? null;
}

function recordEvent(
  a: AppointmentResponse,
  fromStatus: AppointmentStatus | null,
  toStatus: AppointmentStatus,
  reason: string | null,
) {
  db.events.push({
    id: newId("34"),
    appointmentId: a.id,
    fromStatus,
    toStatus,
    actorId,
    reason,
    at: nowIso(),
  });
}

function insert(o: Omit<AppointmentResponse, "id" | "createdAt" | "updatedAt" | "createdBy">) {
  const a: AppointmentResponse = {
    ...o,
    id: newId("33"),
    createdBy: actorId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.appointments.push(a);
  return a;
}

const withRescheduledTo = (a: AppointmentResponse) => ({
  ...a,
  rescheduledToId: db.appointments.find((x) => x.rescheduledFromId === a.id)?.id ?? null,
});
const detail = (a: AppointmentResponse) => ({
  ...withRescheduledTo(a),
  events: db.events
    .filter((e) => e.appointmentId === a.id)
    .sort((x, y) => x.at.localeCompare(y.at)),
});

function linkPlanItem(planItemId: string, patientId: string) {
  for (const plan of db.plans) {
    const item = plan.items.find((i) => i.id === planItemId);
    if (!item) continue;
    if (plan.patientId !== patientId) fail(400, "plan_item_patient_mismatch");
    if (item.status !== "ACCEPTED")
      fail(409, "invalid_transition", {
        from: item.status,
        to: "SCHEDULED",
        allowed:
          item.status === "PROPOSED" ? ["ACCEPTED", "REJECTED", "DEFERRED", "CANCELLED"] : [],
      });
    item.status = "SCHEDULED";
    return;
  }
  fail(404, "plan_item_not_found");
}
function releasePlanItem(planItemId: string | null) {
  if (!planItemId) return;
  for (const plan of db.plans) {
    const item = plan.items.find((i) => i.id === planItemId);
    if (item && item.status === "SCHEDULED") item.status = "ACCEPTED";
  }
}

// ---- Routes ---------------------------------------------------------------------------------

type Handler = (
  params: string[],
  query: Record<string, string>,
  body: unknown,
) => unknown | Promise<unknown>;
const table: [Method, RegExp, Handler][] = [];
const on = (m: Method, pattern: string, h: Handler) => {
  const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`);
  table.push([m, re, h]);
};

// Chairs
on("GET", "/chairs", (_p, q) => {
  const f = parse(listChairsQuery, q);
  return {
    items: db.chairs
      .filter(
        (c) =>
          (!f.branchId || c.branchId === f.branchId) &&
          (f.active === undefined || c.active === f.active),
      )
      .sort((a, b) => a.branchId.localeCompare(b.branchId) || a.code.localeCompare(b.code)),
  };
});
on("GET", "/chairs/:id", ([id]) => {
  const c = db.chairs.find((x) => x.id === id);
  return c ?? fail(404, "chair_not_found");
});
on("POST", "/chairs", (_p, _q, b) => {
  const body = parse(createChairRequest, b);
  assertCan("schedule:manage", body.branchId);
  branchOr404(body.branchId);
  if (db.chairs.some((c) => c.branchId === body.branchId && c.code === body.code))
    fail(409, "chair_code_taken");
  const c = { id: newId("31"), ...body, active: true, createdAt: nowIso() };
  db.chairs.push(c);
  return c;
});
const patchChair = (id: string, body: z.output<typeof updateChairRequest>) => {
  const c = db.chairs.find((x) => x.id === id) ?? fail(404, "chair_not_found");
  assertCan("schedule:manage", c.branchId);
  if (
    body.code &&
    db.chairs.some((x) => x.id !== id && x.branchId === c.branchId && x.code === body.code)
  )
    fail(409, "chair_code_taken");
  Object.assign(c, body);
  return c;
};
on("PATCH", "/chairs/:id", ([id], _q, b) => patchChair(id as string, parse(updateChairRequest, b)));
on("POST", "/chairs/:id/activate", ([id]) => patchChair(id as string, { active: true }));
on("POST", "/chairs/:id/deactivate", ([id]) => patchChair(id as string, { active: false }));

// Working hours
on("GET", "/working-hours", (_p, q) => {
  const f = parse(listWorkingHoursQuery, q);
  assertCan("appointment:read", f.branchId);
  const tz = tzOf(f.branchId);
  const day = f.on ?? todayIn(tz);
  return {
    items: db.hours
      .filter(
        (w) =>
          w.branchId === f.branchId &&
          (!f.scope || w.scope === f.scope) &&
          (!f.userId || w.userId === f.userId) &&
          (!f.chairId || w.chairId === f.chairId) &&
          (f.includeHistory ||
            (w.effectiveFrom <= day && (w.effectiveTo === null || w.effectiveTo > day))),
      )
      .sort(
        (a, b) =>
          a.scope.localeCompare(b.scope) ||
          String(a.userId).localeCompare(String(b.userId)) ||
          String(a.chairId).localeCompare(String(b.chairId)) ||
          a.effectiveFrom.localeCompare(b.effectiveFrom) ||
          a.weekday - b.weekday ||
          a.startMinute - b.startMinute,
      ),
  };
});
on("PUT", "/working-hours", (_p, _q, b) => {
  const body = parse(setWorkingHoursRequest, b);
  assertCan("schedule:manage", body.branchId);
  const today = todayIn(tzOf(body.branchId));
  if (body.effectiveFrom < today)
    fail(400, "validation_failed", {}, [
      { path: "effectiveFrom", message: "Cannot change past working hours" },
    ]);
  if (body.scope === "CHAIR" && body.chairId) bookableChairOrAny(body.branchId, body.chairId);
  if (body.scope === "DENTIST" && body.userId) {
    const staff = F.staff.find((s) => s.userId === body.userId);
    if (!staff) fail(400, "not_a_member", { field: "userId" });
    if (!staff?.roles.includes("DENTIST")) fail(400, "not_a_dentist", { field: "userId" });
    if (!(BRANCH_DENTISTS[body.branchId] ?? []).includes(body.userId))
      fail(400, "dentist_not_assigned", { field: "userId" });
  }
  const subject = (w: WorkingHoursResponse) =>
    w.scope === body.scope &&
    w.branchId === body.branchId &&
    (body.scope !== "DENTIST" || w.userId === body.userId) &&
    (body.scope !== "CHAIR" || w.chairId === body.chairId);
  if (body.effectiveFrom === today && db.hours.some((w) => subject(w) && w.effectiveFrom === today))
    fail(409, "working_hours_in_force", {
      message: "These hours already took effect today; replace them from tomorrow or later",
    });
  // A dentist's sessions may not overlap across branches (exclusion constraint).
  if (body.scope === "DENTIST")
    for (const s of body.sessions)
      for (const w of db.hours)
        if (
          w.scope === "DENTIST" &&
          w.userId === body.userId &&
          w.branchId !== body.branchId &&
          w.weekday === s.weekday &&
          w.startMinute < s.endMinute &&
          w.endMinute > s.startMinute &&
          (w.effectiveTo === null || w.effectiveTo > body.effectiveFrom)
        )
          fail(409, "working_hours_overlap");
  db.hours = db.hours.filter(
    (w) => !(subject(w) && w.effectiveFrom >= body.effectiveFrom && w.effectiveFrom > today),
  );
  for (const w of db.hours)
    if (
      subject(w) &&
      w.effectiveFrom < body.effectiveFrom &&
      (w.effectiveTo === null || w.effectiveTo > body.effectiveFrom)
    )
      w.effectiveTo = body.effectiveFrom;
  const created = body.sessions.map((s) => ({
    id: newId("32"),
    scope: body.scope,
    branchId: body.branchId,
    userId: body.scope === "DENTIST" ? (body.userId ?? null) : null,
    chairId: body.scope === "CHAIR" ? (body.chairId ?? null) : null,
    weekday: s.weekday,
    startMinute: s.startMinute,
    endMinute: s.endMinute,
    effectiveFrom: body.effectiveFrom,
    effectiveTo: null,
    createdBy: actorId,
    createdAt: nowIso(),
  }));
  db.hours.push(...created);
  return {
    items: created.sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute),
  };
});
function bookableChairOrAny(branchId: string, chairId: string) {
  if (!db.chairs.some((c) => c.id === chairId && c.branchId === branchId))
    fail(404, "chair_not_found");
}

// Scheduling settings
on("GET", "/scheduling/settings", (_p, q) => {
  if (!q.branchId) fail(400, "validation_failed", {}, [{ path: "branchId", message: "Required" }]);
  branchOr404(q.branchId as string);
  return { branchId: q.branchId, ...settingsOf(q.branchId as string) };
});
on("PATCH", "/scheduling/settings", (_p, q, b) => {
  const branchId = q.branchId as string;
  branchOr404(branchId);
  assertCan("schedule:manage", branchId);
  const body = parse(updateSchedulingSettingsRequest, b);
  db.settings[branchId] = { ...settingsOf(branchId), ...body };
  return { branchId, ...db.settings[branchId] };
});

// Availability
on("GET", "/availability", (_p, q) => {
  const f = parse(availabilityQuery, q);
  const branch = branchOr404(f.branchId);
  const tz = branch.timezone;
  const step = f.stepMin ?? settingsOf(f.branchId).slotMinutes;
  if (f.dentistUserId) assertDentist(f.branchId, f.dentistUserId);
  const chairs = f.chairId
    ? [bookableChair(f.branchId, f.chairId)]
    : db.chairs.filter((c) => c.branchId === f.branchId && c.active);
  const now = Date.now();
  const slots = [];
  for (let m = 0; m + f.durationMin <= 1440; m += step) {
    const s = zonedIso(f.date, m, tz);
    const e = new Date(Date.parse(s) + f.durationMin * 60_000).toISOString();
    if (Date.parse(s) < now) continue;
    const base = effectiveHours(db.hours, branch, f.date, { dentistUserId: f.dentistUserId });
    if (!covers(base, m, m + f.durationMin)) continue;
    if (
      f.dentistUserId &&
      conflictResource({ startsAt: s, endsAt: e, dentistUserId: f.dentistUserId, chairId: null })
    )
      continue;
    const free = chairs
      .filter((c) =>
        covers(
          effectiveHours(db.hours, branch, f.date, {
            dentistUserId: f.dentistUserId,
            chairId: c.id,
          }),
          m,
          m + f.durationMin,
        ),
      )
      .filter(
        (c) => !conflictResource({ startsAt: s, endsAt: e, dentistUserId: null, chairId: c.id }),
      )
      .map((c) => c.id);
    if (chairs.length > 0 && free.length === 0) continue;
    slots.push({ startsAt: s, endsAt: e, chairIds: free });
  }
  return { branchId: f.branchId, date: f.date, timeZone: tz, durationMin: f.durationMin, slots };
});

// Appointments
on("GET", "/appointments", (_p, q) => {
  const f = parse(listAppointmentsQuery, q);
  const rows = db.appointments
    .filter(
      (a) =>
        (!f.branchId || a.branchId === f.branchId) &&
        (!f.from || !f.to || (a.startsAt < f.to && a.endsAt > f.from)) &&
        (!f.dentistUserId || a.dentistUserId === f.dentistUserId) &&
        (!f.chairId || a.chairId === f.chairId) &&
        (!f.status || f.status.includes(a.status)) &&
        (!f.patientId || a.patientId === f.patientId),
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  return {
    items: rows.slice(0, MAX_APPOINTMENT_LIST).map(withRescheduledTo),
    truncated: rows.length > MAX_APPOINTMENT_LIST,
  };
});

on("POST", "/appointments", async (_p, _q, b) => {
  const body = parse(bookAppointmentRequest, b);
  assertMove("BOOKED", body.branchId);
  const patient = await activePatient(body.patientId);
  const branch = branchOr404(body.branchId);
  if (!branch.active) fail(409, "branch_inactive");
  if (!body.dentistUserId && !settingsOf(body.branchId).allowUnassignedDentist)
    fail(400, "dentist_required", { field: "dentistUserId" });
  const startsAt = new Date(body.startsAt).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + body.durationMin * 60_000).toISOString();
  const outsideHoursReason = checkSlot({
    branchId: body.branchId,
    startsAt,
    durationMin: body.durationMin,
    dentistUserId: body.dentistUserId ?? null,
    chairId: body.chairId ?? null,
    outsideHoursReason: body.outsideHoursReason,
  });
  const resource = conflictResource({
    startsAt,
    endsAt,
    dentistUserId: body.dentistUserId ?? null,
    chairId: body.chairId ?? null,
  });
  if (resource) fail(409, "slot_conflict", { resource });
  if (body.planItemId) linkPlanItem(body.planItemId, patient.id);
  const a = insert({
    patientId: patient.id,
    branchId: body.branchId,
    dentistUserId: body.dentistUserId ?? null,
    chairId: body.chairId ?? null,
    appointmentType: body.appointmentType,
    startsAt,
    endsAt,
    status: "BOOKED",
    source: body.source,
    rescheduledFromId: null,
    rescheduledToId: null,
    planItemId: body.planItemId ?? null,
    cancelReason: null,
    outsideHoursReason,
    notes: body.notes || null,
    checkedInAt: null,
    patient: summary(patient),
  });
  recordEvent(a, null, "BOOKED", outsideHoursReason);
  publish("appointment.created", a, null);
  return a;
});

on("POST", "/appointments/walk-in", async (_p, _q, b) => {
  const body = parse(createWalkInRequest, b);
  assertMove("BOOKED", body.branchId);
  if (body.checkIn) assertMove("CHECKED_IN", body.branchId);
  const now = Date.now();
  const startsMs = body.startsAt ? Date.parse(body.startsAt) : now;
  if (Math.abs(startsMs - now) > WALK_IN_WINDOW_MIN * 60_000)
    fail(400, "validation_failed", {}, [
      {
        path: "startsAt",
        message: `A walk-in starts within ${WALK_IN_WINDOW_MIN} minutes of now; book other times via POST /appointments`,
      },
    ]);
  const patient = await activePatient(body.patientId);
  const branch = branchOr404(body.branchId);
  if (!branch.active) fail(409, "branch_inactive");
  const startsAt = new Date(startsMs).toISOString();
  const endsAt = new Date(startsMs + body.durationMin * 60_000).toISOString();
  if (body.dentistUserId) assertDentist(body.branchId, body.dentistUserId);
  if (body.chairId) bookableChair(body.branchId, body.chairId);
  // Busy dentist / chair are dropped: the visit is booked unassigned (ADR 0003 §1.3).
  let dentistUserId = body.dentistUserId ?? null;
  let chairId = body.chairId ?? null;
  if (dentistUserId && conflictResource({ startsAt, endsAt, dentistUserId, chairId: null }))
    dentistUserId = null;
  if (chairId && conflictResource({ startsAt, endsAt, dentistUserId: null, chairId }))
    chairId = null;
  if (!dentistUserId && !settingsOf(body.branchId).allowUnassignedDentist)
    fail(
      body.dentistUserId ? 409 : 400,
      body.dentistUserId ? "slot_conflict" : "dentist_required",
      body.dentistUserId ? { resource: "dentist" } : { field: "dentistUserId" },
    );
  const a = insert({
    patientId: patient.id,
    branchId: body.branchId,
    dentistUserId,
    chairId,
    appointmentType:
      body.appointmentType ?? (body.source === "URGENT" ? "EMERGENCY" : "CONSULTATION"),
    startsAt,
    endsAt,
    status: body.checkIn ? "CHECKED_IN" : "BOOKED",
    source: body.source,
    rescheduledFromId: null,
    rescheduledToId: null,
    planItemId: null,
    cancelReason: null,
    outsideHoursReason: null,
    notes: body.notes || null,
    checkedInAt: body.checkIn ? nowIso() : null,
    patient: summary(patient),
  });
  recordEvent(a, null, "BOOKED", null);
  if (body.checkIn) recordEvent(a, "BOOKED", "CHECKED_IN", null);
  publish("appointment.created", a, null);
  return a;
});

on("GET", "/appointments/:id/events", ([id]) => ({
  items: detail(appointmentOr404(id as string)).events,
}));
on("GET", "/appointments/:id", ([id]) => detail(appointmentOr404(id as string)));

on("PATCH", "/appointments/:id", (params, _q, b) => {
  const a = appointmentOr404(params[0] as string);
  const body = parse(updateAppointmentRequest, b);
  assertCan("appointment:write", a.branchId);
  if (!ACTIVE.includes(a.status)) fail(409, "appointment_closed", { status: a.status });
  const dentistUserId = body.dentistUserId === undefined ? a.dentistUserId : body.dentistUserId;
  const chairId = body.chairId === undefined ? a.chairId : body.chairId;
  if (!dentistUserId && !settingsOf(a.branchId).allowUnassignedDentist)
    fail(400, "dentist_required", { field: "dentistUserId" });
  if (body.dentistUserId) assertDentist(a.branchId, body.dentistUserId);
  if (body.chairId) bookableChair(a.branchId, body.chairId);
  const reassigning =
    (body.dentistUserId !== undefined && body.dentistUserId !== a.dentistUserId) ||
    (body.chairId !== undefined && body.chairId !== a.chairId);
  if (reassigning) {
    const atDesk = a.status === "CHECKED_IN" || a.status === "IN_CHAIR";
    const nowish = Math.abs(Date.parse(a.startsAt) - Date.now()) <= WALK_IN_WINDOW_MIN * 60_000;
    const durationMin = Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000);
    if (
      !atDesk &&
      !nowish &&
      !insideHours(a.branchId, a.startsAt, durationMin, dentistUserId, chairId)
    )
      fail(409, "outside_working_hours", {
        message: "The new dentist/chair is not working at this time",
      });
    const resource = conflictResource(
      { startsAt: a.startsAt, endsAt: a.endsAt, dentistUserId, chairId },
      a.id,
    );
    if (resource) fail(409, "slot_conflict", { resource });
  }
  if (body.planItemId !== undefined && body.planItemId !== a.planItemId) {
    releasePlanItem(a.planItemId);
    if (body.planItemId) linkPlanItem(body.planItemId, a.patientId);
  }
  Object.assign(a, {
    dentistUserId,
    chairId,
    ...(body.appointmentType ? { appointmentType: body.appointmentType } : {}),
    ...(body.planItemId !== undefined ? { planItemId: body.planItemId } : {}),
    ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
    updatedAt: nowIso(),
  });
  publish("appointment.updated", a, a.status);
  return withRescheduledTo(a);
});

on("POST", "/appointments/:id/status", (params, _q, b) => {
  const a = appointmentOr404(params[0] as string);
  const body = parse(appointmentTransitionRequest, b);
  const to = body.to;
  assertMove(to, a.branchId);
  if (!canTransitionAppointment(a.status, to))
    fail(409, "invalid_transition", {
      from: a.status,
      to,
      allowed: [...allowedAppointmentTransitions(a.status)],
    });
  if (APPOINTMENT_REASON_REQUIRED.includes(to) && !body.reason) fail(400, "reason_required");
  const tz = tzOf(a.branchId);
  const now = new Date();
  if (to === "CHECKED_IN") {
    const w = checkInWindow(a.startsAt, tz, now);
    if (!w.ok && w.reason === "too_early")
      fail(409, "check_in_too_early", { eligibleFrom: zonedIso(w.eligibleDay, 0, tz) });
    if (!w.ok && w.reason === "too_late") fail(409, "check_in_too_late", { startsAt: a.startsAt });
  }
  if (to === "NO_SHOW") {
    const grace = settingsOf(a.branchId).noShowGraceMinutes;
    if (!isNoShowEligible(new Date(a.startsAt), now, grace))
      fail(409, "no_show_too_early", {
        eligibleAt: new Date(Date.parse(a.startsAt) + grace * 60_000).toISOString(),
      });
    releasePlanItem(a.planItemId);
  }
  const from = a.status;
  a.status = to;
  if (to === "CHECKED_IN") a.checkedInAt = nowIso();
  a.updatedAt = nowIso();
  recordEvent(a, from, to, body.reason || null);
  publish("appointment.status_changed", a, from);
  return withRescheduledTo(a);
});

on("POST", "/appointments/:id/cancel", (params, _q, b) => {
  const a = appointmentOr404(params[0] as string);
  const body = parse(cancelAppointmentRequest, b);
  assertMove("CANCELLED", a.branchId);
  if (!canTransitionAppointment(a.status, "CANCELLED"))
    fail(409, "invalid_transition", {
      from: a.status,
      to: "CANCELLED",
      allowed: [...allowedAppointmentTransitions(a.status)],
    });
  const from = a.status;
  a.status = "CANCELLED";
  a.cancelReason = body.reason;
  a.updatedAt = nowIso();
  recordEvent(a, from, "CANCELLED", body.reason);
  releasePlanItem(a.planItemId);
  publish("appointment.cancelled", a, from);
  return withRescheduledTo(a);
});

on("POST", "/appointments/:id/reschedule", async (params, _q, b) => {
  const old = appointmentOr404(params[0] as string);
  const body = parse(rescheduleAppointmentRequest, b);
  assertMove("RESCHEDULED", old.branchId);
  assertMove("BOOKED", old.branchId);
  if (!canTransitionAppointment(old.status, "RESCHEDULED"))
    fail(409, "invalid_transition", {
      from: old.status,
      to: "RESCHEDULED",
      allowed: [...allowedAppointmentTransitions(old.status)],
    });
  const patient = await activePatient(old.patientId);
  const dentistUserId = body.dentistUserId === undefined ? old.dentistUserId : body.dentistUserId;
  const chairId = body.chairId === undefined ? old.chairId : body.chairId;
  if (!dentistUserId && !settingsOf(old.branchId).allowUnassignedDentist)
    fail(400, "dentist_required", { field: "dentistUserId" });
  const durationMin =
    body.durationMin ?? Math.round((Date.parse(old.endsAt) - Date.parse(old.startsAt)) / 60_000);
  const startsAt = new Date(body.startsAt).toISOString();
  const endsAt = new Date(Date.parse(startsAt) + durationMin * 60_000).toISOString();
  const outsideHoursReason = checkSlot({
    branchId: old.branchId,
    startsAt,
    durationMin,
    dentistUserId,
    chairId,
    outsideHoursReason: body.outsideHoursReason,
  });
  // The old row stops blocking first (it is marked RESCHEDULED in the same transaction).
  const resource = conflictResource({ startsAt, endsAt, dentistUserId, chairId }, old.id);
  if (resource) fail(409, "slot_conflict", { resource });
  const from = old.status;
  old.status = "RESCHEDULED";
  old.updatedAt = nowIso();
  recordEvent(old, from, "RESCHEDULED", body.reason);
  const next = insert({
    patientId: patient.id,
    branchId: old.branchId,
    dentistUserId,
    chairId,
    appointmentType: old.appointmentType,
    startsAt,
    endsAt,
    status: "BOOKED",
    source: old.source,
    rescheduledFromId: old.id,
    rescheduledToId: null,
    planItemId: old.planItemId,
    cancelReason: null,
    outsideHoursReason,
    notes: old.notes,
    checkedInAt: null,
    patient: summary(patient),
  });
  recordEvent(next, null, "BOOKED", body.reason);
  publish("appointment.rescheduled", old, from, { newAppointmentId: next.id });
  publish("appointment.created", next, null);
  return next;
});

// Front desk queue
on("GET", "/front-desk/queue", (_p, q) => {
  const f = parse(checkInQueueQuery, q);
  const tz = tzOf(f.branchId);
  const date = f.date ?? todayIn(tz);
  const from = zonedIso(date, 0, tz);
  const to = zonedIso(addDays(date, 1), 0, tz);
  const rows = db.appointments
    .filter(
      (a) =>
        a.branchId === f.branchId &&
        (a.status === "CHECKED_IN" || a.status === "IN_CHAIR") &&
        a.checkedInAt !== null &&
        a.checkedInAt >= from &&
        a.checkedInAt < to,
    )
    .sort(
      (a, b) =>
        String(a.checkedInAt).localeCompare(String(b.checkedInAt)) || a.id.localeCompare(b.id),
    )
    .sort((a, b) => Number(b.source === "URGENT") - Number(a.source === "URGENT"));
  return {
    branchId: f.branchId,
    date,
    items: rows.map((a, i) => ({
      position: i + 1,
      appointment: withRescheduledTo(a),
      patient: a.patient as NonNullable<AppointmentResponse["patient"]>,
      waitingSince: a.checkedInAt,
    })),
  };
});

// Plans (read-only, for plan-item links)
on("GET", "/plans", (_p, q) => {
  const rows = db.plans.filter(
    (p) =>
      (!q.patientId || p.patientId === q.patientId) && (!q.branchId || p.branchId === q.branchId),
  );
  return {
    items: rows.map(({ items: _i, encounterId: _e, notes: _n, ...s }) => s),
    nextCursor: null,
  };
});
on("GET", "/plans/:id", ([id]) => db.plans.find((p) => p.id === id) ?? fail(404, "plan_not_found"));

// Dentists bookable at a branch (GET /scheduling/dentists, appointment:read). Answered by the shared
// mock from its staff + assignment state; gated here with the scheduling principal too.
on("GET", "/scheduling/dentists", (_p, q) => {
  assertCan("appointment:read", q.branchId || undefined);
  return sharedMockHandler("GET", `${API_PREFIX}/scheduling/dentists`, q, undefined);
});

// Staff directory (org module): branch-scoped staff:read, which RECEPTIONIST and DENTIST do not
// have. The shared mock enforces it against the session; this gate uses the scheduling principal
// (overridable in tests).
on("GET", "/dentist-assignments", (_p, q) => {
  assertCan("staff:read", q.branchId || undefined);
  return sharedMockHandler("GET", `${API_PREFIX}/dentist-assignments`, q, undefined);
});
on("GET", "/staff", (_p, q) => {
  assertCan("staff:read", q.branchId || undefined);
  return sharedMockHandler("GET", `${API_PREFIX}/staff`, q, undefined);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const schedulingMockHandler: MockHandler = async (method, fullPath, query, body) => {
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) : fullPath;
  for (const [m, re, h] of table) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (!match) continue;
    await ensurePrincipal();
    await sleep(LATENCY_MS);
    return structuredClone(await h(match.slice(1).map(decodeURIComponent), query, body));
  }
  return sharedMockHandler(method, fullPath, query, body);
};

/** Test hook: run handlers without latency or the session import. */
export async function schedulingMockCall(
  method: Method,
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
) {
  principalLoaded = true;
  for (const [m, re, h] of table) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (match) return structuredClone(await h(match.slice(1).map(decodeURIComponent), query, body));
  }
  return fail(404, "not_found");
}
