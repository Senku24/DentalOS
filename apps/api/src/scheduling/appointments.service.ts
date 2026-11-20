import {
  type Appointment,
  type AppointmentStatus,
  type Branch,
  type Prisma,
  PrismaClient,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_REASON_REQUIRED,
  APPOINTMENT_TRANSITION_PERMISSIONS,
  type AppointmentDetailResponse,
  type AppointmentListResponse,
  type AppointmentTransitionRequest,
  type BookAppointmentRequest,
  type CancelAppointmentRequest,
  type CheckInQueueQuery,
  type CheckInQueueResponse,
  type CreateWalkInRequest,
  type ListAppointmentsQuery,
  MAX_APPOINTMENT_LIST,
  type RescheduleAppointmentRequest,
  type SchedulingSettings,
  type UpdateAppointmentRequest,
  allowedAppointmentTransitions,
  canTransitionAppointment,
  isNoShowEligible,
  resolveSchedulingSettings,
  utcToZoned,
  zonedToUtc,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import { type Permission, type Principal, can } from "../auth/roles";
import { assertCan, branchWhere } from "../common/principal";
import { findActivePatient, lineageIds, toSummary } from "../patients/patient-common";
import { type DomainEvent, EventBus } from "../realtime/event-bus";
import { allowedHours, covers, loadHours } from "./hours";
import {
  assertPlanItemBookable,
  linkPlanItem,
  movePlanItemSession,
  releasePlanItem,
} from "./plan-link";
import {
  APPOINTMENT_INCLUDE,
  assertDentist,
  findBookableChair,
  findBranchOr404,
  invalidTransition,
  nextDay,
  rethrowDb,
  retryTx,
  schedulingEvent,
  toAppointment,
  toAppointmentEvent,
  todayIn,
} from "./scheduling-common";

const ACTIVE = ACTIVE_APPOINTMENT_STATUSES as readonly AppointmentStatus[];
const MAX_LIST = MAX_APPOINTMENT_LIST;

/**
 * A walk-in is a patient at the desk: it starts within this many minutes of now (either side). Later
 * visits go through POST /appointments, which applies the working-hours rule. The same window
 * exempts PATCH re-assignment of a visit happening now (what a walk-in could have created anyway).
 */
export const WALK_IN_WINDOW_MIN = 30;

const withinWalkInWindow = (startsAt: Date, now: Date) =>
  Math.abs(startsAt.getTime() - now.getTime()) <= WALK_IN_WINDOW_MIN * 60_000;

/** Statuses where the patient is physically at the practice (checkedInAt is set). */
const AT_THE_DESK: readonly AppointmentStatus[] = ["CHECKED_IN", "IN_CHAIR"];

/**
 * Check-in only on the visit's own branch-local day (or within the walk-in window, for a visit that
 * straddles midnight). Else a future visit would get today's checkedInAt, enter today's queue and
 * could be completed weeks early; a past-day visit is a no-show or a reschedule, not a check-in.
 * Proposed addition to ADR 0003 §1.1.
 */
export function assertCheckInDay(startsAt: Date, timeZone: string, now: Date) {
  if (withinWalkInWindow(startsAt, now)) return;
  const day = utcToZoned(startsAt, timeZone).date;
  const today = todayIn(timeZone, now);
  if (day > today)
    throw new ConflictException({
      error: "check_in_too_early",
      eligibleFrom: zonedToUtc(day, 0, timeZone).toISOString(),
    });
  if (day < today)
    throw new ConflictException({ error: "check_in_too_late", startsAt: startsAt.toISOString() });
}

/** ADR 0003 §1.2: any one permission for the target status, against the appointment's branch. */
function assertMayMoveInto(p: Principal, to: AppointmentStatus, branchId: string) {
  const perms = APPOINTMENT_TRANSITION_PERMISSIONS[to] as readonly Permission[];
  if (!perms.some((perm) => can(p, perm, { branchId }))) throw new ForbiddenException();
}

async function findAppointmentOr404(tx: Tx, id: string): Promise<Appointment> {
  const a = await tx.appointment.findUnique({ where: { id } });
  if (!a) throw new NotFoundException({ error: "appointment_not_found" });
  return a;
}

function activeBranch(b: Branch): Branch {
  if (!b.active) throw new ConflictException({ error: "branch_inactive" });
  return b;
}

interface SlotInput {
  startsAt: Date;
  durationMin: number;
  dentistUserId: string | null;
  chairId: string | null;
  outsideHoursReason?: string;
}

/**
 * Appointments (PRD 4.3, ADR 0003 §1): book / walk-in / reschedule / cancel / status transitions,
 * calendar lists, detail with history and the check-in queue.
 *  - Double booking is prevented by the exclusion constraints (23P01 -> 409 slot_conflict); no
 *    pre-check is trusted for that (races), except walk-ins which drop a busy dentist/chair.
 *  - Every status change writes an AppointmentEvent in the same transaction; audit (ids only) and
 *    EventBus events (ids/status only) follow the commit.
 *  - Status updates are guarded on the previous status, so concurrent transitions cannot both win.
 */
@Injectable()
export class AppointmentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async list(p: Principal, q: ListAppointmentsQuery): Promise<AppointmentListResponse> {
    if (q.branchId) assertCan(p, "appointment:read", { branchId: q.branchId });
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      const and: Prisma.AppointmentWhereInput[] = [branchWhere(p)];
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.from && q.to)
        and.push({ startsAt: { lt: new Date(q.to) }, endsAt: { gt: new Date(q.from) } });
      if (q.dentistUserId) and.push({ dentistUserId: q.dentistUserId });
      if (q.chairId) and.push({ chairId: q.chairId });
      if (q.status) and.push({ status: { in: q.status } });
      // A patient's history includes records merged into it (appointments are never re-pointed).
      if (q.patientId) and.push({ patientId: { in: await lineageIds(tx, q.patientId) } });
      return tx.appointment.findMany({
        where: { AND: and },
        include: APPOINTMENT_INCLUDE,
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        // One extra row tells a full page from a truncated one.
        take: MAX_LIST + 1,
      });
    });
    const truncated = rows.length > MAX_LIST;
    return { items: rows.slice(0, MAX_LIST).map(toAppointment), truncated };
  }

  async get(p: Principal, id: string): Promise<AppointmentDetailResponse> {
    const a = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.appointment.findUnique({
        where: { id },
        include: { ...APPOINTMENT_INCLUDE, events: { orderBy: [{ at: "asc" }, { id: "asc" }] } },
      }),
    );
    if (!a) throw new NotFoundException({ error: "appointment_not_found" });
    assertCan(p, "appointment:read", { branchId: a.branchId });
    return { ...toAppointment(a), events: a.events.map(toAppointmentEvent) };
  }

  async events(p: Principal, id: string) {
    const d = await this.get(p, id);
    return { items: d.events };
  }

  async queue(p: Principal, q: CheckInQueueQuery): Promise<CheckInQueueResponse> {
    assertCan(p, "appointment:read", { branchId: q.branchId });
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const branch = await findBranchOr404(tx, q.branchId);
      const date = q.date ?? todayIn(branch.timezone);
      const rows = await tx.appointment.findMany({
        where: {
          branchId: branch.id,
          status: { in: ["CHECKED_IN", "IN_CHAIR"] },
          checkedInAt: {
            gte: zonedToUtc(date, 0, branch.timezone),
            lt: zonedToUtc(nextDay(date), 0, branch.timezone),
          },
        },
        include: APPOINTMENT_INCLUDE,
        orderBy: [{ checkedInAt: "asc" }, { id: "asc" }],
      });
      // Urgent visits first (ADR 0003 §1.1), then arrival order. Array#sort is stable.
      rows.sort((a, b) => Number(b.source === "URGENT") - Number(a.source === "URGENT"));
      return {
        branchId: branch.id,
        date,
        items: rows.map((a, i) => ({
          position: i + 1,
          appointment: toAppointment(a),
          patient: toSummary(a.patient),
          waitingSince: a.checkedInAt?.toISOString() ?? null,
        })),
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------------------------

  async book(p: Principal, body: BookAppointmentRequest) {
    assertMayMoveInto(p, "BOOKED", body.branchId);
    const created = await retryTx(() =>
      withTenant(
        this.prisma,
        p.tenantId,
        async (tx) => {
          const branch = activeBranch(await findBranchOr404(tx, body.branchId));
          const settings = resolveSchedulingSettings(branch.settings);
          const patient = await findActivePatient(tx, body.patientId);
          if (!body.dentistUserId && !settings.allowUnassignedDentist)
            throw new BadRequestException({ error: "dentist_required", field: "dentistUserId" });
          const startsAt = new Date(body.startsAt);
          const outsideHoursReason = await this.checkSlot(tx, p, branch, settings, {
            startsAt,
            durationMin: body.durationMin,
            dentistUserId: body.dentistUserId ?? null,
            chairId: body.chairId ?? null,
            outsideHoursReason: body.outsideHoursReason,
          });
          if (body.planItemId) await assertPlanItemBookable(tx, p, patient.id, body.planItemId);
          const a = await tx.appointment.create({
            data: {
              tenantId: p.tenantId,
              patientId: patient.id,
              branchId: branch.id,
              dentistUserId: body.dentistUserId ?? null,
              chairId: body.chairId ?? null,
              appointmentType: body.appointmentType,
              startsAt,
              endsAt: new Date(startsAt.getTime() + body.durationMin * 60_000),
              source: body.source,
              planItemId: body.planItemId ?? null,
              outsideHoursReason,
              notes: body.notes || null,
              createdBy: p.userId,
            },
          });
          await this.recordEvent(tx, p, a, null, "BOOKED", outsideHoursReason);
          if (body.planItemId) await linkPlanItem(tx, p, a, body.planItemId);
          return tx.appointment.findUniqueOrThrow({
            where: { id: a.id },
            include: APPOINTMENT_INCLUDE,
          });
        },
        { actorId: p.userId },
      ),
    ).catch((e) => rethrowDb(e));
    await this.after(p, "appointment.create", created, [
      schedulingEvent("appointment.created", created, null, created.status),
    ]);
    return toAppointment(created);
  }

  /**
   * Walk-in / urgent: starts now (or `startsAt`, which must be within WALK_IN_WINDOW_MIN of now —
   * else 400 validation_failed), checked in by default. Same no-double-booking rule; a busy
   * dentist/chair is dropped (booked unassigned, assigned when one frees up — ADR 0003 §1.3).
   * Not subject to the working-hours check (the patient is already at the desk); the window keeps
   * this route from booking arbitrary future/past slots around that check.
   */
  async walkIn(p: Principal, body: CreateWalkInRequest, now = new Date()) {
    assertMayMoveInto(p, "BOOKED", body.branchId);
    if (body.checkIn) assertMayMoveInto(p, "CHECKED_IN", body.branchId);
    const startsAt = body.startsAt ? new Date(body.startsAt) : now;
    if (!withinWalkInWindow(startsAt, now))
      throw new BadRequestException({
        error: "validation_failed",
        issues: [
          {
            path: "startsAt",
            message: `A walk-in starts within ${WALK_IN_WINDOW_MIN} minutes of now; book other times via POST /appointments`,
          },
        ],
      });
    const created = await retryTx(() =>
      withTenant(
        this.prisma,
        p.tenantId,
        async (tx) => {
          const branch = activeBranch(await findBranchOr404(tx, body.branchId));
          const settings = resolveSchedulingSettings(branch.settings);
          const patient = await findActivePatient(tx, body.patientId);
          const endsAt = new Date(startsAt.getTime() + body.durationMin * 60_000);
          const day = utcToZoned(startsAt, branch.timezone).date;
          let dentistUserId = body.dentistUserId ?? null;
          let chairId = body.chairId ?? null;
          if (dentistUserId) {
            await assertDentist(tx, p.tenantId, branch.id, dentistUserId, day);
            if (await this.busy(tx, { dentistUserId }, startsAt, endsAt)) dentistUserId = null;
          }
          if (chairId) {
            await findBookableChair(tx, branch.id, chairId);
            if (await this.busy(tx, { chairId }, startsAt, endsAt)) chairId = null;
          }
          if (!dentistUserId && !settings.allowUnassignedDentist)
            throw body.dentistUserId
              ? new ConflictException({ error: "slot_conflict", resource: "dentist" })
              : new BadRequestException({ error: "dentist_required", field: "dentistUserId" });
          const status: AppointmentStatus = body.checkIn ? "CHECKED_IN" : "BOOKED";
          const a = await tx.appointment.create({
            data: {
              tenantId: p.tenantId,
              patientId: patient.id,
              branchId: branch.id,
              dentistUserId,
              chairId,
              appointmentType:
                body.appointmentType ?? (body.source === "URGENT" ? "EMERGENCY" : "CONSULTATION"),
              startsAt,
              endsAt,
              status,
              source: body.source,
              checkedInAt: body.checkIn ? now : null,
              notes: body.notes || null,
              createdBy: p.userId,
            },
          });
          await this.recordEvent(tx, p, a, null, status, null);
          return tx.appointment.findUniqueOrThrow({
            where: { id: a.id },
            include: APPOINTMENT_INCLUDE,
          });
        },
        { actorId: p.userId },
      ),
    ).catch((e) => rethrowDb(e));
    await this.after(p, "appointment.walk_in", created, [
      schedulingEvent("appointment.created", created, null, created.status),
    ]);
    return toAppointment(created);
  }

  // -------------------------------------------------------------------------------------------
  // Change
  // -------------------------------------------------------------------------------------------

  /**
   * Re-assign dentist/chair, type, notes, plan item. Times never change here (reschedule).
   * Assigning a dentist/chair applies the working-hours rule (ADR 0003 §1.3) to the current slot:
   * outside the new combination's hours -> 409 outside_working_hours, unless the patient is already
   * at the desk (CHECKED_IN / IN_CHAIR), the visit is happening now (walk-in window), or the row
   * already carries an outsideHoursReason and the caller has schedule:manage (this body has no
   * reason field: use reschedule to give one).
   */
  async update(p: Principal, id: string, body: UpdateAppointmentRequest, now = new Date()) {
    const updated = await retryTx(() =>
      withTenant(
        this.prisma,
        p.tenantId,
        async (tx) => {
          const cur = await findAppointmentOr404(tx, id);
          assertCan(p, "appointment:write", { branchId: cur.branchId });
          if (!ACTIVE.includes(cur.status))
            throw new ConflictException({ error: "appointment_closed", status: cur.status });
          const branch = await findBranchOr404(tx, cur.branchId);
          const settings = resolveSchedulingSettings(branch.settings);
          const day = utcToZoned(cur.startsAt, branch.timezone).date;
          const data: Prisma.AppointmentUncheckedUpdateManyInput = {};
          let dentistUserId = cur.dentistUserId;
          let chairId = cur.chairId;
          let assigning = false;
          if (body.dentistUserId !== undefined && body.dentistUserId !== cur.dentistUserId) {
            if (body.dentistUserId === null && !settings.allowUnassignedDentist)
              throw new BadRequestException({ error: "dentist_required", field: "dentistUserId" });
            if (body.dentistUserId) {
              await assertDentist(tx, p.tenantId, branch.id, body.dentistUserId, day);
              assigning = true;
            }
            dentistUserId = body.dentistUserId;
            data.dentistUserId = body.dentistUserId;
          }
          if (body.chairId !== undefined && body.chairId !== cur.chairId) {
            if (body.chairId) {
              await findBookableChair(tx, branch.id, body.chairId);
              assigning = true;
            }
            chairId = body.chairId;
            data.chairId = body.chairId;
          }
          // Unassigning only widens the allowed hours; a new dentist/chair may narrow them. A visit
          // already at the desk (CHECKED_IN / IN_CHAIR — check-in is same-day only) is exempt like a
          // walk-in: an unassigned walk-in gets its dentist/chair when one frees up (ADR 0003 §1.3).
          if (
            assigning &&
            !AT_THE_DESK.includes(cur.status) &&
            !withinWalkInWindow(cur.startsAt, now)
          ) {
            const durationMin = Math.round(
              (cur.endsAt.getTime() - cur.startsAt.getTime()) / 60_000,
            );
            const inside = await this.insideHours(tx, branch, {
              startsAt: cur.startsAt,
              durationMin,
              dentistUserId,
              chairId,
            });
            if (
              !inside &&
              !(
                settings.allowOutsideHoursBooking &&
                cur.outsideHoursReason &&
                can(p, "schedule:manage", { branchId: branch.id })
              )
            )
              throw new ConflictException({
                error: "outside_working_hours",
                message:
                  "The new dentist/chair is not working at this time: reschedule with outsideHoursReason (needs schedule:manage)",
              });
          }
          if (body.appointmentType !== undefined) data.appointmentType = body.appointmentType;
          if (body.notes !== undefined) data.notes = body.notes || null;
          const planChanged = body.planItemId !== undefined && body.planItemId !== cur.planItemId;
          if (planChanged) {
            if (body.planItemId) {
              await findActivePatient(tx, cur.patientId);
              await assertPlanItemBookable(tx, p, cur.patientId, body.planItemId);
            }
            data.planItemId = body.planItemId;
          }
          const r = await tx.appointment.updateMany({ where: { id, status: cur.status }, data });
          if (r.count !== 1) throw new ConflictException({ error: "appointment_changed" });
          if (planChanged) {
            if (cur.planItemId) await releasePlanItem(tx, id, cur.planItemId);
            if (body.planItemId) await linkPlanItem(tx, p, cur, body.planItemId);
          }
          return tx.appointment.findUniqueOrThrow({ where: { id }, include: APPOINTMENT_INCLUDE });
        },
        { actorId: p.userId },
      ),
    ).catch((e) => rethrowDb(e));
    await this.after(p, "appointment.update", updated, [
      schedulingEvent("appointment.updated", updated, updated.status, updated.status),
    ]);
    return toAppointment(updated);
  }

  /** POST /appointments/:id/status — CONFIRMED, CHECKED_IN, IN_CHAIR, COMPLETED, NO_SHOW. */
  async transition(p: Principal, id: string, body: AppointmentTransitionRequest, now = new Date()) {
    const to = body.to;
    let from: AppointmentStatus = "BOOKED";
    const updated = await retryTx(() =>
      withTenant(
        this.prisma,
        p.tenantId,
        async (tx) => {
          const cur = await findAppointmentOr404(tx, id);
          from = cur.status;
          assertMayMoveInto(p, to, cur.branchId);
          if (!canTransitionAppointment(cur.status, to))
            throw invalidTransition(cur.status, to, allowedAppointmentTransitions(cur.status));
          if (APPOINTMENT_REASON_REQUIRED.includes(to) && !body.reason)
            throw new BadRequestException({ error: "reason_required" });
          if (to === "CHECKED_IN") {
            const branch = await findBranchOr404(tx, cur.branchId);
            assertCheckInDay(cur.startsAt, branch.timezone, now);
          }
          if (to === "NO_SHOW") {
            const branch = await findBranchOr404(tx, cur.branchId);
            const grace = resolveSchedulingSettings(branch.settings).noShowGraceMinutes;
            if (!isNoShowEligible(cur.startsAt, now, grace))
              throw new ConflictException({
                error: "no_show_too_early",
                eligibleAt: new Date(cur.startsAt.getTime() + grace * 60_000).toISOString(),
              });
          }
          await this.move(tx, p, cur, to, body.reason || null, {
            ...(to === "CHECKED_IN" ? { checkedInAt: now } : {}),
          });
          if (to === "NO_SHOW" && cur.planItemId) await releasePlanItem(tx, cur.id, cur.planItemId);
          return tx.appointment.findUniqueOrThrow({ where: { id }, include: APPOINTMENT_INCLUDE });
        },
        { actorId: p.userId },
      ),
    ).catch((e) => rethrowDb(e));
    await this.after(p, `appointment.status.${to.toLowerCase()}`, updated, [
      schedulingEvent("appointment.status_changed", updated, from, to),
    ]);
    return toAppointment(updated);
  }

  async cancel(p: Principal, id: string, body: CancelAppointmentRequest) {
    let from: AppointmentStatus = "BOOKED";
    const updated = await retryTx(() =>
      withTenant(
        this.prisma,
        p.tenantId,
        async (tx) => {
          const cur = await findAppointmentOr404(tx, id);
          from = cur.status;
          assertMayMoveInto(p, "CANCELLED", cur.branchId);
          if (!canTransitionAppointment(cur.status, "CANCELLED"))
            throw invalidTransition(
              cur.status,
              "CANCELLED",
              allowedAppointmentTransitions(cur.status),
            );
          await this.move(tx, p, cur, "CANCELLED", body.reason, { cancelReason: body.reason });
          if (cur.planItemId) await releasePlanItem(tx, cur.id, cur.planItemId);
          return tx.appointment.findUniqueOrThrow({ where: { id }, include: APPOINTMENT_INCLUDE });
        },
        { actorId: p.userId },
      ),
    ).catch((e) => rethrowDb(e));
    await this.after(p, "appointment.cancel", updated, [
      schedulingEvent("appointment.cancelled", updated, from, "CANCELLED"),
    ]);
    return toAppointment(updated);
  }

  /**
   * One transaction: old -> RESCHEDULED (+ event) FIRST, then insert the successor with
   * rescheduledFromId (else the exclusion constraint would see two active rows). Omitted fields are
   * copied; `null` clears dentist/chair. The plan-item session follows the appointment.
   */
  async reschedule(p: Principal, id: string, body: RescheduleAppointmentRequest) {
    let from: AppointmentStatus = "BOOKED";
    const result = await retryTx(() =>
      withTenant(
        this.prisma,
        p.tenantId,
        async (tx) => {
          const old = await findAppointmentOr404(tx, id);
          from = old.status;
          assertMayMoveInto(p, "RESCHEDULED", old.branchId);
          assertMayMoveInto(p, "BOOKED", old.branchId);
          if (!canTransitionAppointment(old.status, "RESCHEDULED"))
            throw invalidTransition(
              old.status,
              "RESCHEDULED",
              allowedAppointmentTransitions(old.status),
            );
          const patient = await findActivePatient(tx, old.patientId);
          const branch = activeBranch(await findBranchOr404(tx, old.branchId));
          const settings = resolveSchedulingSettings(branch.settings);
          const dentistUserId =
            body.dentistUserId === undefined ? old.dentistUserId : body.dentistUserId;
          const chairId = body.chairId === undefined ? old.chairId : body.chairId;
          if (!dentistUserId && !settings.allowUnassignedDentist)
            throw new BadRequestException({ error: "dentist_required", field: "dentistUserId" });
          const durationMin =
            body.durationMin ??
            Math.round((old.endsAt.getTime() - old.startsAt.getTime()) / 60_000);
          const startsAt = new Date(body.startsAt);
          const outsideHoursReason = await this.checkSlot(tx, p, branch, settings, {
            startsAt,
            durationMin,
            dentistUserId,
            chairId,
            outsideHoursReason: body.outsideHoursReason,
          });
          await this.move(tx, p, old, "RESCHEDULED", body.reason, {});
          const next = await tx.appointment.create({
            data: {
              tenantId: p.tenantId,
              patientId: patient.id,
              branchId: branch.id,
              dentistUserId,
              chairId,
              appointmentType: old.appointmentType,
              startsAt,
              endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
              source: old.source,
              rescheduledFromId: old.id,
              planItemId: old.planItemId,
              outsideHoursReason,
              notes: old.notes,
              createdBy: p.userId,
            },
          });
          await this.recordEvent(tx, p, next, null, "BOOKED", body.reason);
          if (old.planItemId) await movePlanItemSession(tx, old.planItemId, old.id, next.id);
          return {
            old: await tx.appointment.findUniqueOrThrow({ where: { id: old.id } }),
            next: await tx.appointment.findUniqueOrThrow({
              where: { id: next.id },
              include: APPOINTMENT_INCLUDE,
            }),
          };
        },
        { actorId: p.userId },
      ),
    ).catch((e) => rethrowDb(e));
    await this.after(p, "appointment.reschedule", result.old, [
      schedulingEvent("appointment.rescheduled", result.old, from, "RESCHEDULED", {
        newAppointmentId: result.next.id,
      }),
      schedulingEvent("appointment.created", result.next, null, "BOOKED"),
    ]);
    return toAppointment(result.next);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /**
   * Validates dentist + chair for the slot and applies the working-hours rule. Returns the
   * outside-hours reason to store (null when inside hours). 409 outside_working_hours unless the
   * branch allows it and the caller has schedule:manage on the branch AND gave a reason.
   */
  private async checkSlot(
    tx: Tx,
    p: Principal,
    branch: Branch,
    settings: SchedulingSettings,
    s: SlotInput,
  ): Promise<string | null> {
    const local = utcToZoned(s.startsAt, branch.timezone);
    if (s.dentistUserId)
      await assertDentist(tx, p.tenantId, branch.id, s.dentistUserId, local.date);
    if (s.chairId) await findBookableChair(tx, branch.id, s.chairId);
    if (await this.insideHours(tx, branch, s)) return null;
    if (!settings.allowOutsideHoursBooking)
      throw new ConflictException({
        error: "outside_working_hours",
        message: "This branch does not allow bookings outside working hours",
      });
    if (!can(p, "schedule:manage", { branchId: branch.id }) || !s.outsideHoursReason)
      throw new ConflictException({
        error: "outside_working_hours",
        message: "Outside working hours: needs schedule:manage and outsideHoursReason",
      });
    return s.outsideHoursReason;
  }

  /** True when the slot lies inside the effective hours of the branch ∩ dentist ∩ chair. */
  private async insideHours(tx: Tx, branch: Branch, s: SlotInput): Promise<boolean> {
    const local = utcToZoned(s.startsAt, branch.timezone);
    const ctx = await loadHours(tx, branch, local.date, local.weekday, {
      dentistUserId: s.dentistUserId ?? undefined,
      chairIds: s.chairId ? [s.chairId] : [],
    });
    return covers(
      allowedHours(ctx, s.chairId),
      local.minuteOfDay,
      local.minuteOfDay + s.durationMin,
    );
  }

  /** Guarded status update (previous status must still hold) + its AppointmentEvent. */
  private async move(
    tx: Tx,
    p: Principal,
    cur: Appointment,
    to: AppointmentStatus,
    reason: string | null,
    extra: Prisma.AppointmentUncheckedUpdateManyInput,
  ) {
    const r = await tx.appointment.updateMany({
      where: { id: cur.id, status: cur.status },
      data: { ...extra, status: to },
    });
    if (r.count !== 1) {
      const now = await findAppointmentOr404(tx, cur.id);
      throw invalidTransition(now.status, to, allowedAppointmentTransitions(now.status));
    }
    await this.recordEvent(tx, p, cur, cur.status, to, reason);
  }

  private recordEvent(
    tx: Tx,
    p: Principal,
    a: Pick<Appointment, "id">,
    fromStatus: AppointmentStatus | null,
    toStatus: AppointmentStatus,
    reason: string | null | undefined,
  ) {
    return tx.appointmentEvent.create({
      data: {
        tenantId: p.tenantId,
        appointmentId: a.id,
        fromStatus,
        toStatus,
        actorId: p.userId,
        reason: reason || null,
      },
    });
  }

  private async busy(
    tx: Tx,
    who: { dentistUserId: string } | { chairId: string },
    startsAt: Date,
    endsAt: Date,
  ): Promise<boolean> {
    const n = await tx.appointment.count({
      where: {
        ...who,
        status: { in: [...ACTIVE] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    return n > 0;
  }

  /** After commit: audit (ids only) and realtime events. */
  private async after(p: Principal, action: string, a: Appointment, events: DomainEvent[]) {
    await this.audit.record(p, {
      action,
      resource: "Appointment",
      resourceId: a.id,
      branchId: a.branchId,
      outcome: "success",
    });
    for (const e of events) this.bus.publish(e);
  }
}
