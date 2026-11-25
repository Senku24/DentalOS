import { Module } from "@nestjs/common";

/**
 * M4 Analytics and dashboards (PRD 4.9). Owner: A1 (apps/api/src/analytics/** and the snapshot job in
 * apps/worker/src/handlers/analytics*). Staff routes: `@Can("analytics:org")` (org dashboard, comparison, org trends),
 * `@Can("analytics:branch")` (branch dashboard, trends, snapshots) and `analytics:self` (own performance). Every figure is a
 * SQL aggregation inside `withTenant` (RLS) intersected with the caller's branch scope; money fields are `null` without
 * `finance:report`. Metric definitions, periods, formulas, DTOs, cache-key helper and the fixed NL query catalogue are in
 * @dentalos/validation `analytics.ts` and docs/adr/0005-portal-analytics-ai-rules.md §4 — the AI module executes catalogue
 * queries by calling an exported service of THIS module (export it), never its own SQL.
 * See docs/M4-portal-analytics-ai.md.
 */
@Module({})
export class AnalyticsModule {}
