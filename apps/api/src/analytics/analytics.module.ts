import { Module } from "@nestjs/common";
import { AnalyticsCache } from "./analytics-cache";
import { AnalyticsQueryService } from "./analytics-query.service";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";

/**
 * M4 Analytics and dashboards (PRD 4.9, ADR 0005 §4). Staff routes under `/analytics`: org dashboard + branch
 * comparison (`analytics:org`), branch dashboard / snapshots (`analytics:branch` at the branch), trends, dentist
 * performance (`analytics:branch`, or `analytics:self` for a dentist's own numbers). Every figure is a SQL aggregation
 * inside `withTenant` (RLS) intersected with the caller's branch scope; money is `null` without `finance:report`;
 * results are cached in memory per tenant + scope + params (TTL only).
 *
 * `AnalyticsQueryService` (the fixed NL-analytics catalogue behind one in-process `run()`) is EXPORTED so the AI module
 * can inject it; this is the single cross-module import permitted for AI (see docs/M4-portal-analytics-ai.md).
 * The daily snapshot job lives in apps/worker/src/handlers/analytics.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsCache, AnalyticsService, AnalyticsQueryService],
  exports: [AnalyticsQueryService],
})
export class AnalyticsModule {}
