import { hasPermission } from "@dentalos/contracts";
import {
  ANALYTICS_CACHE_TTL_SECONDS,
  ANALYTICS_CATALOGUE,
  type AnalyticsCatalogueEntry,
  type AnalyticsPeriod,
  type AnalyticsQueryId,
  type AnalyticsQueryParams,
  analyticsPeriodQuery,
  analyticsQueryParams,
  kpi,
  previousPeriod,
} from "@dentalos/validation";
import { Injectable } from "@nestjs/common";
import { type Principal, can } from "../auth/roles";
import { assertCan } from "../common/principal";
import { AnalyticsCache } from "./analytics-cache";
import {
  badRequest,
  cacheKey,
  financeVisibleFor,
  forbidden,
  notFound,
  periodFor,
  periodResponse,
  tenantZone,
} from "./analytics-common";
import { dayWindow, dentistAvailability, waitingQueue } from "./analytics-live";
import { agingRows, loadBranchAggregates } from "./analytics-sql";
import { AnalyticsService, apptSummary, combine } from "./analytics.service";

/** What a catalogue query returns: the label, the analytics payload (same shapes as the dashboards' blocks) and meta. */
export interface AnalyticsQueryResult {
  queryId: AnalyticsQueryId;
  title: string;
  /** Whether money figures could be shown to this caller (a financial query is refused, not masked, without it). */
  financeVisible: boolean;
  data: unknown;
  generatedAt: string;
  cached: boolean;
}

const LIVE: readonly AnalyticsQueryId[] = [
  "branch_overview",
  "waiting_patients",
  "dentist_availability",
];

/**
 * The fixed catalogue of named, parameterised analytics queries (`ANALYTICS_CATALOGUE`, ADR 0005 §5.7) behind ONE
 * entry point for in-process callers (the AI module's natural-language analytics injects this service; there is no HTTP
 * hop and no free SQL). Every query runs through the same services, branch scoping, finance masking and cache as the
 * dashboards, so an answer can never contain more than the caller's dashboard would show.
 */
@Injectable()
export class AnalyticsQueryService {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly cache: AnalyticsCache,
  ) {}

  /** The catalogue (ids, titles, descriptions, scope, which parameters each query reads). */
  catalogue(): Readonly<Record<AnalyticsQueryId, AnalyticsCatalogueEntry>> {
    return ANALYTICS_CATALOGUE;
  }

  /** Throws 400 `unknown_query` / `invalid_query_params`, 403 (scope / `analytics_finance_forbidden`), 404 `branch_not_found`. */
  async run(p: Principal, queryId: string, rawParams: unknown = {}): Promise<AnalyticsQueryResult> {
    const entry = (ANALYTICS_CATALOGUE as Record<string, AnalyticsCatalogueEntry | undefined>)[
      queryId
    ];
    if (!entry) throw badRequest("unknown_query");
    const parsed = analyticsQueryParams.safeParse(rawParams ?? {});
    if (!parsed.success)
      throw badRequest("invalid_query_params", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    // keep only what this query reads (nothing else can influence the result or the cache key)
    const params: AnalyticsQueryParams = {};
    for (const k of entry.uses)
      if (parsed.data[k] !== undefined) Object.assign(params, { [k]: parsed.data[k] });
    const periodCheck = analyticsPeriodQuery.safeParse({
      period: params.period,
      from: params.from,
      to: params.to,
    });
    if (!periodCheck.success)
      throw badRequest("invalid_query_params", {
        issues: periodCheck.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    const period = { period: params.period, from: params.from, to: params.to };

    this.authorise(p, entry, params);
    const id = entry.id;
    const meta = (
      data: unknown,
      financeVisible: boolean,
      m: { generatedAt: string; cached: boolean },
    ) => ({
      queryId: id,
      title: entry.title,
      financeVisible,
      data,
      generatedAt: m.generatedAt,
      cached: m.cached,
    });

    // Queries that are exactly a dashboard block delegate to the dashboard service (which caches by itself).
    if (id === "org_overview") {
      const r = await this.analytics.orgDashboard(p, {
        ...period,
        branchIds: params.branchId ? [params.branchId] : undefined,
        compare: true,
      });
      return meta(r, r.financeVisible, r);
    }
    if (id === "branch_overview") {
      const r = await this.analytics.branchDashboard(p, this.singleBranch(p, params.branchId), {
        ...period,
        compare: true,
      });
      return meta(r, r.financeVisible, r);
    }
    if (id === "dentist_performance") {
      const r = await this.analytics.dentists(p, {
        ...period,
        branchId: params.branchId,
        dentistUserId: params.dentistUserId,
        sort: "completedVisits",
        order: "desc",
        limit: params.limit ?? 10,
      });
      return meta(r, r.financeVisible, r);
    }

    const single = id === "waiting_patients" || id === "dentist_availability";
    const branchId = single ? this.singleBranch(p, params.branchId) : params.branchId;
    const fvHint = entry.financial ? can(p, "finance:report") : false;
    const key = cacheKey(p, `nl:${id}`, fvHint, { ...params, branchId });
    const ttl = LIVE.includes(id)
      ? ANALYTICS_CACHE_TTL_SECONDS.live
      : ANALYTICS_CACHE_TTL_SECONDS.period;
    const result = await this.cache.wrap(p.tenantId, key, ttl, () =>
      this.analytics.read(p, async (tx) => {
        const all = await this.analytics.visibleBranches(tx, p);
        let ids = all.map((b) => b.id);
        let tz = await tenantZone(tx);
        const branch = all.find((b) => b.id === branchId);
        if (branchId) {
          if (!branch) throw notFound("branch_not_found");
          ids = [branch.id];
          tz = branch.timezone;
        }
        const fv = financeVisibleFor(p, ids);
        if (entry.financial && !fv) throw forbidden("analytics_finance_forbidden");
        const now = new Date();
        const compare = true;
        let data: unknown;
        switch (id) {
          case "appointments_by_status": {
            const cur = periodFor(period, tz, now);
            const aggs = await loadBranchAggregates(
              tx,
              ids,
              { cur: { start: cur.start, end: cur.end }, prev: prevWin(cur) },
              false,
              tz,
            );
            const s = apptSummary(combine(aggs.values()), false);
            data = {
              period: periodResponse(cur),
              branchIds: ids,
              total: s.total.value,
              byStatus: s.byStatus,
            };
            break;
          }
          case "new_patients_trend":
            data = await this.analytics.trendCore(
              tx,
              "new_patients",
              ids,
              tz,
              { ...period, grain: params.grain, compare: false },
              true,
            );
            break;
          case "revenue_trend":
            data = await this.analytics.trendCore(
              tx,
              "billed",
              ids,
              tz,
              { ...period, grain: params.grain, compare: false },
              fv,
            );
            break;
          case "collections_summary": {
            const cur = periodFor(period, tz, now);
            const aggs = await loadBranchAggregates(
              tx,
              ids,
              { cur: { start: cur.start, end: cur.end }, prev: prevWin(cur) },
              true,
              tz,
            );
            const t = combine(aggs.values());
            const trend = await this.analytics.trendCore(
              tx,
              "collections",
              ids,
              tz,
              { ...period, grain: params.grain, compare: false },
              fv,
            );
            data = {
              period: periodResponse(cur),
              previousPeriod: periodResponse(previousPeriod(cur)),
              collectedPaise: kpiOf(t.collected.cur, t.collected.prev, compare),
              refundedPaise: kpiOf(t.refunded.cur, t.refunded.prev, compare),
              grain: trend.grain,
              series: trend.series,
            };
            break;
          }
          case "outstanding_balances": {
            const cur = periodFor({}, tz, now);
            const aggs = await loadBranchAggregates(
              tx,
              ids,
              { cur: { start: cur.start, end: cur.end }, prev: prevWin(cur) },
              true,
              tz,
            );
            const t = combine(aggs.values());
            data = { outstandingPaise: t.outstanding, outstandingByAging: agingRows(t.aging) };
            break;
          }
          case "cancellation_noshow_rates": {
            const cur = periodFor(period, tz, now);
            const aggs = await loadBranchAggregates(
              tx,
              ids,
              { cur: { start: cur.start, end: cur.end }, prev: prevWin(cur) },
              false,
              tz,
            );
            const s = apptSummary(combine(aggs.values()), compare);
            data = {
              period: periodResponse(cur),
              previousPeriod: periodResponse(previousPeriod(cur)),
              resolved: s.rates.resolved,
              cancellationRateBp: s.cancellationRateBp,
              noShowRateBp: s.noShowRateBp,
            };
            break;
          }
          case "waiting_patients": {
            if (!branch) throw notFound("branch_not_found");
            data = await waitingQueue(tx, branch, dayWindow(branch.timezone, now), now);
            break;
          }
          case "dentist_availability": {
            if (!branch) throw notFound("branch_not_found");
            data = await dentistAvailability(tx, branch, dayWindow(branch.timezone, now), now);
            break;
          }
          default:
            throw badRequest("unknown_query");
        }
        return meta(data, fv, { generatedAt: now.toISOString(), cached: false });
      }),
    );
    return result;
  }

  /** Capability and scope per catalogue entry (before any data is read). */
  private authorise(
    p: Principal,
    entry: AnalyticsCatalogueEntry,
    params: AnalyticsQueryParams,
  ): void {
    if (entry.scope === "org") {
      assertCan(p, "analytics:org");
      return;
    }
    if (entry.id === "dentist_performance") {
      // branch holders and dentists (self scope) are both fine; the dashboard service enforces the exact rule
      if (!hasPermission(p.roles, "analytics:branch") && !hasPermission(p.roles, "analytics:self"))
        throw forbidden();
      return;
    }
    if (!hasPermission(p.roles, "analytics:branch")) throw forbidden();
    if (params.branchId) assertCan(p, "analytics:branch", { branchId: params.branchId });
  }

  /** A single-branch query without a branch uses the caller's only branch; otherwise the caller must choose. */
  private singleBranch(p: Principal, branchId: string | undefined): string {
    if (branchId) {
      assertCan(p, "analytics:branch", { branchId });
      return branchId;
    }
    if (!p.orgWide && p.branchScope.length === 1 && p.branchScope[0]) return p.branchScope[0];
    throw badRequest("branch_required");
  }
}

const prevWin = (cur: AnalyticsPeriod) => {
  const p = previousPeriod(cur);
  return { start: p.start, end: p.end };
};
const kpiOf = (cur: number, prev: number, compare: boolean) => kpi(cur, compare ? prev : null);
