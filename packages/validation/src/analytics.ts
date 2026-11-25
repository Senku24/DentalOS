import { z } from "zod";
import { dateOnly, isoDateTime, pageQuery, staffUserId, timeZone, uuid } from "./common";
import { APPOINTMENT_STATUSES, appointmentStatus, utcToZoned, zonedToUtc } from "./scheduling";

// Analytics and dashboards (PRD 4.9, 7.4): metric definitions, periods, DTOs, the fixed query catalogue the natural-language
// assistant may choose from, and the pure formulas. Rules: docs/adr/0005-portal-analytics-ai-rules.md §4
// (PROPOSED — needs product sign-off). Every number is computed by SQL aggregation under RLS (`withTenant`); nothing here
// reads data. Money is integer paise; rates are integer basis points (1234 = 12.34%), `null` when the denominator is 0.

// ---------------------------------------------------------------------------------------------
// Periods and grains
// ---------------------------------------------------------------------------------------------

export const ANALYTICS_PERIOD_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_week",
  "this_month",
  "last_month",
  "this_quarter",
  "this_fy",
  "custom",
] as const;
export type AnalyticsPeriodPreset = (typeof ANALYTICS_PERIOD_PRESETS)[number];
export const ANALYTICS_GRAINS = ["day", "week", "month"] as const;
export type AnalyticsGrain = (typeof ANALYTICS_GRAINS)[number];
export const MAX_ANALYTICS_RANGE_DAYS = 366;
export const DEFAULT_ANALYTICS_TIME_ZONE = "Asia/Kolkata";

export interface AnalyticsPeriod {
  preset: AnalyticsPeriodPreset;
  /** First local day, inclusive ("YYYY-MM-DD"). */
  from: string;
  /** Last local day, inclusive. */
  to: string;
  /** UTC instant of local midnight at the start of `from`. */
  start: Date;
  /** UTC instant of local midnight AFTER `to` (exclusive upper bound for SQL `< end`). */
  end: Date;
  timeZone: string;
  days: number;
}

const DAY_MS = 86_400_000;
const dayNumber = (d: string): number => {
  const [y, m, dd] = d.split("-").map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, dd ?? 1) / DAY_MS);
};
const fromDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** "2026-11-25" + 3 -> "2026-11-28" (calendar arithmetic, no time zone involved). */
export const addCalendarDays = (date: string, n: number): string =>
  fromDayNumber(dayNumber(date) + n);
/** Whole days from `a` to `b` (b - a). */
export const daysBetween = (a: string, b: string): number => dayNumber(b) - dayNumber(a);
/** 0 = Monday … 6 = Sunday. */
export const isoWeekday = (date: string): number => (((dayNumber(date) + 3) % 7) + 7) % 7;
const ymd = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: dd ?? 1 };
};
const pad2 = (n: number) => String(n).padStart(2, "0");
const monthStart = (y: number, m: number) => `${y}-${pad2(m)}-01`;

/**
 * Local-day range of a preset (all in the given time zone, so a branch in another zone gets its own midnight).
 * Weeks start Monday; quarters are calendar quarters; `this_fy` is 1 April – today (Indian financial year, same rule as
 * invoice numbering). `custom` needs `from` and `to`. `to` is inclusive; `end` is the exclusive UTC bound.
 */
export function resolvePeriod(
  input: { preset?: AnalyticsPeriodPreset; from?: string; to?: string },
  tz: string = DEFAULT_ANALYTICS_TIME_ZONE,
  now: Date = new Date(),
): AnalyticsPeriod {
  const preset = input.preset ?? (input.from && input.to ? "custom" : "last_30_days");
  const today = utcToZoned(now, tz).date;
  const { y, m } = ymd(today);
  let from: string;
  let to: string;
  switch (preset) {
    case "today":
      from = to = today;
      break;
    case "yesterday":
      from = to = addCalendarDays(today, -1);
      break;
    case "last_7_days":
      from = addCalendarDays(today, -6);
      to = today;
      break;
    case "last_30_days":
      from = addCalendarDays(today, -29);
      to = today;
      break;
    case "this_week":
      from = addCalendarDays(today, -isoWeekday(today));
      to = today;
      break;
    case "this_month":
      from = monthStart(y, m);
      to = today;
      break;
    case "last_month": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      from = monthStart(py, pm);
      to = addCalendarDays(monthStart(y, m), -1);
      break;
    }
    case "this_quarter":
      from = monthStart(y, Math.floor((m - 1) / 3) * 3 + 1);
      to = today;
      break;
    case "this_fy":
      from = monthStart(m >= 4 ? y : y - 1, 4);
      to = today;
      break;
    case "custom": {
      if (!input.from || !input.to) throw new RangeError("custom period needs from and to");
      from = input.from;
      to = input.to;
      break;
    }
  }
  if (daysBetween(from, to) < 0) throw new RangeError("period end is before its start");
  const days = daysBetween(from, to) + 1;
  if (days > MAX_ANALYTICS_RANGE_DAYS) throw new RangeError("period is longer than 366 days");
  return {
    preset,
    from,
    to,
    start: zonedToUtc(from, 0, tz),
    end: zonedToUtc(addCalendarDays(to, 1), 0, tz),
    timeZone: tz,
    days,
  };
}

/** The period of equal length immediately before `p` (for "vs previous period" deltas). */
export function previousPeriod(p: AnalyticsPeriod): AnalyticsPeriod {
  const to = addCalendarDays(p.from, -1);
  const from = addCalendarDays(to, -(p.days - 1));
  return {
    preset: "custom",
    from,
    to,
    start: zonedToUtc(from, 0, p.timeZone),
    end: zonedToUtc(addCalendarDays(to, 1), 0, p.timeZone),
    timeZone: p.timeZone,
    days: p.days,
  };
}

/** First local day of the bucket containing `date` (weeks start Monday). */
export function bucketStart(date: string, grain: AnalyticsGrain): string {
  if (grain === "day") return date;
  if (grain === "week") return addCalendarDays(date, -isoWeekday(date));
  const { y, m } = ymd(date);
  return monthStart(y, m);
}

/** Bucket start dates covering `[from, to]` in order (the first bucket may start before `from`). */
export function enumerateBuckets(from: string, to: string, grain: AnalyticsGrain): string[] {
  const out: string[] = [];
  let cur = bucketStart(from, grain);
  while (daysBetween(cur, to) >= 0) {
    out.push(cur);
    if (grain === "day") cur = addCalendarDays(cur, 1);
    else if (grain === "week") cur = addCalendarDays(cur, 7);
    else {
      const { y, m } = ymd(cur);
      cur = m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1);
    }
  }
  return out;
}

/** Trends longer than this many buckets are refused (keeps the chart and the query small). */
export const MAX_TREND_BUCKETS = 400;
/** Sensible default grain for a period length. */
export const defaultGrain = (days: number): AnalyticsGrain =>
  days <= 31 ? "day" : days <= 120 ? "week" : "month";

// ---------------------------------------------------------------------------------------------
// Formulas (pure)
// ---------------------------------------------------------------------------------------------

/** num / den as integer basis points, half up; `null` when den <= 0. rateBp(1, 3) = 3333. */
export function rateBp(num: number, den: number): number | null {
  if (den <= 0) return null;
  return Math.floor((num * 10_000 * 2 + den) / (den * 2));
}

export interface KpiDelta {
  absolute: number;
  /** Change vs the previous value in basis points (+1250 = +12.5%); null when the previous value is 0. */
  percentBp: number | null;
  direction: "up" | "down" | "flat";
}
/** Change of a metric against its previous period. */
export function trendDelta(current: number, previous: number): KpiDelta {
  const absolute = current - previous;
  const percentBp = previous === 0 ? null : Math.round((absolute * 10_000) / Math.abs(previous));
  return { absolute, percentBp, direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat" };
}

/** A KPI with its optional comparison. `null` value = not computable (e.g. a rate with no denominator). */
export function kpi(
  current: number | null,
  previous?: number | null,
): { value: number | null; previous: number | null; delta: KpiDelta | null } {
  const prev = previous ?? null;
  return {
    value: current,
    previous: prev,
    delta: current !== null && prev !== null ? trendDelta(current, prev) : null,
  };
}

/** Booked minutes / working minutes as basis points (capped at 100%); null without working time. */
export function utilisationBp(bookedMinutes: number, workingMinutes: number): number | null {
  const r = rateBp(Math.min(bookedMinutes, workingMinutes), workingMinutes);
  return r;
}

export const OUTSTANDING_AGING_BUCKETS = [
  "CURRENT",
  "D1_30",
  "D31_60",
  "D61_90",
  "D90_PLUS",
] as const;
export type AgingBucket = (typeof OUTSTANDING_AGING_BUCKETS)[number];
/** Overdue days -> bucket (<= 0 is not yet due). */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "CURRENT";
  if (daysOverdue <= 30) return "D1_30";
  if (daysOverdue <= 60) return "D31_60";
  if (daysOverdue <= 90) return "D61_90";
  return "D90_PLUS";
}

/**
 * Appointment rates (ADR 0005 §4.2). `resolved` = appointments (excluding RESCHEDULED, which a successor replaces)
 * whose start time has passed. cancellation = CANCELLED / resolved; no-show = NO_SHOW / (resolved - CANCELLED);
 * completion = COMPLETED / (resolved - CANCELLED).
 */
export function appointmentRates(byStatus: Readonly<Partial<Record<string, number>>>) {
  const n = (s: string) => byStatus[s] ?? 0;
  const resolved = APPOINTMENT_STATUSES.filter((s) => s !== "RESCHEDULED").reduce(
    (a, s) => a + n(s),
    0,
  );
  const expected = resolved - n("CANCELLED");
  return {
    resolved,
    cancellationRateBp: rateBp(n("CANCELLED"), resolved),
    noShowRateBp: rateBp(n("NO_SHOW"), expected),
    completionRateBp: rateBp(n("COMPLETED"), expected),
  };
}

// ---------------------------------------------------------------------------------------------
// Permission mapping and caching (ADR 0005 §4.6, §4.7)
// ---------------------------------------------------------------------------------------------

/**
 * Who sees what (capability; the service still intersects with the principal's branch scope):
 *  - org dashboard / cross-branch comparison / org trends: `analytics:org` (orgWide)
 *  - branch dashboard, branch trends, snapshots:           `analytics:branch` (at the branch)
 *  - one dentist's own numbers:                            `analytics:self` (own) — anyone with branch/org scope sees all
 *  - ANY money figure (billed, revenue, collections, outstanding, dentist billed): additionally `finance:report` at the
 *    branch; without it those fields are `null` (the response says `financeVisible: false`), never an error.
 */
export const ANALYTICS_PERMISSIONS = {
  org: "analytics:org",
  branch: "analytics:branch",
  self: "analytics:self",
  finance: "finance:report",
} as const;

/** Time-to-live (seconds) of the in-memory cache entries per tenant + scope. Live views stay short. */
export const ANALYTICS_CACHE_TTL_SECONDS = { live: 30, period: 300, snapshot: 3600 } as const;
/** Max entries per tenant before the oldest are evicted. */
export const ANALYTICS_CACHE_MAX_ENTRIES = 500;

/**
 * Cache key: includes everything that changes the answer — tenant, query id, the viewer's branch scope, whether money is
 * visible, and the normalised parameters — so one user's cached answer can never be served to another with a different scope.
 */
export function analyticsCacheKey(input: {
  tenantId: string;
  queryId: string;
  orgWide: boolean;
  branchScope: readonly string[];
  financeVisible: boolean;
  params: Readonly<Record<string, unknown>>;
}): string {
  const scope = input.orgWide ? "org" : `b:${[...input.branchScope].sort().join(",")}`;
  const params = Object.keys(input.params)
    .sort()
    .filter((k) => input.params[k] !== undefined)
    .map((k) => `${k}=${JSON.stringify(input.params[k])}`)
    .join("&");
  return `${input.tenantId}|${input.queryId}|${scope}|${input.financeVisible ? "f" : "-"}|${params}`;
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

const csvUuids = z
  .union([z.array(uuid), z.string()])
  .transform((v) =>
    Array.isArray(v)
      ? v
      : v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
  )
  .pipe(z.array(uuid).max(100));

const periodFields = {
  period: z.enum(ANALYTICS_PERIOD_PRESETS).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
};
const periodRefinement = (
  v: { period?: AnalyticsPeriodPreset; from?: string; to?: string },
  ctx: z.RefinementCtx,
) => {
  const custom = v.period === "custom" || (v.period === undefined && (v.from || v.to));
  if (custom) {
    if (!v.from || !v.to) {
      ctx.addIssue({ code: "custom", message: "from and to are required for a custom period" });
      return;
    }
    const d = daysBetween(v.from, v.to);
    if (d < 0) ctx.addIssue({ code: "custom", message: "to is before from", path: ["to"] });
    else if (d + 1 > MAX_ANALYTICS_RANGE_DAYS)
      ctx.addIssue({ code: "custom", message: "At most 366 days", path: ["to"] });
  } else if (v.from || v.to) {
    ctx.addIssue({ code: "custom", message: "from / to only apply to period=custom" });
  }
};

/** Period selection shared by every analytics query (default: last 30 days). */
export const analyticsPeriodQuery = z.object(periodFields).superRefine(periodRefinement);
export type AnalyticsPeriodQuery = z.infer<typeof analyticsPeriodQuery>;

/** GET /analytics/org */
export const orgDashboardQuery = z
  .object({
    ...periodFields,
    /** Limit the comparison to these branches (default: all branches the viewer may see). */
    branchIds: csvUuids.optional(),
    /** Include the previous period of equal length and the deltas. */
    compare: z.stringbool().default(true),
  })
  .superRefine(periodRefinement);
export type OrgDashboardQuery = z.infer<typeof orgDashboardQuery>;

/** GET /analytics/branches/:branchId */
export const branchDashboardQuery = z
  .object({ ...periodFields, compare: z.stringbool().default(true) })
  .superRefine(periodRefinement);
export type BranchDashboardQuery = z.infer<typeof branchDashboardQuery>;

export const DENTIST_PERFORMANCE_SORTS = [
  "completedVisits",
  "billedPaise",
  "patientsSeen",
  "noShows",
  "name",
] as const;
/** GET /analytics/dentists */
export const dentistPerformanceQuery = pageQuery
  .extend({
    ...periodFields,
    branchId: uuid.optional(),
    dentistUserId: staffUserId.optional(),
    sort: z.enum(DENTIST_PERFORMANCE_SORTS).default("completedVisits"),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .superRefine(periodRefinement);
export type DentistPerformanceQuery = z.infer<typeof dentistPerformanceQuery>;

export const TREND_METRICS = [
  "appointments",
  "completed_visits",
  "new_patients",
  "billed",
  "collections",
  "cancellations",
  "no_shows",
] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];
/** Metrics that are money (need `finance:report`). */
export const FINANCIAL_TREND_METRICS: readonly TrendMetric[] = ["billed", "collections"];

/** GET /analytics/trends */
export const trendsQuery = z
  .object({
    ...periodFields,
    metric: z.enum(TREND_METRICS),
    grain: z.enum(ANALYTICS_GRAINS).optional(),
    branchId: uuid.optional(),
    compare: z.stringbool().default(false),
  })
  .superRefine(periodRefinement);
export type TrendsQuery = z.infer<typeof trendsQuery>;

/** GET /analytics/snapshots */
export const analyticsSnapshotQuery = pageQuery.extend({
  branchId: uuid,
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type AnalyticsSnapshotQuery = z.infer<typeof analyticsSnapshotQuery>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const kpiResponse = z.object({
  value: z.number().nullable(),
  previous: z.number().nullable(),
  delta: z
    .object({
      absolute: z.number(),
      percentBp: z.number().int().nullable(),
      direction: z.enum(["up", "down", "flat"]),
    })
    .nullable(),
});
export type KpiResponse = z.infer<typeof kpiResponse>;

export const analyticsPeriodResponse = z.object({
  preset: z.enum(ANALYTICS_PERIOD_PRESETS),
  from: dateOnly,
  to: dateOnly,
  days: z.number().int(),
  timeZone,
});
export type AnalyticsPeriodResponse = z.infer<typeof analyticsPeriodResponse>;

export const appointmentsByStatus = z.record(z.string(), z.number().int());

/** Money block; every figure `null` when the viewer lacks `finance:report` (`financeVisible: false`). */
export const financeSummary = z.object({
  /** Σ totalPaise of issued (not DRAFT / VOID) invoices issued in the period, GST included. */
  billedPaise: kpiResponse,
  /** Σ taxPaise of those invoices. */
  taxPaise: kpiResponse,
  /** Revenue = billed − GST (credit / debit notes are NOT netted in; shown separately below). */
  revenuePaise: kpiResponse,
  creditNotesPaise: kpiResponse,
  debitNotesPaise: kpiResponse,
  /** Recorded payments received in the period minus processed refunds in the period. */
  collectedPaise: kpiResponse,
  refundedPaise: kpiResponse,
  /** Open balance of ISSUED / PARTIALLY_PAID invoices as of now (not period-bound). */
  outstandingPaise: z.number().int(),
  outstandingByAging: z.array(
    z.object({
      bucket: z.enum(OUTSTANDING_AGING_BUCKETS),
      paise: z.number().int(),
      invoices: z.number().int(),
    }),
  ),
});
export type FinanceSummary = z.infer<typeof financeSummary>;

export const branchComparisonRow = z.object({
  branchId: uuid,
  name: z.string(),
  appointments: z.number().int(),
  completedVisits: z.number().int(),
  newPatients: z.number().int(),
  cancellationRateBp: z.number().int().nullable(),
  noShowRateBp: z.number().int().nullable(),
  billedPaise: z.number().int().nullable(),
  collectedPaise: z.number().int().nullable(),
  outstandingPaise: z.number().int().nullable(),
});
export type BranchComparisonRow = z.infer<typeof branchComparisonRow>;

const cacheMeta = {
  generatedAt: isoDateTime,
  /** True when served from the in-memory cache (age <= TTL). */
  cached: z.boolean(),
};

export const orgDashboardResponse = z.object({
  period: analyticsPeriodResponse,
  previousPeriod: analyticsPeriodResponse.nullable(),
  branchIds: z.array(uuid),
  patients: z.object({ total: kpiResponse, new: kpiResponse }),
  appointments: z.object({
    total: kpiResponse,
    byStatus: appointmentsByStatus,
    completedVisits: kpiResponse,
    cancellationRateBp: kpiResponse,
    noShowRateBp: kpiResponse,
  }),
  financeVisible: z.boolean(),
  finance: financeSummary.nullable(),
  branches: z.array(branchComparisonRow),
  ...cacheMeta,
});
export type OrgDashboardResponse = z.infer<typeof orgDashboardResponse>;

export const waitingPatient = z.object({
  appointmentId: uuid,
  /** "Asha V." — first name + last initial; never the full record. */
  patientDisplayName: z.string(),
  checkedInAt: isoDateTime,
  waitingMinutes: z.number().int(),
  dentistUserId: z.string().nullable(),
});
export const dentistAvailabilityRow = z.object({
  dentistUserId: z.string(),
  workingMinutes: z.number().int(),
  bookedMinutes: z.number().int(),
  freeMinutes: z.number().int(),
  utilisationBp: z.number().int().nullable(),
  /** Next free moment today at or after now (ISO), null when none. */
  nextFreeAt: isoDateTime.nullable(),
  inChairNow: z.boolean(),
});
export const upcomingAppointmentRow = z.object({
  appointmentId: uuid,
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  status: appointmentStatus,
  appointmentType: z.string(),
  patientDisplayName: z.string(),
  dentistUserId: z.string().nullable(),
});
export const collectionsByMethod = z.array(
  z.object({ method: z.string(), paise: z.number().int(), payments: z.number().int() }),
);

export const branchDashboardResponse = z.object({
  branchId: uuid,
  branchName: z.string(),
  timeZone,
  /** Branch-local "today". */
  day: dateOnly,
  period: analyticsPeriodResponse,
  previousPeriod: analyticsPeriodResponse.nullable(),
  /** Today (live). */
  today: z.object({
    appointments: z.number().int(),
    byStatus: appointmentsByStatus,
    byHour: z.array(z.object({ hour: z.number().int().min(0).max(23), count: z.number().int() })),
    upcoming: z.array(upcomingAppointmentRow),
    newPatients: z.number().int(),
    completedVisits: z.number().int(),
    invoicesIssued: z.number().int(),
    plansAwaitingDecision: z.number().int(),
  }),
  waiting: z.object({ count: z.number().int(), patients: z.array(waitingPatient) }),
  dentistAvailability: z.array(dentistAvailabilityRow),
  financeVisible: z.boolean(),
  /** Today's money (null without `finance:report`). */
  todayFinance: z
    .object({
      billedPaise: z.number().int(),
      collectedPaise: z.number().int(),
      collectionsByMethod,
    })
    .nullable(),
  /** The selected period. */
  periodSummary: z.object({
    appointments: kpiResponse,
    completedVisits: kpiResponse,
    newPatients: kpiResponse,
    cancellationRateBp: kpiResponse,
    noShowRateBp: kpiResponse,
  }),
  finance: financeSummary.nullable(),
  ...cacheMeta,
});
export type BranchDashboardResponse = z.infer<typeof branchDashboardResponse>;

export const dentistPerformanceRow = z.object({
  dentistUserId: z.string(),
  scheduled: z.number().int(),
  completedVisits: z.number().int(),
  patientsSeen: z.number().int(),
  noShows: z.number().int(),
  cancellations: z.number().int(),
  noShowRateBp: z.number().int().nullable(),
  /** Σ line totals attributed to the dentist (`InvoiceLine.dentistUserId`, originating dentist, PRD 2.5). Null without finance. */
  billedPaise: z.number().int().nullable(),
  /** billed / completed visits; null without finance or visits. */
  averagePerVisitPaise: z.number().int().nullable(),
});
export type DentistPerformanceRow = z.infer<typeof dentistPerformanceRow>;
export const dentistPerformanceResponse = z.object({
  period: analyticsPeriodResponse,
  financeVisible: z.boolean(),
  items: z.array(dentistPerformanceRow),
  nextCursor: z.string().nullable(),
  ...cacheMeta,
});
export type DentistPerformanceResponse = z.infer<typeof dentistPerformanceResponse>;

export const trendPoint = z.object({ bucket: dateOnly, value: z.number() });
export const trendsResponse = z.object({
  metric: z.enum(TREND_METRICS),
  grain: z.enum(ANALYTICS_GRAINS),
  period: analyticsPeriodResponse,
  series: z.array(trendPoint),
  previousSeries: z.array(trendPoint).nullable(),
  /** Money metrics only: false = the viewer lacks finance:report and `series` is empty. */
  financeVisible: z.boolean(),
  ...cacheMeta,
});
export type TrendsResponse = z.infer<typeof trendsResponse>;

/** Stored in `AnalyticsSnapshot.metrics` (branch-local day). Money fields are always stored; reads mask them. */
export const branchDailyMetrics = z.object({
  appointments: z.object({ total: z.number().int(), byStatus: appointmentsByStatus }),
  completedVisits: z.number().int(),
  newPatients: z.number().int(),
  cancellationRateBp: z.number().int().nullable(),
  noShowRateBp: z.number().int().nullable(),
  billedPaise: z.number().int(),
  collectedPaise: z.number().int(),
  outstandingPaise: z.number().int(),
  waitingPeak: z.number().int().optional(),
});
export type BranchDailyMetrics = z.infer<typeof branchDailyMetrics>;

export const aiLabel = z.object({
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
});
export type AiLabel = z.infer<typeof aiLabel>;

export const analyticsSnapshotResponse = z.object({
  id: uuid,
  branchId: uuid,
  day: dateOnly,
  /** Money fields are `null` when the viewer lacks finance:report. */
  metrics: branchDailyMetrics.extend({
    billedPaise: z.number().int().nullable(),
    collectedPaise: z.number().int().nullable(),
    outstandingPaise: z.number().int().nullable(),
  }),
  aiSummary: z.string().nullable(),
  aiSummaryMeta: aiLabel.nullable(),
  generatedAt: isoDateTime,
});
export type AnalyticsSnapshotResponse = z.infer<typeof analyticsSnapshotResponse>;

// ---------------------------------------------------------------------------------------------
// Fixed query catalogue (the ONLY thing the natural-language assistant may pick from; no free SQL)
// ---------------------------------------------------------------------------------------------

export const ANALYTICS_QUERY_IDS = [
  "org_overview",
  "branch_overview",
  "appointments_by_status",
  "new_patients_trend",
  "revenue_trend",
  "collections_summary",
  "outstanding_balances",
  "cancellation_noshow_rates",
  "dentist_performance",
  "waiting_patients",
  "dentist_availability",
] as const;
export type AnalyticsQueryId = (typeof ANALYTICS_QUERY_IDS)[number];
export const analyticsQueryId = z.enum(ANALYTICS_QUERY_IDS);

/** The only parameters a catalogue query accepts (strict: unknown keys refused, so a model cannot smuggle filters in). */
export const analyticsQueryParams = z.strictObject({
  period: z.enum(ANALYTICS_PERIOD_PRESETS).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  grain: z.enum(ANALYTICS_GRAINS).optional(),
  branchId: uuid.optional(),
  dentistUserId: staffUserId.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type AnalyticsQueryParams = z.infer<typeof analyticsQueryParams>;

export interface AnalyticsCatalogueEntry {
  id: AnalyticsQueryId;
  title: string;
  /** Shown to the model to choose; also the human-readable label of the answer. */
  description: string;
  /** Capability needed; "org" queries also need orgWide scope. */
  scope: "org" | "branch";
  /** Money figures: needs finance:report as well (otherwise the query is refused for NL, never masked silently). */
  financial: boolean;
  /** Parameters this query reads (others are ignored). */
  uses: readonly (keyof AnalyticsQueryParams)[];
}

export const ANALYTICS_CATALOGUE: Readonly<Record<AnalyticsQueryId, AnalyticsCatalogueEntry>> = {
  org_overview: {
    id: "org_overview",
    title: "Organisation overview",
    description:
      "Patients, appointments, completed visits, cancellation and no-show rates and (if permitted) revenue and collections across all branches for a period, with branch comparison.",
    scope: "org",
    financial: false,
    uses: ["period", "from", "to"],
  },
  branch_overview: {
    id: "branch_overview",
    title: "Branch overview",
    description:
      "One branch: today's appointments, waiting patients, dentist availability and the period summary.",
    scope: "branch",
    financial: false,
    uses: ["period", "from", "to", "branchId"],
  },
  appointments_by_status: {
    id: "appointments_by_status",
    title: "Appointments by status",
    description:
      "Number of appointments per status (booked, completed, cancelled, no-show …) in a period.",
    scope: "branch",
    financial: false,
    uses: ["period", "from", "to", "branchId"],
  },
  new_patients_trend: {
    id: "new_patients_trend",
    title: "New patients over time",
    description: "New patient registrations per day, week or month.",
    scope: "branch",
    financial: false,
    uses: ["period", "from", "to", "grain", "branchId"],
  },
  revenue_trend: {
    id: "revenue_trend",
    title: "Billed amount over time",
    description: "Invoiced amount (GST included) per day, week or month.",
    scope: "branch",
    financial: true,
    uses: ["period", "from", "to", "grain", "branchId"],
  },
  collections_summary: {
    id: "collections_summary",
    title: "Collections",
    description: "Payments received minus refunds in a period, and the trend.",
    scope: "branch",
    financial: true,
    uses: ["period", "from", "to", "grain", "branchId"],
  },
  outstanding_balances: {
    id: "outstanding_balances",
    title: "Outstanding balances",
    description: "Unpaid invoice balances now, with ageing buckets.",
    scope: "branch",
    financial: true,
    uses: ["branchId"],
  },
  cancellation_noshow_rates: {
    id: "cancellation_noshow_rates",
    title: "Cancellation and no-show rates",
    description:
      "Cancellation and no-show rates for a period, with the previous period for comparison.",
    scope: "branch",
    financial: false,
    uses: ["period", "from", "to", "branchId"],
  },
  dentist_performance: {
    id: "dentist_performance",
    title: "Dentist performance",
    description:
      "Completed visits, patients seen, no-shows (and billed amount if permitted) per dentist.",
    scope: "branch",
    financial: false,
    uses: ["period", "from", "to", "branchId", "dentistUserId", "limit"],
  },
  waiting_patients: {
    id: "waiting_patients",
    title: "Waiting patients",
    description: "Patients checked in and waiting at a branch right now.",
    scope: "branch",
    financial: false,
    uses: ["branchId"],
  },
  dentist_availability: {
    id: "dentist_availability",
    title: "Dentist availability today",
    description: "Working, booked and free time per dentist today at a branch.",
    scope: "branch",
    financial: false,
    uses: ["branchId"],
  },
};

// ---------------------------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------------------------

export const ANALYTICS_QUEUES = {
  /** Per branch, shortly after local midnight: computes yesterday's `AnalyticsSnapshot` (and queues the AI summary). */
  DAILY_SNAPSHOT: "analytics.daily-snapshot",
  /** Cron fan-out: one DAILY_SNAPSHOT job per branch whose local midnight has passed. */
  SNAPSHOT_SWEEP: "analytics.snapshot-sweep",
} as const;
export type AnalyticsQueue = (typeof ANALYTICS_QUEUES)[keyof typeof ANALYTICS_QUEUES];
export const dailySnapshotJob = z.object({
  branchId: uuid,
  /** Branch-local day to summarise (default: yesterday in the branch time zone). */
  day: dateOnly.optional(),
  /** Recompute even if a snapshot already exists. */
  force: z.boolean().optional(),
});
export type DailySnapshotJob = z.infer<typeof dailySnapshotJob>;
export const snapshotSweepJob = z.object({ asOf: isoDateTime.optional() });
export type SnapshotSweepJob = z.infer<typeof snapshotSweepJob>;
