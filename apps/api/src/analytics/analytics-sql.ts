import { Prisma, type Tx } from "@dentalos/db";
import {
  type AgingBucket,
  type AnalyticsGrain,
  OUTSTANDING_AGING_BUCKETS,
  type TrendMetric,
  agingBucket,
} from "@dentalos/validation";
import { branchIn, num } from "./analytics-common";

// SQL aggregations (ADR 0005 §4.1, §4.8). Every function runs inside the caller's `withTenant` transaction (RLS), takes
// the branch ids the caller may see (already intersected with their scope) and returns small grouped result sets:
// one grouped query per entity, never one query per branch / dentist / day. Column / enum text interpolated with
// Prisma.raw is always a constant from this file or a validated enum; every value is a bound parameter.

export interface Win {
  start: Date;
  end: Date;
}
/** Current + previous (equal length, immediately before) windows. */
export interface Wins {
  cur: Win;
  prev: Win;
}
export interface Cnt {
  cur: number;
  prev: number;
}
const zeroCnt = (): Cnt => ({ cur: 0, prev: 0 });

/** Invoices that count as billed (ADR 0005 §4.2). */
const ISSUED = Prisma.sql`i."status" IN ('ISSUED','PARTIALLY_PAID','PAID')`;
const ts = (d: Date) => Prisma.sql`${d}::timestamptz`;
/** `count/sum(...) FILTER (WHERE col in window)` for a window. */
const inWin = (col: string, w: Win) =>
  Prisma.sql`${Prisma.raw(col)} >= ${ts(w.start)} AND ${Prisma.raw(col)} < ${ts(w.end)}`;

export interface BranchAgg {
  patientsTotal: Cnt;
  patientsNew: Cnt;
  /** status -> count of appointments starting in the window (all appointments) */
  appts: Map<string, Cnt>;
  /** status -> count of appointments whose start already passed (basis of the rates) */
  apptsPast: Map<string, Cnt>;
  billed: Cnt;
  tax: Cnt;
  collected: Cnt;
  refunded: Cnt;
  creditNotes: Cnt;
  debitNotes: Cnt;
  outstanding: number;
  aging: Map<AgingBucket, { paise: number; invoices: number }>;
}

export const emptyAgg = (): BranchAgg => ({
  patientsTotal: zeroCnt(),
  patientsNew: zeroCnt(),
  appts: new Map(),
  apptsPast: new Map(),
  billed: zeroCnt(),
  tax: zeroCnt(),
  collected: zeroCnt(),
  refunded: zeroCnt(),
  creditNotes: zeroCnt(),
  debitNotes: zeroCnt(),
  outstanding: 0,
  aging: new Map(),
});

/** Collapse a status map to plain numbers for one window (for `appointmentRates` / `byStatus`). */
export const statusCounts = (
  m: Map<string, Cnt>,
  which: "cur" | "prev",
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [s, c] of m) if (c[which] > 0) out[s] = c[which];
  return out;
};

/**
 * All per-branch aggregates of the org / branch dashboards in 5 + (optional) 4 grouped queries.
 * `withFinance = false` skips every money query (the viewer may not see money).
 */
export async function loadBranchAggregates(
  tx: Tx,
  ids: readonly string[],
  w: Wins,
  withFinance: boolean,
  tz: string,
): Promise<Map<string, BranchAgg>> {
  const out = new Map<string, BranchAgg>();
  for (const id of ids) out.set(id, emptyAgg());
  if (ids.length === 0) return out;
  const get = (b: string) => {
    const a = out.get(b);
    if (!a) throw new Error("analytics: branch outside the requested set");
    return a;
  };
  const lower = w.prev.start < w.cur.start ? w.prev.start : w.cur.start;

  // 1. patients (origin branch; merged tombstones excluded)
  const patients = await tx.$queryRaw<
    { b: string; total: bigint; newc: bigint; ptotal: bigint; pnew: bigint }[]
  >(Prisma.sql`
    SELECT p."originBranchId"::text AS b,
           count(*) FILTER (WHERE p."createdAt" < ${ts(w.cur.end)})::bigint AS total,
           count(*) FILTER (WHERE ${inWin(`p."createdAt"`, w.cur)})::bigint AS newc,
           count(*) FILTER (WHERE p."createdAt" < ${ts(w.prev.end)})::bigint AS ptotal,
           count(*) FILTER (WHERE ${inWin(`p."createdAt"`, w.prev)})::bigint AS pnew
      FROM "Patient" p
     WHERE p."mergedIntoId" IS NULL AND p."createdAt" < ${ts(w.cur.end)}
       AND ${branchIn(`p."originBranchId"`, ids)}
     GROUP BY 1`);
  for (const r of patients) {
    const a = get(r.b);
    a.patientsTotal = { cur: num(r.total), prev: num(r.ptotal) };
    a.patientsNew = { cur: num(r.newc), prev: num(r.pnew) };
  }

  // 2. appointments by branch + status, both windows, with the "start already passed" variant
  const appts = await tx.$queryRaw<
    { b: string; s: string; cur: bigint; cpast: bigint; prev: bigint; ppast: bigint }[]
  >(Prisma.sql`
    SELECT a."branchId"::text AS b, a."status"::text AS s,
           count(*) FILTER (WHERE ${inWin(`a."startsAt"`, w.cur)})::bigint AS cur,
           count(*) FILTER (WHERE ${inWin(`a."startsAt"`, w.cur)} AND a."startsAt" < now())::bigint AS cpast,
           count(*) FILTER (WHERE ${inWin(`a."startsAt"`, w.prev)})::bigint AS prev,
           count(*) FILTER (WHERE ${inWin(`a."startsAt"`, w.prev)} AND a."startsAt" < now())::bigint AS ppast
      FROM "Appointment" a
     WHERE a."startsAt" >= ${ts(lower)} AND a."startsAt" < ${ts(w.cur.end)}
       AND ${branchIn(`a."branchId"`, ids)}
     GROUP BY 1, 2`);
  for (const r of appts) {
    const a = get(r.b);
    a.appts.set(r.s, { cur: num(r.cur), prev: num(r.prev) });
    a.apptsPast.set(r.s, { cur: num(r.cpast), prev: num(r.ppast) });
  }
  if (!withFinance) return out;

  // 3. billed + tax (issued invoices by issuedAt)
  const inv = await tx.$queryRaw<
    { b: string; billed: bigint; tax: bigint; pbilled: bigint; ptax: bigint }[]
  >(Prisma.sql`
    SELECT i."branchId"::text AS b,
           coalesce(sum(i."totalPaise") FILTER (WHERE ${inWin(`i."issuedAt"`, w.cur)}), 0)::bigint AS billed,
           coalesce(sum(i."taxPaise") FILTER (WHERE ${inWin(`i."issuedAt"`, w.cur)}), 0)::bigint AS tax,
           coalesce(sum(i."totalPaise") FILTER (WHERE ${inWin(`i."issuedAt"`, w.prev)}), 0)::bigint AS pbilled,
           coalesce(sum(i."taxPaise") FILTER (WHERE ${inWin(`i."issuedAt"`, w.prev)}), 0)::bigint AS ptax
      FROM "Invoice" i
     WHERE ${ISSUED} AND i."issuedAt" >= ${ts(lower)} AND i."issuedAt" < ${ts(w.cur.end)}
       AND ${branchIn(`i."branchId"`, ids)}
     GROUP BY 1`);
  for (const r of inv) {
    const a = get(r.b);
    a.billed = { cur: num(r.billed), prev: num(r.pbilled) };
    a.tax = { cur: num(r.tax), prev: num(r.ptax) };
  }

  // 4. cash received (RECORDED payments) and money out (PROCESSED refunds)
  const pay = await tx.$queryRaw<{ b: string; cur: bigint; prev: bigint }[]>(Prisma.sql`
    SELECT p."branchId"::text AS b,
           coalesce(sum(p."amountPaise") FILTER (WHERE ${inWin(`p."receivedAt"`, w.cur)}), 0)::bigint AS cur,
           coalesce(sum(p."amountPaise") FILTER (WHERE ${inWin(`p."receivedAt"`, w.prev)}), 0)::bigint AS prev
      FROM "Payment" p
     WHERE p."status" = 'RECORDED' AND p."receivedAt" >= ${ts(lower)} AND p."receivedAt" < ${ts(w.cur.end)}
       AND ${branchIn(`p."branchId"`, ids)}
     GROUP BY 1`);
  for (const r of pay) get(r.b).collected = { cur: num(r.cur), prev: num(r.prev) };
  const ref = await tx.$queryRaw<{ b: string; cur: bigint; prev: bigint }[]>(Prisma.sql`
    SELECT r."branchId"::text AS b,
           coalesce(sum(r."amountPaise") FILTER (WHERE ${inWin(`r."processedAt"`, w.cur)}), 0)::bigint AS cur,
           coalesce(sum(r."amountPaise") FILTER (WHERE ${inWin(`r."processedAt"`, w.prev)}), 0)::bigint AS prev
      FROM "Refund" r
     WHERE r."status" = 'PROCESSED' AND r."processedAt" >= ${ts(lower)} AND r."processedAt" < ${ts(w.cur.end)}
       AND ${branchIn(`r."branchId"`, ids)}
     GROUP BY 1`);
  for (const r of ref) {
    const a = get(r.b);
    a.refunded = { cur: num(r.cur), prev: num(r.prev) };
    // collections are NET of refunds (ADR 0005 §4.2)
    a.collected = { cur: a.collected.cur - num(r.cur), prev: a.collected.prev - num(r.prev) };
  }

  // 5. credit / debit notes (shown separately, never netted into revenue)
  const adj = await tx.$queryRaw<{ b: string; k: string; cur: bigint; prev: bigint }[]>(Prisma.sql`
    SELECT j."branchId"::text AS b, j."kind"::text AS k,
           coalesce(sum(j."amountPaise") FILTER (WHERE ${inWin(`j."issuedAt"`, w.cur)}), 0)::bigint AS cur,
           coalesce(sum(j."amountPaise") FILTER (WHERE ${inWin(`j."issuedAt"`, w.prev)}), 0)::bigint AS prev
      FROM "InvoiceAdjustment" j
     WHERE j."issuedAt" >= ${ts(lower)} AND j."issuedAt" < ${ts(w.cur.end)}
       AND ${branchIn(`j."branchId"`, ids)}
     GROUP BY 1, 2`);
  for (const r of adj) {
    const a = get(r.b);
    const c = { cur: num(r.cur), prev: num(r.prev) };
    if (r.k === "CREDIT") a.creditNotes = c;
    else a.debitNotes = c;
  }

  // 6. outstanding now, with ageing (days overdue clamped to 0..91 in SQL, bucketed by the contract's `agingBucket`)
  const out6 = await tx.$queryRaw<{ b: string; d: number; paise: bigint; n: bigint }[]>(Prisma.sql`
    SELECT i."branchId"::text AS b,
           LEAST(GREATEST(((now() AT TIME ZONE ${tz})::date - coalesce(i."dueDate", (i."issuedAt" AT TIME ZONE ${tz})::date)), 0), 91)::int AS d,
           coalesce(sum(i."balancePaise"), 0)::bigint AS paise,
           count(*)::bigint AS n
      FROM "Invoice" i
     WHERE i."status" IN ('ISSUED','PARTIALLY_PAID') AND i."balancePaise" > 0
       AND ${branchIn(`i."branchId"`, ids)}
     GROUP BY 1, 2`);
  for (const r of out6) {
    const a = get(r.b);
    const bucket = agingBucket(r.d);
    const cur = a.aging.get(bucket) ?? { paise: 0, invoices: 0 };
    cur.paise += num(r.paise);
    cur.invoices += num(r.n);
    a.aging.set(bucket, cur);
    a.outstanding += num(r.paise);
  }
  return out;
}

export const agingRows = (m: Map<AgingBucket, { paise: number; invoices: number }>) =>
  OUTSTANDING_AGING_BUCKETS.map((bucket) => ({
    bucket,
    paise: m.get(bucket)?.paise ?? 0,
    invoices: m.get(bucket)?.invoices ?? 0,
  }));

// ---------------------------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------------------------

const BUCKET = (col: string, grain: AnalyticsGrain, tz: string) => {
  const local = Prisma.sql`(${Prisma.raw(col)} AT TIME ZONE ${tz})`;
  if (grain === "day") return Prisma.sql`${local}::date`;
  if (grain === "week") return Prisma.sql`date_trunc('week', ${local})::date`;
  return Prisma.sql`date_trunc('month', ${local})::date`;
};

const APPT_STATUS: Partial<Record<TrendMetric, string>> = {
  completed_visits: "COMPLETED",
  cancellations: "CANCELLED",
  no_shows: "NO_SHOW",
};

/** bucket start ("YYYY-MM-DD") -> value, for one window. Empty buckets are filled by the caller. */
export async function trendSeries(
  tx: Tx,
  metric: TrendMetric,
  ids: readonly string[],
  w: Win,
  grain: AnalyticsGrain,
  tz: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const add = (k: string, v: number) => out.set(k, (out.get(k) ?? 0) + v);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (ids.length === 0) return out;

  if (metric === "appointments" || APPT_STATUS[metric]) {
    const status = APPT_STATUS[metric];
    const rows = await tx.$queryRaw<{ k: Date; v: bigint }[]>(Prisma.sql`
      SELECT ${BUCKET(`a."startsAt"`, grain, tz)} AS k, count(*)::bigint AS v
        FROM "Appointment" a
       WHERE ${inWin(`a."startsAt"`, w)}
         ${status ? Prisma.sql`AND a."status" = ${status}::"AppointmentStatus"` : Prisma.empty}
         AND ${branchIn(`a."branchId"`, ids)}
       GROUP BY 1`);
    for (const r of rows) add(iso(r.k), num(r.v));
  } else if (metric === "new_patients") {
    const rows = await tx.$queryRaw<{ k: Date; v: bigint }[]>(Prisma.sql`
      SELECT ${BUCKET(`p."createdAt"`, grain, tz)} AS k, count(*)::bigint AS v
        FROM "Patient" p
       WHERE p."mergedIntoId" IS NULL AND ${inWin(`p."createdAt"`, w)}
         AND ${branchIn(`p."originBranchId"`, ids)}
       GROUP BY 1`);
    for (const r of rows) add(iso(r.k), num(r.v));
  } else if (metric === "billed") {
    const rows = await tx.$queryRaw<{ k: Date; v: bigint }[]>(Prisma.sql`
      SELECT ${BUCKET(`i."issuedAt"`, grain, tz)} AS k, coalesce(sum(i."totalPaise"), 0)::bigint AS v
        FROM "Invoice" i
       WHERE ${ISSUED} AND ${inWin(`i."issuedAt"`, w)}
         AND ${branchIn(`i."branchId"`, ids)}
       GROUP BY 1`);
    for (const r of rows) add(iso(r.k), num(r.v));
  } else {
    // collections = payments received − refunds processed, per bucket
    const pay = await tx.$queryRaw<{ k: Date; v: bigint }[]>(Prisma.sql`
      SELECT ${BUCKET(`p."receivedAt"`, grain, tz)} AS k, coalesce(sum(p."amountPaise"), 0)::bigint AS v
        FROM "Payment" p
       WHERE p."status" = 'RECORDED' AND ${inWin(`p."receivedAt"`, w)}
         AND ${branchIn(`p."branchId"`, ids)}
       GROUP BY 1`);
    for (const r of pay) add(iso(r.k), num(r.v));
    const ref = await tx.$queryRaw<{ k: Date; v: bigint }[]>(Prisma.sql`
      SELECT ${BUCKET(`r."processedAt"`, grain, tz)} AS k, coalesce(sum(r."amountPaise"), 0)::bigint AS v
        FROM "Refund" r
       WHERE r."status" = 'PROCESSED' AND ${inWin(`r."processedAt"`, w)}
         AND ${branchIn(`r."branchId"`, ids)}
       GROUP BY 1`);
    for (const r of ref) add(iso(r.k), -num(r.v));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Dentist performance
// ---------------------------------------------------------------------------------------------

export interface DentistAggRow {
  dentistUserId: string;
  name: string | null;
  scheduled: number;
  completed: number;
  patientsSeen: number;
  noShows: number;
  cancellations: number;
  resolved: number;
  cancelledPast: number;
  noShowPast: number;
  completedPast: number;
  billedPaise: number;
}

export const DENTIST_ORDER: Record<string, string> = {
  completedVisits: "completed",
  billedPaise: "billed",
  patientsSeen: "seen",
  noShows: "noshows",
  name: "name",
};

/**
 * One row per dentist: appointment counts (Appointment.dentistUserId) FULL JOIN billed (InvoiceLine.dentistUserId, the
 * originating dentist). Sorted and paged in SQL (`limit + 1` rows come back; the caller derives `nextCursor`).
 */
export async function dentistRows(
  tx: Tx,
  ids: readonly string[],
  w: Win,
  opts: {
    dentistUserId?: string;
    withFinance: boolean;
    sort: keyof typeof DENTIST_ORDER;
    order: "asc" | "desc";
    offset: number;
    limit: number;
  },
): Promise<DentistAggRow[]> {
  if (ids.length === 0) return [];
  const only = (col: string) =>
    opts.dentistUserId ? Prisma.sql`AND ${Prisma.raw(col)} = ${opts.dentistUserId}` : Prisma.empty;
  const sortCol = DENTIST_ORDER[opts.sort] ?? "completed";
  const dir = opts.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const rows = await tx.$queryRaw<
    {
      d: string;
      name: string | null;
      scheduled: bigint;
      completed: bigint;
      seen: bigint;
      noshows: bigint;
      cancels: bigint;
      resolved: bigint;
      cancelpast: bigint;
      noshowpast: bigint;
      completedpast: bigint;
      billed: bigint;
    }[]
  >(Prisma.sql`
    WITH appt AS (
      SELECT a."dentistUserId" AS d,
             count(*) FILTER (WHERE a."status" <> 'RESCHEDULED')::bigint AS scheduled,
             count(*) FILTER (WHERE a."status" = 'COMPLETED')::bigint AS completed,
             count(DISTINCT a."patientId") FILTER (WHERE a."status" = 'COMPLETED')::bigint AS seen,
             count(*) FILTER (WHERE a."status" = 'NO_SHOW')::bigint AS noshows,
             count(*) FILTER (WHERE a."status" = 'CANCELLED')::bigint AS cancels,
             count(*) FILTER (WHERE a."status" <> 'RESCHEDULED' AND a."startsAt" < now())::bigint AS resolved,
             count(*) FILTER (WHERE a."status" = 'CANCELLED' AND a."startsAt" < now())::bigint AS cancelpast,
             count(*) FILTER (WHERE a."status" = 'NO_SHOW' AND a."startsAt" < now())::bigint AS noshowpast,
             count(*) FILTER (WHERE a."status" = 'COMPLETED' AND a."startsAt" < now())::bigint AS completedpast
        FROM "Appointment" a
       WHERE a."dentistUserId" IS NOT NULL AND ${inWin(`a."startsAt"`, w)}
         AND ${branchIn(`a."branchId"`, ids)} ${only(`a."dentistUserId"`)}
       GROUP BY 1
    ), billed AS (
      ${
        opts.withFinance
          ? Prisma.sql`SELECT l."dentistUserId" AS d, coalesce(sum(l."totalPaise"), 0)::bigint AS billed
        FROM "InvoiceLine" l
        JOIN "Invoice" i ON i."tenantId" = l."tenantId" AND i."id" = l."invoiceId"
       WHERE l."dentistUserId" IS NOT NULL AND ${ISSUED} AND ${inWin(`i."issuedAt"`, w)}
         AND ${branchIn(`i."branchId"`, ids)} ${only(`l."dentistUserId"`)}
       GROUP BY 1`
          : Prisma.sql`SELECT NULL::text AS d, 0::bigint AS billed WHERE FALSE`
      }
    )
    SELECT coalesce(appt.d, billed.d) AS d,
           m."displayName" AS name,
           coalesce(appt.scheduled, 0)::bigint AS scheduled,
           coalesce(appt.completed, 0)::bigint AS completed,
           coalesce(appt.seen, 0)::bigint AS seen,
           coalesce(appt.noshows, 0)::bigint AS noshows,
           coalesce(appt.cancels, 0)::bigint AS cancels,
           coalesce(appt.resolved, 0)::bigint AS resolved,
           coalesce(appt.cancelpast, 0)::bigint AS cancelpast,
           coalesce(appt.noshowpast, 0)::bigint AS noshowpast,
           coalesce(appt.completedpast, 0)::bigint AS completedpast,
           coalesce(billed.billed, 0)::bigint AS billed
      FROM appt
      FULL OUTER JOIN billed ON billed.d = appt.d
      LEFT JOIN "Membership" m ON m."tenantId" = app_tenant_id() AND m."userId" = coalesce(appt.d, billed.d)
     ORDER BY ${Prisma.raw(sortCol === "name" ? `lower(coalesce(m."displayName", coalesce(appt.d, billed.d)))` : sortCol)} ${dir},
              coalesce(appt.d, billed.d) ASC
     OFFSET ${opts.offset} LIMIT ${opts.limit + 1}`);
  return rows.map((r) => ({
    dentistUserId: r.d,
    name: r.name,
    scheduled: num(r.scheduled),
    completed: num(r.completed),
    patientsSeen: num(r.seen),
    noShows: num(r.noshows),
    cancellations: num(r.cancels),
    resolved: num(r.resolved),
    cancelledPast: num(r.cancelpast),
    noShowPast: num(r.noshowpast),
    completedPast: num(r.completedpast),
    billedPaise: num(r.billed),
  }));
}
