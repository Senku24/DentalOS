import type { HandlerRegistrar } from "../index";
import { registerSnapshotHandler } from "./snapshot";
import { registerSweep } from "./sweep";

/**
 * M4 analytics handlers (ADR 0005 §4.5). Queues: `ANALYTICS_QUEUES` in @dentalos/validation.
 *   analytics.snapshot-sweep  per-tenant: finds branch-days (yesterday + 2 earlier) without a snapshot and enqueues
 *   analytics.daily-snapshot  per branch + local day: computes `branchDailyMetrics`, upserts `AnalyticsSnapshot`
 *                             (idempotent), then queues `ai.daily-summary` for the row
 *   analytics.sweep-tick      cron (ANALYTICS_SNAPSHOT_CRON, default `10 * * * *`): one sweep job per tenant
 * Env: ANALYTICS_SCAN_TENANTS (comma-separated tenant ids; limits / replaces the tenant list), ANALYTICS_SNAPSHOT_CRON.
 */
export const registerAnalyticsHandlers: HandlerRegistrar = async (ctx) => {
  await registerSnapshotHandler(ctx);
  await registerSweep(ctx);
};
