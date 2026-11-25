import { Prisma, type Tx } from "@dentalos/db";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  addCalendarDays,
  utcToZoned,
  utilisationBp,
  zonedToUtc,
} from "@dentalos/validation";
import {
  type Hours,
  type Interval,
  branchJsonHours,
  intersectHours,
  mergeIntervals,
  sessionsOn,
} from "../scheduling/hours";
import { dateOnlyToDate, num, shortName } from "./analytics-common";

// Live (today) parts of the branch dashboard: waiting patients from the check-in queue, dentist availability (working
// hours vs booked), today's schedule shape and today's money. TTL 30 s. ADR 0005 §4.2.

export interface LiveBranch {
  id: string;
  timezone: string;
  workingHours: unknown;
}

export interface DayWindow {
  day: string;
  weekday: number;
  minuteOfDay: number;
  start: Date;
  end: Date;
}

export function dayWindow(tz: string, now: Date): DayWindow {
  const z = utcToZoned(now, tz);
  return {
    day: z.date,
    weekday: z.weekday,
    minuteOfDay: z.minuteOfDay,
    start: zonedToUtc(z.date, 0, tz),
    end: zonedToUtc(addCalendarDays(z.date, 1), 0, tz),
  };
}

const ts = (d: Date) => Prisma.sql`${d}::timestamptz`;

export async function todaySchedule(tx: Tx, b: LiveBranch, w: DayWindow, now: Date) {
  // status x hour in one grouped query (the by-status and by-hour views are two projections of it)
  const rows = await tx.$queryRaw<{ s: string; h: number; n: bigint }[]>(Prisma.sql`
    SELECT a."status"::text AS s,
           extract(hour FROM (a."startsAt" AT TIME ZONE ${b.timezone}))::int AS h,
           count(*)::bigint AS n
      FROM "Appointment" a
     WHERE a."branchId" = ${b.id}::uuid
       AND a."startsAt" >= ${ts(w.start)} AND a."startsAt" < ${ts(w.end)}
     GROUP BY 1, 2`);
  const byStatus: Record<string, number> = {};
  const hours = new Map<number, number>();
  for (const r of rows) {
    byStatus[r.s] = (byStatus[r.s] ?? 0) + num(r.n);
    hours.set(r.h, (hours.get(r.h) ?? 0) + num(r.n));
  }
  const total = Object.values(byStatus).reduce((a, n) => a + n, 0);
  const byHour = [...hours.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([hour, count]) => ({ hour, count }));

  const [upcoming, newPatients, invoicesIssued, plansAwaitingDecision] = await Promise.all([
    tx.appointment.findMany({
      where: {
        branchId: b.id,
        startsAt: { gte: now, lt: w.end },
        status: { in: ["BOOKED", "CONFIRMED", "CHECKED_IN"] },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 10,
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        appointmentType: true,
        dentistUserId: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    }),
    tx.patient.count({
      where: {
        originBranchId: b.id,
        mergedIntoId: null,
        createdAt: { gte: w.start, lt: w.end },
      },
    }),
    tx.invoice.count({
      where: {
        branchId: b.id,
        status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] },
        issuedAt: { gte: w.start, lt: w.end },
      },
    }),
    tx.treatmentPlan.count({ where: { branchId: b.id, status: "PRESENTED" } }),
  ]);
  return {
    appointments: total,
    byStatus,
    byHour,
    upcoming: upcoming.map((a) => ({
      appointmentId: a.id,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      appointmentType: a.appointmentType,
      patientDisplayName: shortName(a.patient.firstName, a.patient.lastName),
      dentistUserId: a.dentistUserId,
    })),
    newPatients,
    completedVisits: byStatus.COMPLETED ?? 0,
    invoicesIssued,
    plansAwaitingDecision,
  };
}

export async function waitingQueue(tx: Tx, b: LiveBranch, w: DayWindow, now: Date) {
  const where = {
    branchId: b.id,
    status: "CHECKED_IN" as const,
    startsAt: { gte: w.start, lt: w.end },
  };
  const [count, rows] = await Promise.all([
    tx.appointment.count({ where }),
    tx.appointment.findMany({
      where,
      orderBy: [{ checkedInAt: { sort: "asc", nulls: "last" } }, { startsAt: "asc" }],
      take: 50,
      select: {
        id: true,
        startsAt: true,
        checkedInAt: true,
        dentistUserId: true,
        patient: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);
  return {
    count,
    patients: rows.map((a) => {
      const since = a.checkedInAt ?? a.startsAt;
      return {
        appointmentId: a.id,
        patientDisplayName: shortName(a.patient.firstName, a.patient.lastName),
        checkedInAt: since.toISOString(),
        waitingMinutes: Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000)),
        dentistUserId: a.dentistUserId,
      };
    }),
  };
}

const sumMinutes = (xs: readonly Interval[]) => xs.reduce((a, [s, e]) => a + (e - s), 0);

/** First free minute at/after `fromMin` inside `working` and outside `busy` (both merged); null when none. */
export function nextFreeMinute(
  working: readonly Interval[],
  busy: readonly Interval[],
  fromMin: number,
): number | null {
  for (const [ws, we] of working) {
    let cursor = Math.max(ws, fromMin);
    for (const [bs, be] of busy) {
      if (be <= cursor) continue;
      if (bs >= we) break;
      if (bs > cursor) return cursor < we ? cursor : null;
      cursor = Math.max(cursor, be);
    }
    if (cursor < we) return cursor;
  }
  return null;
}

/**
 * Working minutes (branch hours ∩ the dentist's own hours, ADR 0003 §1.3) versus booked minutes (appointments in
 * ACTIVE statuses) for today, per dentist. Dentists = current branch assignments ∪ anyone with an appointment today.
 * 3 queries in total, whatever the number of dentists. A dentist with no hours configured anywhere (unrestricted)
 * reports 0 working minutes and no utilisation (we cannot say when they are available).
 */
export async function dentistAvailability(tx: Tx, b: LiveBranch, w: DayWindow, now: Date) {
  const d = dateOnlyToDate(w.day);
  const inForce = {
    effectiveFrom: { lte: d },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: d } }],
  };
  const [assigned, appts] = await Promise.all([
    tx.dentistBranchAssignment.findMany({
      where: { branchId: b.id, ...inForce },
      select: { userId: true },
    }),
    tx.appointment.findMany({
      where: {
        branchId: b.id,
        dentistUserId: { not: null },
        startsAt: { gte: w.start, lt: w.end },
        status: { in: [...ACTIVE_APPOINTMENT_STATUSES] },
      },
      select: { dentistUserId: true, startsAt: true, endsAt: true, status: true },
    }),
  ]);
  const dentists = [
    ...new Set([
      ...assigned.map((a) => a.userId),
      ...appts.flatMap((a) => (a.dentistUserId ? [a.dentistUserId] : [])),
    ]),
  ].sort();
  if (dentists.length === 0) return [];

  const hourRows = await tx.workingHours.findMany({
    where: {
      AND: [
        inForce,
        {
          OR: [
            { scope: "BRANCH", branchId: b.id },
            { scope: "DENTIST", userId: { in: dentists } },
          ],
        },
      ],
    },
  });
  const branchRows = hourRows.filter((r) => r.scope === "BRANCH");
  const branchHours: Hours =
    branchRows.length > 0
      ? sessionsOn(branchRows, w.weekday)
      : branchJsonHours(b.workingHours, w.weekday);

  const minuteOf = (t: Date) =>
    Math.min(1440, Math.max(0, Math.round((t.getTime() - w.start.getTime()) / 60_000)));
  return dentists.map((id) => {
    const own = hourRows.filter((r) => r.scope === "DENTIST" && r.userId === id);
    const dentistHours: Hours =
      own.length > 0
        ? sessionsOn(
            own.filter((r) => r.branchId === b.id),
            w.weekday,
          )
        : null;
    const allowed = intersectHours(branchHours, dentistHours);
    const mine = appts.filter((a) => a.dentistUserId === id);
    const bookedMinutes = mine.reduce(
      (n, a) => n + Math.max(0, minuteOf(a.endsAt) - minuteOf(a.startsAt)),
      0,
    );
    const busy = mergeIntervals(
      mine.map((a) => [minuteOf(a.startsAt), minuteOf(a.endsAt)] as const),
    );
    const working = allowed === null ? [] : mergeIntervals(allowed);
    const workingMinutes = sumMinutes(working);
    const next = nextFreeMinute(working, busy, w.minuteOfDay);
    return {
      dentistUserId: id,
      workingMinutes,
      bookedMinutes,
      freeMinutes: Math.max(0, workingMinutes - bookedMinutes),
      utilisationBp: utilisationBp(bookedMinutes, workingMinutes),
      nextFreeAt: next === null ? null : zonedToUtc(w.day, next, b.timezone).toISOString(),
      inChairNow: mine.some((a) => a.status === "IN_CHAIR" && a.startsAt <= now),
    };
  });
}

/** Today's money at the branch: billed, collections net of refunds, and collections by payment method. */
export async function todayFinance(tx: Tx, b: LiveBranch, w: DayWindow) {
  const [billed, pay, ref] = await Promise.all([
    tx.$queryRaw<{ v: bigint }[]>(Prisma.sql`
      SELECT coalesce(sum(i."totalPaise"), 0)::bigint AS v
        FROM "Invoice" i
       WHERE i."branchId" = ${b.id}::uuid AND i."status" IN ('ISSUED','PARTIALLY_PAID','PAID')
         AND i."issuedAt" >= ${ts(w.start)} AND i."issuedAt" < ${ts(w.end)}`),
    tx.$queryRaw<{ m: string; v: bigint; n: bigint }[]>(Prisma.sql`
      SELECT p."method"::text AS m, coalesce(sum(p."amountPaise"), 0)::bigint AS v, count(*)::bigint AS n
        FROM "Payment" p
       WHERE p."branchId" = ${b.id}::uuid AND p."status" = 'RECORDED'
         AND p."receivedAt" >= ${ts(w.start)} AND p."receivedAt" < ${ts(w.end)}
       GROUP BY 1`),
    tx.$queryRaw<{ m: string; v: bigint }[]>(Prisma.sql`
      SELECT r."method"::text AS m, coalesce(sum(r."amountPaise"), 0)::bigint AS v
        FROM "Refund" r
       WHERE r."branchId" = ${b.id}::uuid AND r."status" = 'PROCESSED'
         AND r."processedAt" >= ${ts(w.start)} AND r."processedAt" < ${ts(w.end)}
       GROUP BY 1`),
  ]);
  const methods = new Map<string, { paise: number; payments: number }>();
  for (const r of pay) methods.set(r.m, { paise: num(r.v), payments: num(r.n) });
  for (const r of ref) {
    const m = methods.get(r.m) ?? { paise: 0, payments: 0 };
    m.paise -= num(r.v);
    methods.set(r.m, m);
  }
  const collectionsByMethod = [...methods.entries()]
    .map(([method, v]) => ({ method, paise: v.paise, payments: v.payments }))
    .sort((a, c) => c.paise - a.paise || a.method.localeCompare(c.method));
  return {
    billedPaise: num(billed[0]?.v),
    collectedPaise: collectionsByMethod.reduce((a, m) => a + m.paise, 0),
    collectionsByMethod,
  };
}
