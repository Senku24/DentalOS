import {
  type Appointment,
  type AppointmentEvent,
  type Branch,
  type Chair,
  type Patient,
  Prisma,
  type Tx,
  type WorkingHours,
} from "@dentalos/db";
import type {
  AppointmentEventResponse,
  AppointmentResponse,
  ChairResponse,
  SchedulingEventData,
  WorkingHoursResponse,
} from "@dentalos/validation";
import { SCHEDULING_EVENT_TYPES, schedulingEventData } from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import {
  isUniqueViolation,
  notAMember,
  slotConflict,
  workingHoursOverlap,
} from "../common/db-errors";
import { ZodPipe } from "../common/zod.pipe";
import { toSummary } from "../patients/patient-common";
import type { DomainEvent } from "../realtime/event-bus";

/**
 * Shared helpers for the scheduling module (S1). Pure mappers + small tx helpers; no Nest providers.
 * Kept local (not imported from org/http.ts) so this module only depends on frozen/common code and
 * M1 patient helpers.
 */

/** Validates a UUID path parameter: `@Param("id", UUID) id: string`. */
export const UUID = new ZodPipe(z.uuid());

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** "YYYY-MM-DD" -> Date at UTC midnight (Prisma `@db.Date`). */
export const dateFromDay = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** Prisma `@db.Date` value -> "YYYY-MM-DD". */
export const dayFromDate = (d: Date) => d.toISOString().slice(0, 10);
/** "2026-11-30" -> "2026-12-01". */
export const nextDay = (day: string) =>
  dayFromDate(new Date(dateFromDay(day).getTime() + 86_400_000));

/** Today's calendar date ("YYYY-MM-DD") in an IANA zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// ---------------------------------------------------------------------------------------------
// Mappers (response DTOs from @dentalos/validation)
// ---------------------------------------------------------------------------------------------

export const toChair = (c: Chair): ChairResponse => ({
  id: c.id,
  branchId: c.branchId,
  code: c.code,
  name: c.name,
  active: c.active,
  createdAt: c.createdAt.toISOString(),
});

export const toWorkingHours = (w: WorkingHours): WorkingHoursResponse => ({
  id: w.id,
  scope: w.scope,
  branchId: w.branchId,
  userId: w.userId,
  chairId: w.chairId,
  weekday: w.weekday,
  startMinute: w.startMinute,
  endMinute: w.endMinute,
  effectiveFrom: dayFromDate(w.effectiveFrom),
  effectiveTo: w.effectiveTo ? dayFromDate(w.effectiveTo) : null,
  createdBy: w.createdBy,
  createdAt: w.createdAt.toISOString(),
});

export type AppointmentRow = Appointment & {
  rescheduledTo?: { id: string } | null;
  patient?: Patient;
};

/** Include for list/detail reads: successor id + patient summary. */
export const APPOINTMENT_INCLUDE = {
  rescheduledTo: { select: { id: true } },
  patient: true,
} as const satisfies Prisma.AppointmentInclude;

export function toAppointment(a: AppointmentRow): AppointmentResponse {
  return {
    id: a.id,
    patientId: a.patientId,
    branchId: a.branchId,
    dentistUserId: a.dentistUserId,
    chairId: a.chairId,
    appointmentType: a.appointmentType,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    status: a.status,
    source: a.source,
    rescheduledFromId: a.rescheduledFromId,
    ...(a.rescheduledTo !== undefined ? { rescheduledToId: a.rescheduledTo?.id ?? null } : {}),
    planItemId: a.planItemId,
    cancelReason: a.cancelReason,
    outsideHoursReason: a.outsideHoursReason,
    notes: a.notes,
    checkedInAt: a.checkedInAt?.toISOString() ?? null,
    createdBy: a.createdBy,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    ...(a.patient ? { patient: toSummary(a.patient) } : {}),
  };
}

export const toAppointmentEvent = (e: AppointmentEvent): AppointmentEventResponse => ({
  id: e.id,
  appointmentId: e.appointmentId,
  fromStatus: e.fromStatus,
  toStatus: e.toStatus,
  actorId: e.actorId,
  reason: e.reason,
  at: e.at.toISOString(),
});

// ---------------------------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------------------------

export type SchedulingEventType = (typeof SCHEDULING_EVENT_TYPES)[number];

/**
 * Builds the EventBus payload for a scheduling change: ids + statuses only (validated against
 * `schedulingEventData`, so names/notes can never leak onto the SSE channel).
 */
export function schedulingEvent(
  type: SchedulingEventType,
  a: Pick<Appointment, "id" | "tenantId" | "branchId" | "patientId" | "startsAt">,
  fromStatus: Appointment["status"] | null,
  toStatus: Appointment["status"],
  extra: { newAppointmentId?: string } = {},
): DomainEvent {
  const data: SchedulingEventData = schedulingEventData.parse({
    appointmentId: a.id,
    patientId: a.patientId,
    fromStatus,
    toStatus,
    startsAt: a.startsAt.toISOString(),
    ...extra,
  });
  return { tenantId: a.tenantId, branchId: a.branchId, type, data };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Deadlock (40P01) / serialization failure (40001, Prisma P2034). Two transactions inserting
 * conflicting rows under an exclusion constraint can each wait for the other's index entry; after
 * deadlock_timeout Postgres aborts one with 40P01 instead of 23P01. Retrying the loser then sees the
 * committed winner and fails cleanly with 23P01 (-> 409 slot_conflict) — never a 500.
 */
export function isRetryableTxError(e: unknown): boolean {
  if (e instanceof HttpException) return false;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034") return true;
  const msg = e && typeof e === "object" ? String((e as { message?: unknown }).message ?? "") : "";
  return /\b40P01\b|\b40001\b|deadlock detected|could not serialize access/.test(msg);
}

/** Runs a whole transaction, retrying it (fresh) on deadlock/serialization failure. */
export async function retryTx<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= attempts || !isRetryableTxError(e)) throw e;
    }
  }
}

/**
 * Maps DB-enforced rules to stable API errors; HttpExceptions thrown inside a transaction pass
 * through unchanged. 23P01 on the appointment exclusion constraints -> 409 slot_conflict.
 */
export function rethrowDb(e: unknown, opts: { conflict?: string } = {}): never {
  if (e instanceof HttpException) throw e;
  const slot = slotConflict(e);
  if (slot)
    throw new ConflictException({
      error: "slot_conflict",
      resource: slot,
      message: `The ${slot} is already booked for an overlapping time`,
    });
  if (workingHoursOverlap(e)) throw new ConflictException({ error: "working_hours_overlap" });
  const field = notAMember(e);
  if (field) throw new BadRequestException({ error: "not_a_member", field });
  if (isUniqueViolation(e)) throw new ConflictException({ error: opts.conflict ?? "conflict" });
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
    throw new BadRequestException({ error: "invalid_reference" });
  throw e;
}

export const invalidTransition = (from: string, to: string, allowed: readonly string[]) =>
  new ConflictException({ error: "invalid_transition", from, to, allowed: [...allowed] });

// ---------------------------------------------------------------------------------------------
// Lookups (RLS hides other tenants: a foreign id is a 404)
// ---------------------------------------------------------------------------------------------

export async function findBranchOr404(tx: Tx, id: string): Promise<Branch> {
  const b = await tx.branch.findUnique({ where: { id } });
  if (!b) throw new NotFoundException({ error: "branch_not_found" });
  return b;
}

/** A chair of `branchId` that may take bookings. */
export async function findBookableChair(tx: Tx, branchId: string, chairId: string) {
  const c = await tx.chair.findFirst({ where: { id: chairId, branchId } });
  if (!c) throw new NotFoundException({ error: "chair_not_found" });
  if (!c.active) throw new ConflictException({ error: "chair_inactive" });
  return c;
}

/**
 * Dentist columns hold IdP subjects (not FKs): validate at write time that the user is a member
 * with the DENTIST role and has an assignment to the branch in force on `day` (branch-local date).
 */
export async function assertDentist(
  tx: Tx,
  tenantId: string,
  branchId: string,
  userId: string,
  day: string,
): Promise<void> {
  const m = await tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
  if (!m) throw new BadRequestException({ error: "not_a_member", field: "dentistUserId" });
  if (!m.roles.includes("DENTIST"))
    throw new BadRequestException({ error: "not_a_dentist", field: "dentistUserId" });
  const d = dateFromDay(day);
  const assignment = await tx.dentistBranchAssignment.findFirst({
    where: {
      userId,
      branchId,
      effectiveFrom: { lte: d },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: d } }],
    },
    select: { id: true },
  });
  if (!assignment)
    throw new BadRequestException({ error: "dentist_not_assigned", field: "dentistUserId" });
}
