import {
  type AnalyticsSnapshotQuery,
  type BranchDashboardQuery,
  type DentistPerformanceQuery,
  type OrgDashboardQuery,
  type TrendsQuery,
  analyticsSnapshotQuery,
  branchDashboardQuery,
  dentistPerformanceQuery,
  orgDashboardQuery,
  trendsQuery,
} from "@dentalos/validation";
import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { AnalyticsService } from "./analytics.service";

/**
 * Staff analytics (PRD 4.9, ADR 0005 §4). Capability via @Can where one permission fits; the service enforces the
 * resource scope (branch outside the caller's scope = 403) and masks money without `finance:report`.
 * `GET /analytics/dentists` and `GET /analytics/trends` have no single capability (branch holders, dentists on self
 * scope; org vs branch trends), so the service decides.
 */
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Can("analytics:org")
  @Get("org")
  org(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(orgDashboardQuery)) q: OrgDashboardQuery,
  ) {
    return this.analytics.orgDashboard(p, q);
  }

  @Can("analytics:branch")
  @Get("branches/:branchId")
  branch(
    @CurrentPrincipal() p: Principal,
    @Param("branchId", new ParseUUIDPipe()) branchId: string,
    @Query(new ZodPipe(branchDashboardQuery)) q: BranchDashboardQuery,
  ) {
    return this.analytics.branchDashboard(p, branchId, q);
  }

  @Get("dentists")
  dentists(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(dentistPerformanceQuery)) q: DentistPerformanceQuery,
  ) {
    return this.analytics.dentists(p, q);
  }

  @Get("trends")
  trends(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(trendsQuery)) q: TrendsQuery) {
    return this.analytics.trends(p, q);
  }

  @Can("analytics:branch")
  @Get("snapshots")
  snapshots(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(analyticsSnapshotQuery)) q: AnalyticsSnapshotQuery,
  ) {
    return this.analytics.snapshots(p, q);
  }
}
