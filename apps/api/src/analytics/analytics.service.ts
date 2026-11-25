import { hasPermission } from "@dentalos/contracts";
import { PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  ANALYTICS_CACHE_TTL_SECONDS,
  APPOINTMENT_STATUSES,
  type AnalyticsGrain,
  type AnalyticsPeriod,
  type AnalyticsSnapshotQuery,
  type AnalyticsSnapshotResponse,
  type BranchDashboardQuery,
  type BranchDashboardResponse,
  type DentistPerformanceQuery,
  type DentistPerformanceResponse,
  FINANCIAL_TREND_METRICS,
  type FinanceSummary,
  type KpiResponse,
  MAX_TREND_BUCKETS,
  type OrgDashboardQuery,
  type OrgDashboardResponse,
  type TrendMetric,
  type TrendsQuery,
  type TrendsResponse,
  appointmentRates,
  branchDailyMetrics,
  defaultGrain,
  enumerateBuckets,
  kpi,
  previousPeriod,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, can } from "../auth/roles";
import { assertCan, branchWhere } from "../common/principal";
import { AnalyticsCache } from "./analytics-cache";
import {
  badRequest,
  cacheKey,
  dateOnlyToDate,
  dateToDateOnly,
  decodeOffset,
  encodeOffset,
  financeVisibleFor,
  forbidden,
  intersect,
  notFound,
  periodFor,
  periodResponse,
  tenantZone,
  validZone,
} from "./analytics-common";
import {
  type LiveBranch,
  dayWindow,
  dentistAvailability,
  todayFinance,
  todaySchedule,
  waitingQueue,
} from "./analytics-live";
import {
  type BranchAgg,
  type Cnt,
  type Wins,
  agingRows,
  dentistRows,
  emptyAgg,
  loadBranchAggregates,
  statusCounts,
  trendSeries,
} from "./analytics-sql";

const TTL = ANALYTICS_CACHE_TTL_SECONDS;
const DEFAULT_ZONE_FALLBACK = "Asia/Kolkata";

export interface BranchRef extends LiveBranch {
  name: string;
}

// ---------------------------------------------------------------------------------------------
// Pure assembly helpers
// ---------------------------------------------------------------------------------------------

const addCnt = (a: Cnt, b: Cnt): Cnt => ({ cur: a.cur + b.cur, prev: a.prev + b.prev });
const mergeMaps = (target: Map<string, Cnt>, from: Map<string, Cnt>) => {
  for (const [k, v] of from) target.set(k, addCnt(target.get(k) ?? { cur: 0, prev: 0 }, v));
};
const sumStatuses = (m: Map<string, Cnt>): Cnt =>
  [...m.values()].reduce(addCnt, { cur: 0, prev: 0 });

/** Sums per-branch aggregate rows (a handful of already-aggregated SQL rows) into one organisation-level row. */
export function combine(list: Iterable<BranchAgg>): BranchAgg {
  const t = emptyAgg();
  for (const a of list) {
    t.patientsTotal = addCnt(t.patientsTotal, a.patientsTotal);
    t.patientsNew = addCnt(t.patientsNew, a.patientsNew);
    mergeMaps(t.appts, a.appts);
    mergeMaps(t.apptsPast, a.apptsPast);
    t.billed = addCnt(t.billed, a.billed);
    t.tax = addCnt(t.tax, a.tax);
    t.collected = addCnt(t.collected, a.collected);
    t.refunded = addCnt(t.refunded, a.refunded);
    t.creditNotes = addCnt(t.creditNotes, a.creditNotes);
    t.debitNotes = addCnt(t.debitNotes, a.debitNotes);
    t.outstanding += a.outstanding;
    for (const [b, v] of a.aging) {
      const c = t.aging.get(b) ?? { paise: 0, invoices: 0 };
      c.paise += v.paise;
      c.invoices += v.invoices;
      t.aging.set(b, c);
    }
  }
  return t;
}

const byStatusFull = (m: Map<string, Cnt>, which: "cur" | "prev") => {
  const c = statusCounts(m, which);
  return Object.fromEntries(APPOINTMENT_STATUSES.map((s) => [s, c[s] ?? 0]));
};

export function apptSummary(a: BranchAgg, compare: boolean) {
  const k = (c: Cnt): KpiResponse => kpi(c.cur, compare ? c.prev : null);
  const rc = appointmentRates(statusCounts(a.apptsPast, "cur"));
  const rp = appointmentRates(statusCounts(a.apptsPast, "prev"));
  const completed = a.appts.get("COMPLETED") ?? { cur: 0, prev: 0 };
  return {
    byStatus: byStatusFull(a.appts, "cur"),
    total: k(sumStatuses(a.appts)),
    completedVisits: k(completed),
    newPatients: k(a.patientsNew),
    totalPatients: k(a.patientsTotal),
    cancellationRateBp: kpi(rc.cancellationRateBp, compare ? rp.cancellationRateBp : null),
    noShowRateBp: kpi(rc.noShowRateBp, compare ? rp.noShowRateBp : null),
    rates: rc,
  };
}

export function financeSummary(a: BranchAgg, compare: boolean): FinanceSummary {
  const k = (c: Cnt): KpiResponse => kpi(c.cur, compare ? c.prev : null);
  const revenue: Cnt = { cur: a.billed.cur - a.tax.cur, prev: a.billed.prev - a.tax.prev };
  const collected: Cnt = a.collected; // already net of refunds
  return {
    billedPaise: k(a.billed),
    taxPaise: k(a.tax),
    revenuePaise: k(revenue),
    creditNotesPaise: k(a.creditNotes),
    debitNotesPaise: k(a.debitNotes),
    collectedPaise: k(collected),
    refundedPaise: k(a.refunded),
    outstandingPaise: a.outstanding,
    outstandingByAging: agingRows(a.aging),
  };
}

const winsOf = (cur: AnalyticsPeriod): Wins => {
  const prev = previousPeriod(cur);
  return {
    cur: { start: cur.start, end: cur.end },
    prev: { start: prev.start, end: prev.end },
  };
};

const fill = (map: Map<string, number>, from: string, to: string, grain: AnalyticsGrain) =>
  enumerateBuckets(from, to, grain).map((bucket) => ({ bucket, value: map.get(bucket) ?? 0 }));

const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (d * 2));

/** Fresh payload meta. */
const meta = () => ({ generatedAt: new Date().toISOString(), cached: false });

export interface TrendInput {
  metric: TrendMetric;
  period?: TrendsQuery["period"];
  from?: string;
  to?: string;
  grain?: AnalyticsGrain;
  compare: boolean;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly cache: AnalyticsCache,
  ) {}

  /** One short tenant transaction (RLS + actor). Reads only. */
  read<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId });
  }

  // -------------------------------------------------------------------------------------------
  // Scope helpers (also used by AnalyticsQueryService)
  // -------------------------------------------------------------------------------------------

  /** Branches the caller may see (tenant branches ∩ scope), with what the live views need. */
  async visibleBranches(tx: Tx, p: Principal): Promise<BranchRef[]> {
    const rows = await tx.branch.findMany({
      where: { AND: [branchWhere(p, "id")] },
      select: { id: true, name: true, timezone: true, workingHours: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return rows.map((b) => ({
      ...b,
      timezone: validZone(b.timezone) ? b.timezone : DEFAULT_ZONE_FALLBACK,
    }));
  }

  /** One branch inside the caller's scope. 403 (never 404) is thrown before this by `assertCan`. */
  async scopedBranch(tx: Tx, p: Principal, branchId: string): Promise<BranchRef> {
    assertCan(p, "analytics:branch", { branchId });
    const all = await this.visibleBranches(tx, p);
    const b = all.find((x) => x.id === branchId);
    if (!b) throw notFound("branch_not_found");
    return b;
  }

  // -------------------------------------------------------------------------------------------
  // Org dashboard
  // -------------------------------------------------------------------------------------------

  orgDashboard(p: Principal, q: OrgDashboardQuery): Promise<OrgDashboardResponse> {
    assertCan(p, "analytics:org");
    const fv = can(p, "finance:report");
    const key = cacheKey(p, "org_overview", fv, {
      period: q.period,
      from: q.from,
      to: q.to,
      branchIds: q.branchIds ? [...q.branchIds].sort() : undefined,
      compare: q.compare,
    });
    return this.cache.wrap(p.tenantId, key, TTL.period, () =>
      this.read(p, async (tx) => {
        const tz = await tenantZone(tx);
        const cur = periodFor(q, tz);
        const prev = previousPeriod(cur);
        const branches = await this.visibleBranches(tx, p);
        const ids = q.branchIds
          ? intersect(
              branches.map((b) => b.id),
              q.branchIds,
            )
          : branches.map((b) => b.id);
        const aggs = await loadBranchAggregates(tx, ids, winsOf(cur), fv, tz);
        const total = combine(aggs.values());
        const s = apptSummary(total, q.compare);
        const rows = branches
          .filter((b) => aggs.has(b.id))
          .map((b) => {
            const a = aggs.get(b.id) ?? emptyAgg();
            const r = apptSummary(a, false);
            return {
              branchId: b.id,
              name: b.name,
              appointments: r.total.value ?? 0,
              completedVisits: r.completedVisits.value ?? 0,
              newPatients: r.newPatients.value ?? 0,
              cancellationRateBp: r.cancellationRateBp.value,
              noShowRateBp: r.noShowRateBp.value,
              billedPaise: fv ? a.billed.cur : null,
              collectedPaise: fv ? a.collected.cur : null,
              outstandingPaise: fv ? a.outstanding : null,
            };
          });
        return {
          period: periodResponse(cur),
          previousPeriod: q.compare ? periodResponse(prev) : null,
          branchIds: ids,
          patients: { total: s.totalPatients, new: s.newPatients },
          appointments: {
            total: s.total,
            byStatus: s.byStatus,
            completedVisits: s.completedVisits,
            cancellationRateBp: s.cancellationRateBp,
            noShowRateBp: s.noShowRateBp,
          },
          financeVisible: fv,
          finance: fv ? financeSummary(total, q.compare) : null,
          branches: rows,
          ...meta(),
        };
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Branch dashboard
  // -------------------------------------------------------------------------------------------

  branchDashboard(
    p: Principal,
    branchId: string,
    q: BranchDashboardQuery,
  ): Promise<BranchDashboardResponse> {
    assertCan(p, "analytics:branch", { branchId });
    const fv = can(p, "finance:report", { branchId });
    const key = cacheKey(p, "branch_overview", fv, {
      branchId,
      period: q.period,
      from: q.from,
      to: q.to,
      compare: q.compare,
    });
    return this.cache.wrap(p.tenantId, key, TTL.live, () =>
      this.read(p, async (tx) => {
        const b = await this.scopedBranch(tx, p, branchId);
        const now = new Date();
        const cur = periodFor(q, b.timezone, now);
        const prev = previousPeriod(cur);
        const w = dayWindow(b.timezone, now);
        const aggs = await loadBranchAggregates(tx, [b.id], winsOf(cur), fv, b.timezone);
        const a = aggs.get(b.id) ?? emptyAgg();
        const s = apptSummary(a, q.compare);
        const [today, waiting, availability, tf] = await Promise.all([
          todaySchedule(tx, b, w, now),
          waitingQueue(tx, b, w, now),
          dentistAvailability(tx, b, w, now),
          fv ? todayFinance(tx, b, w) : Promise.resolve(null),
        ]);
        return {
          branchId: b.id,
          branchName: b.name,
          timeZone: b.timezone,
          day: w.day,
          period: periodResponse(cur),
          previousPeriod: q.compare ? periodResponse(prev) : null,
          today,
          waiting,
          dentistAvailability: availability,
          financeVisible: fv,
          todayFinance: tf,
          periodSummary: {
            appointments: s.total,
            completedVisits: s.completedVisits,
            newPatients: s.newPatients,
            cancellationRateBp: s.cancellationRateBp,
            noShowRateBp: s.noShowRateBp,
          },
          finance: fv ? financeSummary(a, q.compare) : null,
          ...meta(),
        };
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Trends
  // -------------------------------------------------------------------------------------------

  /** Series for a branch set (the set was already authorised by the caller). */
  async trendCore(
    tx: Tx,
    metric: TrendMetric,
    ids: readonly string[],
    tz: string,
    q: Omit<TrendInput, "metric">,
    fv: boolean,
  ): Promise<TrendsResponse> {
    const cur = periodFor(q, tz);
    const grain = q.grain ?? defaultGrain(cur.days);
    if (enumerateBuckets(cur.from, cur.to, grain).length > MAX_TREND_BUCKETS)
      throw badRequest("too_many_buckets", { max: MAX_TREND_BUCKETS });
    const financial = FINANCIAL_TREND_METRICS.includes(metric);
    if (financial && !fv) {
      return {
        metric,
        grain,
        period: periodResponse(cur),
        series: [],
        previousSeries: null,
        financeVisible: false,
        ...meta(),
      };
    }
    const series = await trendSeries(tx, metric, ids, cur, grain, tz);
    let previousSeries: { bucket: string; value: number }[] | null = null;
    if (q.compare) {
      const prev = previousPeriod(cur);
      previousSeries = fill(
        await trendSeries(tx, metric, ids, prev, grain, tz),
        prev.from,
        prev.to,
        grain,
      );
    }
    return {
      metric,
      grain,
      period: periodResponse(cur),
      series: fill(series, cur.from, cur.to, grain),
      previousSeries,
      financeVisible: fv || !financial,
      ...meta(),
    };
  }

  trends(p: Principal, q: TrendsQuery): Promise<TrendsResponse> {
    if (q.branchId) assertCan(p, "analytics:branch", { branchId: q.branchId });
    else assertCan(p, "analytics:org");
    const fv = q.branchId
      ? can(p, "finance:report", { branchId: q.branchId })
      : can(p, "finance:report");
    const key = cacheKey(p, "trends", fv, { ...q });
    return this.cache.wrap(p.tenantId, key, TTL.period, () =>
      this.read(p, async (tx) => {
        if (q.branchId) {
          const b = await this.scopedBranch(tx, p, q.branchId);
          return this.trendCore(tx, q.metric, [b.id], b.timezone, q, fv);
        }
        const tz = await tenantZone(tx);
        const ids = (await this.visibleBranches(tx, p)).map((b) => b.id);
        return this.trendCore(tx, q.metric, ids, tz, q, fv);
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Dentist performance (branch scope, or self scope for dentists)
  // -------------------------------------------------------------------------------------------

  /** Resolves which dentist filter and which branches the caller may see. Throws 403 when neither capability fits. */
  dentistAccess(p: Principal, q: { branchId?: string; dentistUserId?: string }) {
    const hasBranch = hasPermission(p.roles, "analytics:branch");
    const hasSelf = hasPermission(p.roles, "analytics:self");
    if (!hasBranch && !hasSelf) throw forbidden();
    if (q.branchId) {
      if (hasBranch) assertCan(p, "analytics:branch", { branchId: q.branchId });
      else if (!p.orgWide && !p.branchScope.includes(q.branchId)) throw forbidden();
    }
    let dentistUserId = q.dentistUserId;
    if (!hasBranch) {
      // dentist self scope: own numbers only (org-wide holders may look at anyone)
      dentistUserId = q.dentistUserId ?? p.userId;
      assertCan(p, "analytics:self", { ownerUserId: dentistUserId });
    }
    return { dentistUserId };
  }

  dentists(p: Principal, q: DentistPerformanceQuery): Promise<DentistPerformanceResponse> {
    const { dentistUserId } = this.dentistAccess(p, q);
    const offset = decodeOffset(q.cursor);
    const fvCap = hasPermission(p.roles, "finance:report");
    const key = cacheKey(p, "dentist_performance", fvCap, {
      period: q.period,
      from: q.from,
      to: q.to,
      branchId: q.branchId,
      dentistUserId,
      sort: q.sort,
      order: q.order,
      offset,
      limit: q.limit,
    });
    return this.cache.wrap(p.tenantId, key, TTL.period, () =>
      this.read(p, async (tx) => {
        const all = await this.visibleBranches(tx, p);
        let tz = await tenantZone(tx);
        let ids = all.map((b) => b.id);
        if (q.branchId) {
          const b = all.find((x) => x.id === q.branchId);
          if (!b) throw notFound("branch_not_found");
          ids = [b.id];
          tz = b.timezone;
        }
        const fv = fvCap && financeVisibleFor(p, ids);
        const cur = periodFor(q, tz);
        const sort = !fv && q.sort === "billedPaise" ? "completedVisits" : q.sort;
        const rows = await dentistRows(
          tx,
          ids,
          { start: cur.start, end: cur.end },
          {
            dentistUserId,
            withFinance: fv,
            sort,
            order: q.order,
            offset,
            limit: q.limit,
          },
        );
        const page = rows.slice(0, q.limit);
        return {
          period: periodResponse(cur),
          financeVisible: fv,
          items: page.map((r) => {
            const rates = appointmentRates({
              CANCELLED: r.cancelledPast,
              NO_SHOW: r.noShowPast,
              COMPLETED: r.completedPast,
              BOOKED: Math.max(0, r.resolved - r.cancelledPast - r.noShowPast - r.completedPast),
            });
            return {
              dentistUserId: r.dentistUserId,
              scheduled: r.scheduled,
              completedVisits: r.completed,
              patientsSeen: r.patientsSeen,
              noShows: r.noShows,
              cancellations: r.cancellations,
              noShowRateBp: rates.noShowRateBp,
              billedPaise: fv ? r.billedPaise : null,
              averagePerVisitPaise:
                fv && r.completed > 0 ? roundDiv(r.billedPaise, r.completed) : null,
            };
          }),
          nextCursor: rows.length > q.limit ? encodeOffset(offset + q.limit) : null,
          ...meta(),
        };
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots (stored daily branch summaries)
  // -------------------------------------------------------------------------------------------

  snapshots(
    p: Principal,
    q: AnalyticsSnapshotQuery,
  ): Promise<{
    items: AnalyticsSnapshotResponse[];
    nextCursor: string | null;
    generatedAt: string;
    cached: boolean;
  }> {
    assertCan(p, "analytics:branch", { branchId: q.branchId });
    const fv = can(p, "finance:report", { branchId: q.branchId });
    if (q.cursor && !/^\d{4}-\d{2}-\d{2}$/.test(q.cursor)) throw badRequest("invalid_cursor");
    const key = cacheKey(p, "snapshots", fv, { ...q });
    return this.cache.wrap(p.tenantId, key, TTL.snapshot, () =>
      this.read(p, async (tx) => {
        await this.scopedBranch(tx, p, q.branchId);
        const day: { gte?: Date; lte?: Date; lt?: Date } = {};
        if (q.from) day.gte = dateOnlyToDate(q.from);
        if (q.to) day.lte = dateOnlyToDate(q.to);
        if (q.cursor) day.lt = dateOnlyToDate(q.cursor);
        const rows = await tx.analyticsSnapshot.findMany({
          where: { branchId: q.branchId, day },
          orderBy: { day: "desc" },
          take: q.limit + 1,
        });
        const page = rows.slice(0, q.limit);
        const items = page.map((r): AnalyticsSnapshotResponse => {
          const m = branchDailyMetrics.parse(r.metrics);
          const meta2 = r.aiSummaryMeta as AnalyticsSnapshotResponse["aiSummaryMeta"];
          return {
            id: r.id,
            branchId: r.branchId,
            day: dateToDateOnly(r.day),
            metrics: {
              ...m,
              billedPaise: fv ? m.billedPaise : null,
              collectedPaise: fv ? m.collectedPaise : null,
              outstandingPaise: fv ? m.outstandingPaise : null,
            },
            // the narrative may quote money: only callers who may see money get it (ADR 0005 §4.5)
            aiSummary: fv ? r.aiSummary : null,
            aiSummaryMeta: fv && r.aiSummary ? meta2 : null,
            generatedAt: r.generatedAt.toISOString(),
          };
        });
        const last = page[page.length - 1];
        return {
          items,
          nextCursor: rows.length > q.limit && last ? dateToDateOnly(last.day) : null,
          ...meta(),
        };
      }),
    );
  }
}
