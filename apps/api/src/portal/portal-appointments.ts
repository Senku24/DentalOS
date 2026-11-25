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
  type ListPortalAppointmentsQuery,
  NOTIFICATION_QUEUES,
  PORTAL_VIOLATION_ERROR,
  type PortalAppointmentResponse,
  type PortalBookAppointmentRequest,
  type PortalBookingOptionsResponse,
  type PortalBookingViolation,
  type PortalCancelRequest,
  type PortalRescheduleRequest,
  type PortalSlotsQuery,
  type PortalSlotsResponse,
  type ResolvedPortalSettings,
  canTransitionAppointment,
  evaluatePortalBooking,
  evaluatePortalChange,
  listPortalAppointmentsQuery,
  portalBookAppointmentRequest,
  portalCancelRequest,
  portalRescheduleRequest,
  portalSlotsQuery,
  resolvePortalSettings,
  resolveSchedulingSettings,
  utcToZoned,
  zonedToUtc,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import { CurrentPatient, type PatientPrincipal } from "../auth/patient-principal";
import { PortalAuditService } from "../auth/portal-audit";
import { PortalAuth } from "../auth/portal.guard";
import { effectivePrice, overridesFor } from "../catalog/pricing";
import { slotConflict } from "../common/db-errors";
import { JobQueueService } from "../common/job-queue.service";
import { ZodPipe } from "../common/zod.pipe";
import { EventBus } from "../realtime/event-bus";
import { type Hours, covers, intersectHours, loadHours } from "../scheduling/hours";
import { movePlanItemSession, releasePlanItem } from "../scheduling/plan-link";
import { dateFromDay, nextDay, schedulingEvent } from "../scheduling/scheduling-common";
import {
  UUID,
  conflict,
  decodeCursor,
  fireAndLog,
  iso,
  mapPortalDbError,
  notFound,
  pageOf,
  portalTx,
} from "./portal-common";

const ACTIVE = ACTIVE_APPOINTMENT_STATUSES as readonly AppointmentStatus[];
const DEDUPE_BOOK = "portal.appointment.book";
const DEDUPE_RESCHEDULE = "portal.appointment.reschedule";
const SERVICE_NOTE = /^Service: (.+)$/m;
const MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------------------------
// Free resources of one branch-local day (the availability maths: branch ∩ dentist ∩ chair hours minus the active
// appointments of the dentist and the chair). Advisory only: the DB exclusion constraints decide at insert time.
// ---------------------------------------------------------------------------------------------

interface DayCtx {
  tz: string;
  day: string;
  stepMin: number;
  allowUnassigned: boolean;
  branchHours: Hours;
  dentists: { userId: string; hours: Hours }[];
  chairs: { id: string; hours: Hours }[];
  busy: { startsAt: Date; endsAt: Date; dentistUserId: string | null; chairId: string | null }[];
}
type Candidate = { dentistUserId: string | null; chairId: string | null };

async function loadDayCtx(
  tx: Tx,
  tenantId: string,
  branch: Branch,
  day: string,
  opts: { excludeAppointmentId?: string } = {},
): Promise<DayCtx> {
  const settings = resolveSchedulingSettings(branch.settings);
  const d = dateFromDay(day);
  const weekday = d.getUTCDay();
  const assignments = await tx.dentistBranchAssignment.findMany({
    where: {
      branchId: branch.id,
      effectiveFrom: { lte: d },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: d } }],
    },
    select: { userId: true },
  });
  const members = assignments.length
    ? await tx.membership.findMany({
        where: { userId: { in: [...new Set(assignments.map((a) => a.userId))] } },
        select: { userId: true, roles: true },
        orderBy: { userId: "asc" },
      })
    : [];
  const dentistIds = members.filter((m) => m.roles.includes("DENTIST")).map((m) => m.userId);
  const chairRows = await tx.chair.findMany({
    where: { branchId: branch.id, active: true },
    orderBy: { code: "asc" },
  });
  const chairIds = chairRows.map((c) => c.id);
  const base = await loadHours(tx, branch, day, weekday, { chairIds });
  const dentists: DayCtx["dentists"] = [];
  for (const userId of dentistIds) {
    const h = await loadHours(tx, branch, day, weekday, { dentistUserId: userId });
    dentists.push({ userId, hours: h.dentist ?? null });
  }
  const dayStart = zonedToUtc(day, 0, branch.timezone);
  const dayEnd = zonedToUtc(nextDay(day), 0, branch.timezone);
  const or: Prisma.AppointmentWhereInput[] = [];
  if (dentistIds.length) or.push({ dentistUserId: { in: dentistIds } });
  if (chairIds.length) or.push({ chairId: { in: chairIds } });
  const busy = or.length
    ? await tx.appointment.findMany({
        where: {
          tenantId,
          status: { in: [...ACTIVE] },
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
          ...(opts.excludeAppointmentId ? { id: { not: opts.excludeAppointmentId } } : {}),
          OR: or,
        },
        select: { startsAt: true, endsAt: true, dentistUserId: true, chairId: true },
      })
    : [];
  return {
    tz: branch.timezone,
    day,
    stepMin: settings.slotMinutes,
    allowUnassigned: settings.allowUnassignedDentist,
    branchHours: base.branch,
    dentists,
    chairs: chairRows.map((c) => ({ id: c.id, hours: base.chairs.get(c.id) ?? null })),
    busy,
  };
}

const overlaps = (
  xs: DayCtx["busy"],
  pick: (b: DayCtx["busy"][number]) => string | null,
  id: string,
  s: Date,
  e: Date,
) => xs.some((b) => pick(b) === id && b.startsAt < e && b.endsAt > s);

/** Every (dentist, chair) pair that is free for `[startsAt, +durationMin)`, best first. */
function candidatesAt(ctx: DayCtx, startsAt: Date, durationMin: number): Candidate[] {
  const local = utcToZoned(startsAt, ctx.tz);
  if (local.date !== ctx.day) return [];
  const m = local.minuteOfDay;
  const end = m + durationMin;
  if (end > 1440) return [];
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);
  const dentists: (string | null)[] = ctx.dentists
    .filter(
      (d) =>
        covers(intersectHours(ctx.branchHours, d.hours), m, end) &&
        !overlaps(ctx.busy, (b) => b.dentistUserId, d.userId, startsAt, endsAt),
    )
    .map((d) => d.userId);
  if (ctx.dentists.length === 0) {
    if (!ctx.allowUnassigned || !covers(ctx.branchHours, m, end)) return [];
    dentists.push(null);
  }
  const chairs: (string | null)[] = ctx.chairs
    .filter(
      (c) =>
        covers(intersectHours(ctx.branchHours, c.hours), m, end) &&
        !overlaps(ctx.busy, (b) => b.chairId, c.id, startsAt, endsAt),
    )
    .map((c) => c.id);
  if (ctx.chairs.length === 0) chairs.push(null);
  const out: Candidate[] = [];
  for (const dentistUserId of dentists)
    for (const chairId of chairs) {
      out.push({ dentistUserId, chairId });
      if (out.length >= 8) return out;
    }
  return out;
}

/** "Service: X" first line + the patient's own note. */
const bookingNotes = (serviceName: string | null, note: string | undefined) =>
  [serviceName ? `Service: ${serviceName}` : null, note?.trim() || null]
    .filter(Boolean)
    .join("\n") || null;

const joinAddress = (b: Branch) =>
  [b.addressLine1, b.addressLine2, b.city, b.state, b.postalCode].filter(Boolean).join(", ") ||
  null;

/** Length of the `rescheduledFromId` chain behind each appointment. */
async function rescheduleDepths(tx: Tx, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ id: string; n: number }[]>`
    WITH RECURSIVE c(origin, cur, depth) AS (
      SELECT a."id", a."rescheduledFromId", 0 FROM "Appointment" a WHERE a."id" = ANY(${ids}::uuid[])
      UNION ALL
      SELECT c.origin, a."rescheduledFromId", c.depth + 1
        FROM c JOIN "Appointment" a ON a."id" = c.cur
       WHERE c.cur IS NOT NULL AND c.depth < 50
    )
    SELECT origin::text AS id, (count(*) FILTER (WHERE cur IS NOT NULL))::int AS n FROM c GROUP BY origin`;
  return new Map(rows.map((r) => [r.id, r.n]));
}

type PortalApptRow = Appointment & { branch: Branch };

async function toPortalAppointments(
  tx: Tx,
  rows: PortalApptRow[],
  settings: ResolvedPortalSettings,
  now: Date,
): Promise<PortalAppointmentResponse[]> {
  const depths = await rescheduleDepths(
    tx,
    rows.map((r) => r.id),
  );
  const dentistIds = [...new Set(rows.map((r) => r.dentistUserId).filter((x): x is string => !!x))];
  const names = new Map(
    (dentistIds.length
      ? await tx.membership.findMany({
          where: { userId: { in: dentistIds } },
          select: { userId: true, displayName: true },
        })
      : []
    ).map((m) => [m.userId, m.displayName]),
  );
  const planItemIds = [...new Set(rows.map((r) => r.planItemId).filter((x): x is string => !!x))];
  const itemService = new Map(
    (planItemIds.length
      ? await tx.planItem.findMany({
          where: { id: { in: planItemIds } },
          select: { id: true, service: { select: { name: true } } },
        })
      : []
    ).map((i) => [i.id, i.service.name]),
  );
  return rows.map((a) => {
    const used = depths.get(a.id) ?? 0;
    const common = {
      now,
      status: a.status,
      currentStartsAt: a.startsAt,
      reschedulesUsed: used,
      rules: settings,
    };
    const rs = evaluatePortalChange({ ...common, action: "reschedule" });
    const cn = evaluatePortalChange({ ...common, action: "cancel" });
    const canReschedule = rs.length === 0;
    const canCancel = cn.length === 0;
    const blocked: PortalBookingViolation | null =
      canReschedule && canCancel ? null : (rs[0] ?? cn[0] ?? null);
    return {
      id: a.id,
      status: a.status,
      appointmentType: a.appointmentType,
      startsAt: iso(a.startsAt),
      endsAt: iso(a.endsAt),
      branch: {
        id: a.branch.id,
        name: a.branch.name,
        phone: a.branch.phone,
        address: joinAddress(a.branch),
        timeZone: a.branch.timezone,
      },
      dentistName: (a.dentistUserId ? names.get(a.dentistUserId) : null) ?? null,
      serviceName:
        (a.notes ? SERVICE_NOTE.exec(a.notes)?.[1] : null) ??
        (a.planItemId ? (itemService.get(a.planItemId) ?? null) : null),
      reschedulesUsed: used,
      canReschedule,
      canCancel,
      changeBlockedReason: blocked,
    };
  });
}

async function tenantSettings(tx: Tx, tenantId: string) {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  return resolvePortalSettings(t?.settings);
}

const violationError = (v: PortalBookingViolation[]) =>
  conflict(PORTAL_VIOLATION_ERROR[v[0] as PortalBookingViolation], { violations: v });

/**
 * Portal booking (ADR 0005 §3.3). Clinic rules come from the pure evaluators; the free-slot maths mirror the staff
 * availability engine; double booking is decided by the DB exclusion constraints (23P01 -> the next free dentist / chair
 * is tried, then 409 `slot_unavailable`). A patient never chooses a dentist or chair and never books outside working hours.
 */
@Injectable()
export class PortalAppointmentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: PortalAuditService,
    private readonly bus: EventBus,
    private readonly jobs: JobQueueService,
  ) {}

  async list(me: PatientPrincipal, q: ListPortalAppointmentsQuery) {
    const now = new Date();
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const settings = await tenantSettings(tx, me.tenantId);
      const open: AppointmentStatus[] = ["BOOKED", "CONFIRMED", "CHECKED_IN", "IN_CHAIR"];
      const upcoming: Prisma.AppointmentWhereInput = { endsAt: { gt: now }, status: { in: open } };
      const and: Prisma.AppointmentWhereInput[] = [{ patientId: { in: me.patientIds } }];
      if (q.scope === "upcoming") and.push(upcoming);
      if (q.scope === "past") and.push({ NOT: upcoming });
      const asc = q.scope === "upcoming";
      const c = decodeCursor(q.cursor);
      if (c)
        and.push(
          asc
            ? { OR: [{ startsAt: { gt: c.at } }, { startsAt: c.at, id: { gt: c.id } }] }
            : { OR: [{ startsAt: { lt: c.at } }, { startsAt: c.at, id: { lt: c.id } }] },
        );
      const rows = await tx.appointment.findMany({
        where: { AND: and },
        include: { branch: true },
        orderBy: asc
          ? [{ startsAt: "asc" }, { id: "asc" }]
          : [{ startsAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const page = pageOf(rows, q.limit, (r) => r.startsAt);
      return {
        items: await toPortalAppointments(tx, page.items, settings, now),
        nextCursor: page.nextCursor,
      };
    });
  }

  async get(me: PatientPrincipal, id: string): Promise<PortalAppointmentResponse> {
    const now = new Date();
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const a = await tx.appointment.findFirst({
        where: { id, patientId: { in: me.patientIds } },
        include: { branch: true },
      });
      if (!a) throw notFound("appointment_not_found");
      const [item] = await toPortalAppointments(
        tx,
        [a],
        await tenantSettings(tx, me.tenantId),
        now,
      );
      return item as PortalAppointmentResponse;
    });
  }

  async options(me: PatientPrincipal): Promise<PortalBookingOptionsResponse> {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const settings = await tenantSettings(tx, me.tenantId);
      const branches = await tx.branch.findMany({
        where: {
          active: true,
          ...(settings.bookableBranchIds ? { id: { in: settings.bookableBranchIds } } : {}),
        },
        orderBy: { name: "asc" },
      });
      const services = await tx.service.findMany({
        where: { portalBookable: true, active: true },
        orderBy: { name: "asc" },
      });
      const out: PortalBookingOptionsResponse["branches"] = [];
      for (const b of branches) {
        const overrides = await overridesFor(
          tx,
          me.tenantId,
          b.id,
          services.map((s) => s.id),
        );
        out.push({
          id: b.id,
          name: b.name,
          phone: b.phone,
          address: joinAddress(b),
          timeZone: b.timezone,
          services: services.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            durationMin: s.durationMin,
            pricePaise: effectivePrice(s, b.id, overrides.get(s.id)).pricePaise,
          })),
        });
      }
      return {
        branches: out,
        appointmentTypes:
          settings.bookableAppointmentTypes as PortalBookingOptionsResponse["appointmentTypes"],
        rules: {
          minNoticeHours: settings.minNoticeHours,
          maxAdvanceDays: settings.maxAdvanceDays,
          maxReschedules: settings.maxReschedules,
          defaultDurationMin: settings.defaultDurationMin,
        },
      };
    });
  }

  /** The branch (bookable) + service (bookable) + type + duration shared by slots and booking. */
  private async resolveTarget(
    tx: Tx,
    settings: ResolvedPortalSettings,
    t: { branchId: string; serviceId?: string; appointmentType?: string },
  ) {
    const branch = await tx.branch.findUnique({ where: { id: t.branchId } });
    if (
      !branch ||
      !branch.active ||
      (settings.bookableBranchIds && !settings.bookableBranchIds.includes(branch.id))
    )
      throw notFound("branch_not_found");
    const service = t.serviceId
      ? await tx.service.findUnique({ where: { id: t.serviceId } })
      : null;
    if (t.serviceId && (!service || !service.active)) throw notFound("service_not_found");
    const appointmentType =
      t.appointmentType ??
      (settings.bookableAppointmentTypes.includes("CONSULTATION")
        ? "CONSULTATION"
        : (settings.bookableAppointmentTypes[0] as string));
    return {
      branch,
      service,
      appointmentType,
      durationMin: service?.durationMin ?? settings.defaultDurationMin,
    };
  }

  async slots(me: PatientPrincipal, q: PortalSlotsQuery): Promise<PortalSlotsResponse> {
    const now = new Date();
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const settings = await tenantSettings(tx, me.tenantId);
      const { branch, service, appointmentType, durationMin } = await this.resolveTarget(
        tx,
        settings,
        q,
      );
      if (service && !service.portalBookable) throw conflict("booking_service_not_bookable");
      if (!settings.bookableAppointmentTypes.includes(appointmentType as never))
        throw conflict("booking_type_not_bookable");
      const ctx = await loadDayCtx(tx, me.tenantId, branch, q.date);
      const slots: PortalSlotsResponse["slots"] = [];
      for (let m = 0; m + durationMin <= 1440; m += ctx.stepMin) {
        const s = zonedToUtc(q.date, m, ctx.tz);
        // Offer only what a booking would accept (notice, horizon) so the UI never shows a slot that is refused.
        const v = evaluatePortalBooking({
          now,
          startsAt: s,
          rules: settings,
          appointmentType,
          activeFutureBookings: 0,
        });
        if (v.includes("in_past") || v.includes("too_soon") || v.includes("too_far")) continue;
        if (candidatesAt(ctx, s, durationMin).length === 0) continue;
        slots.push({
          startsAt: iso(s),
          endsAt: iso(new Date(s.getTime() + durationMin * 60_000)),
        });
      }
      return { branchId: branch.id, date: q.date, timeZone: ctx.tz, durationMin, slots };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Book
  // -------------------------------------------------------------------------------------------

  async book(me: PatientPrincipal, body: PortalBookAppointmentRequest) {
    const now = new Date();
    const startsAt = new Date(body.startsAt);
    let result: { appointment: Appointment; created: boolean } | undefined;
    for (let attempt = 1; !result; attempt++) {
      try {
        result = await portalTx(this.prisma, me, async (tx) => {
          const key = `${me.patientId}:${body.idempotencyKey}`;
          const prev = await tx.requestDedupe.findUnique({
            where: {
              tenantId_scope_idempotencyKey: {
                tenantId: me.tenantId,
                scope: DEDUPE_BOOK,
                idempotencyKey: key,
              },
            },
          });
          if (prev?.refId) {
            const a = await tx.appointment.findFirst({
              where: { id: prev.refId, patientId: me.patientId },
            });
            if (a) return { appointment: a, created: false };
          }
          const settings = await tenantSettings(tx, me.tenantId);
          const { branch, service, appointmentType, durationMin } = await this.resolveTarget(
            tx,
            settings,
            body,
          );
          const active = await tx.appointment.count({
            where: {
              patientId: { in: me.patientIds },
              status: { in: ["BOOKED", "CONFIRMED"] },
              startsAt: { gt: now },
            },
          });
          const violations = evaluatePortalBooking({
            now,
            startsAt,
            rules: settings,
            appointmentType,
            serviceBookable: service ? service.portalBookable : undefined,
            activeFutureBookings: active,
          });
          if (violations.length > 0) throw violationError(violations);
          const local = utcToZoned(startsAt, branch.timezone);
          const ctx = await loadDayCtx(tx, me.tenantId, branch, local.date);
          const cand =
            local.minuteOfDay % ctx.stepMin === 0
              ? candidatesAt(ctx, startsAt, durationMin)[0]
              : undefined;
          if (!cand) throw conflict("slot_unavailable");
          const a = await tx.appointment.create({
            data: {
              tenantId: me.tenantId,
              patientId: me.patientId,
              branchId: branch.id,
              dentistUserId: cand.dentistUserId,
              chairId: cand.chairId,
              appointmentType,
              startsAt,
              endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
              source: "SCHEDULED",
              notes: bookingNotes(service?.name ?? null, body.notes),
              createdBy: me.actorId,
            },
          });
          await tx.appointmentEvent.create({
            data: {
              tenantId: me.tenantId,
              appointmentId: a.id,
              fromStatus: null,
              toStatus: "BOOKED",
              actorId: me.actorId,
              reason: "Booked in the patient portal",
            },
          });
          await tx.requestDedupe.create({
            data: {
              tenantId: me.tenantId,
              scope: DEDUPE_BOOK,
              idempotencyKey: key,
              refType: "appointment",
              refId: a.id,
              createdBy: me.actorId,
            },
          });
          return { appointment: a, created: true };
        });
      } catch (e) {
        if (slotConflict(e)) {
          if (attempt >= MAX_ATTEMPTS) throw conflict("slot_unavailable");
          continue; // the winner is committed now: the next pass picks the next free dentist / chair
        }
        throw e;
      }
    }
    if (result.created) {
      const a = result.appointment;
      await this.audit.record(me, {
        action: "portal.appointment.book",
        resource: "appointment",
        resourceId: a.id,
        branchId: a.branchId,
        outcome: "success",
      });
      this.bus.publish(schedulingEvent("appointment.created", a, null, a.status));
      this.notify(me, a.id, "BOOKED");
    }
    return this.get(me, result.appointment.id);
  }

  // -------------------------------------------------------------------------------------------
  // Reschedule / cancel
  // -------------------------------------------------------------------------------------------

  async reschedule(me: PatientPrincipal, id: string, body: PortalRescheduleRequest) {
    const now = new Date();
    const startsAt = new Date(body.startsAt);
    let result: { old: Appointment; next: Appointment; created: boolean } | undefined;
    for (let attempt = 1; !result; attempt++) {
      try {
        result = await portalTx(this.prisma, me, async (tx) => {
          const key = body.idempotencyKey ? `${me.patientId}:${id}:${body.idempotencyKey}` : null;
          if (key) {
            const prev = await tx.requestDedupe.findUnique({
              where: {
                tenantId_scope_idempotencyKey: {
                  tenantId: me.tenantId,
                  scope: DEDUPE_RESCHEDULE,
                  idempotencyKey: key,
                },
              },
            });
            if (prev?.refId) {
              const next = await tx.appointment.findFirst({
                where: { id: prev.refId, patientId: me.patientId },
              });
              const old = await tx.appointment.findFirst({
                where: { id, patientId: { in: me.patientIds } },
              });
              if (next && old) return { old, next, created: false };
            }
          }
          const old = await tx.appointment.findFirst({
            where: { id, patientId: { in: me.patientIds } },
          });
          if (!old) throw notFound("appointment_not_found");
          if (old.patientId !== me.patientId) throw conflict("patient_merged");
          const settings = await tenantSettings(tx, me.tenantId);
          const depth = (await rescheduleDepths(tx, [old.id])).get(old.id) ?? 0;
          const violations = evaluatePortalChange({
            now,
            action: "reschedule",
            status: old.status,
            currentStartsAt: old.startsAt,
            newStartsAt: startsAt,
            reschedulesUsed: depth,
            rules: settings,
          });
          if (violations.length > 0) throw violationError(violations);
          if (!canTransitionAppointment(old.status, "RESCHEDULED"))
            throw conflict("appointment_not_changeable");
          const branch = await tx.branch.findUnique({ where: { id: old.branchId } });
          if (!branch || !branch.active) throw conflict("branch_inactive");
          const durationMin = Math.round((old.endsAt.getTime() - old.startsAt.getTime()) / 60_000);
          const local = utcToZoned(startsAt, branch.timezone);
          const ctx = await loadDayCtx(tx, me.tenantId, branch, local.date, {
            excludeAppointmentId: old.id,
          });
          const cands =
            local.minuteOfDay % ctx.stepMin === 0 ? candidatesAt(ctx, startsAt, durationMin) : [];
          // Keep the same dentist / chair when they are still free.
          cands.sort(
            (x, y) =>
              Number(y.dentistUserId === old.dentistUserId) -
                Number(x.dentistUserId === old.dentistUserId) ||
              Number(y.chairId === old.chairId) - Number(x.chairId === old.chairId),
          );
          const cand = cands[0];
          if (!cand) throw conflict("slot_unavailable");
          const moved = await tx.appointment.updateMany({
            where: { id: old.id, status: old.status },
            data: { status: "RESCHEDULED" },
          });
          if (moved.count !== 1) throw conflict("appointment_changed");
          await tx.appointmentEvent.create({
            data: {
              tenantId: me.tenantId,
              appointmentId: old.id,
              fromStatus: old.status,
              toStatus: "RESCHEDULED",
              actorId: me.actorId,
              reason: body.reason || "Rescheduled in the patient portal",
            },
          });
          const next = await tx.appointment.create({
            data: {
              tenantId: me.tenantId,
              patientId: me.patientId,
              branchId: old.branchId,
              dentistUserId: cand.dentistUserId,
              chairId: cand.chairId,
              appointmentType: old.appointmentType,
              startsAt,
              endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
              source: old.source,
              rescheduledFromId: old.id,
              planItemId: old.planItemId,
              notes: old.notes,
              createdBy: me.actorId,
            },
          });
          await tx.appointmentEvent.create({
            data: {
              tenantId: me.tenantId,
              appointmentId: next.id,
              fromStatus: null,
              toStatus: "BOOKED",
              actorId: me.actorId,
              reason: body.reason || "Rescheduled in the patient portal",
            },
          });
          if (old.planItemId) await movePlanItemSession(tx, old.planItemId, old.id, next.id);
          if (key)
            await tx.requestDedupe.create({
              data: {
                tenantId: me.tenantId,
                scope: DEDUPE_RESCHEDULE,
                idempotencyKey: key,
                refType: "appointment",
                refId: next.id,
                createdBy: me.actorId,
              },
            });
          return {
            old: await tx.appointment.findUniqueOrThrow({ where: { id: old.id } }),
            next,
            created: true,
          };
        });
      } catch (e) {
        if (slotConflict(e)) {
          if (attempt >= MAX_ATTEMPTS) throw conflict("slot_unavailable");
          continue;
        }
        throw e;
      }
    }
    if (result.created) {
      await this.audit.record(me, {
        action: "portal.appointment.reschedule",
        resource: "appointment",
        resourceId: result.next.id,
        branchId: result.next.branchId,
        outcome: "success",
      });
      this.bus.publish(
        schedulingEvent("appointment.rescheduled", result.old, "BOOKED", "RESCHEDULED", {
          newAppointmentId: result.next.id,
        }),
      );
      this.bus.publish(schedulingEvent("appointment.created", result.next, null, "BOOKED"));
      this.notify(me, result.next.id, "RESCHEDULED");
    }
    return this.get(me, result.next.id);
  }

  async cancel(me: PatientPrincipal, id: string, body: PortalCancelRequest) {
    const now = new Date();
    const a = await portalTx(this.prisma, me, async (tx) => {
      const cur = await tx.appointment.findFirst({
        where: { id, patientId: { in: me.patientIds } },
      });
      if (!cur) throw notFound("appointment_not_found");
      if (cur.patientId !== me.patientId) throw conflict("patient_merged");
      const settings = await tenantSettings(tx, me.tenantId);
      if (cur.status === "CANCELLED") return { row: cur, changed: false, from: cur.status };
      const violations = evaluatePortalChange({
        now,
        action: "cancel",
        status: cur.status,
        currentStartsAt: cur.startsAt,
        reschedulesUsed: 0,
        rules: settings,
      });
      if (violations.length > 0) throw violationError(violations);
      if (!canTransitionAppointment(cur.status, "CANCELLED"))
        throw conflict("appointment_not_changeable");
      const reason = body.reason || "Cancelled by the patient in the portal";
      const moved = await tx.appointment.updateMany({
        where: { id: cur.id, status: cur.status },
        data: { status: "CANCELLED", cancelReason: reason },
      });
      if (moved.count !== 1) throw conflict("appointment_changed");
      await tx.appointmentEvent.create({
        data: {
          tenantId: me.tenantId,
          appointmentId: cur.id,
          fromStatus: cur.status,
          toStatus: "CANCELLED",
          actorId: me.actorId,
          reason,
        },
      });
      if (cur.planItemId) await releasePlanItem(tx, cur.id, cur.planItemId);
      return {
        row: await tx.appointment.findUniqueOrThrow({ where: { id: cur.id } }),
        changed: true,
        from: cur.status,
      };
    });
    if (a.changed) {
      await this.audit.record(me, {
        action: "portal.appointment.cancel",
        resource: "appointment",
        resourceId: id,
        branchId: a.row.branchId,
        outcome: "success",
      });
      this.bus.publish(schedulingEvent("appointment.cancelled", a.row, a.from, "CANCELLED"));
      this.notify(me, id, "CANCELLED");
    }
    return this.get(me, id);
  }

  private notify(
    me: PatientPrincipal,
    appointmentId: string,
    change: "BOOKED" | "CANCELLED" | "RESCHEDULED",
  ) {
    fireAndLog(
      `appointment ${change.toLowerCase()} notice`,
      this.jobs.enqueue(NOTIFICATION_QUEUES.APPOINTMENT_CHANGED, {
        tenantId: me.tenantId,
        actorId: me.actorId,
        source: "portal",
        idempotencyKey: `appt-changed:${appointmentId}:${change}`,
        data: { appointmentId, change },
      }),
    );
  }
}

@Controller("portal/appointments")
export class PortalAppointmentsController {
  constructor(private readonly svc: PortalAppointmentsService) {}

  @PortalAuth()
  @Get()
  list(
    @CurrentPatient() me: PatientPrincipal,
    @Query(new ZodPipe(listPortalAppointmentsQuery)) q: ListPortalAppointmentsQuery,
  ) {
    return this.svc.list(me, q);
  }

  @PortalAuth()
  @Get("options")
  options(@CurrentPatient() me: PatientPrincipal) {
    return this.svc.options(me);
  }

  @PortalAuth()
  @Get("slots")
  slots(
    @CurrentPatient() me: PatientPrincipal,
    @Query(new ZodPipe(portalSlotsQuery)) q: PortalSlotsQuery,
  ) {
    return this.svc.slots(me, q);
  }

  @PortalAuth()
  @Get(":id")
  get(@CurrentPatient() me: PatientPrincipal, @Param("id", UUID) id: string) {
    return this.svc.get(me, id);
  }

  @PortalAuth()
  @Post()
  book(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalBookAppointmentRequest)) body: PortalBookAppointmentRequest,
  ) {
    return this.svc.book(me, body);
  }

  @PortalAuth()
  @Post(":id/reschedule")
  @HttpCode(200)
  reschedule(
    @CurrentPatient() me: PatientPrincipal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(portalRescheduleRequest)) body: PortalRescheduleRequest,
  ) {
    return this.svc.reschedule(me, id, body);
  }

  @PortalAuth()
  @Post(":id/cancel")
  @HttpCode(200)
  cancel(
    @CurrentPatient() me: PatientPrincipal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(portalCancelRequest)) body: PortalCancelRequest,
  ) {
    return this.svc.cancel(me, id, body);
  }
}

void mapPortalDbError;
