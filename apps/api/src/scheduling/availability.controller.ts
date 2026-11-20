import { PrismaClient, withTenant } from "@dentalos/db";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  type AvailabilityQuery,
  type AvailabilityResponse,
  availabilityQuery,
  resolveSchedulingSettings,
  zonedToUtc,
} from "@dentalos/validation";
import { Controller, Get, Inject, Injectable, Query } from "@nestjs/common";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, assertCan } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { covers, intersectHours, loadHours } from "./hours";
import {
  assertDentist,
  dateFromDay,
  findBookableChair,
  findBranchOr404,
  nextDay,
} from "./scheduling-common";

type Busy = { startsAt: Date; endsAt: Date };
const overlaps = (xs: readonly Busy[], s: Date, e: Date) =>
  xs.some((b) => b.startsAt < e && b.endsAt > s);

/**
 * Free slots on a branch-local date: working hours (branch ∩ dentist ∩ chair) minus active
 * appointments of the dentist (any branch — the dentist exclusion constraint is tenant-wide) and of
 * the chairs. A slot needs the dentist (when given) free and at least one active chair free (when the
 * branch has chairs). Past slots are omitted. Advisory only: booking still relies on the DB
 * exclusion constraints.
 */
@Injectable()
export class AvailabilityService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async query(p: Principal, q: AvailabilityQuery, now = new Date()): Promise<AvailabilityResponse> {
    assertCan(p, "appointment:read", { branchId: q.branchId });
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const branch = await findBranchOr404(tx, q.branchId);
      const tz = branch.timezone;
      const step = q.stepMin ?? resolveSchedulingSettings(branch.settings).slotMinutes;
      if (q.dentistUserId) await assertDentist(tx, p.tenantId, branch.id, q.dentistUserId, q.date);
      const chairs = q.chairId
        ? [await findBookableChair(tx, branch.id, q.chairId)]
        : await tx.chair.findMany({
            where: { branchId: branch.id, active: true },
            orderBy: { code: "asc" },
          });
      const chairIds = chairs.map((c) => c.id);
      const weekday = dateFromDay(q.date).getUTCDay();
      const ctx = await loadHours(tx, branch, q.date, weekday, {
        dentistUserId: q.dentistUserId,
        chairIds,
      });

      const dayStart = zonedToUtc(q.date, 0, tz);
      const dayEnd = zonedToUtc(nextDay(q.date), 0, tz);
      const or: object[] = [];
      if (q.dentistUserId) or.push({ dentistUserId: q.dentistUserId });
      if (chairIds.length) or.push({ chairId: { in: chairIds } });
      const busy = or.length
        ? await tx.appointment.findMany({
            where: {
              status: { in: [...ACTIVE_APPOINTMENT_STATUSES] },
              startsAt: { lt: dayEnd },
              endsAt: { gt: dayStart },
              OR: or,
            },
            select: { startsAt: true, endsAt: true, dentistUserId: true, chairId: true },
          })
        : [];
      const dentistBusy = busy.filter(
        (b) => q.dentistUserId && b.dentistUserId === q.dentistUserId,
      );
      const chairBusy = new Map(chairIds.map((id) => [id, busy.filter((b) => b.chairId === id)]));
      const base = intersectHours(ctx.branch, ctx.dentist ?? null);
      const chairHours = new Map(
        chairIds.map((id) => [id, intersectHours(base, ctx.chairs.get(id) ?? null)]),
      );

      const slots: AvailabilityResponse["slots"] = [];
      for (let m = 0; m + q.durationMin <= 1440; m += step) {
        const end = m + q.durationMin;
        if (!covers(base, m, end)) continue;
        const s = zonedToUtc(q.date, m, tz);
        const e = new Date(s.getTime() + q.durationMin * 60_000);
        if (s < now) continue;
        if (q.dentistUserId && overlaps(dentistBusy, s, e)) continue;
        const free = chairIds.filter(
          (id) =>
            covers(chairHours.get(id) ?? null, m, end) && !overlaps(chairBusy.get(id) ?? [], s, e),
        );
        if (chairIds.length > 0 && free.length === 0) continue;
        slots.push({ startsAt: s.toISOString(), endsAt: e.toISOString(), chairIds: free });
      }
      return { branchId: branch.id, date: q.date, timeZone: tz, durationMin: q.durationMin, slots };
    });
  }
}

@Controller("availability")
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Can("appointment:read")
  @Get()
  query(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(availabilityQuery)) q: AvailabilityQuery,
  ) {
    return this.availability.query(p, q);
  }
}
