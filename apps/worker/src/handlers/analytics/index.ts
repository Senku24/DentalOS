import type { HandlerRegistrar } from "../index";

/**
 * M4 analytics handlers. Owner: A1 (apps/worker/src/handlers/analytics/**). Queues: `ANALYTICS_QUEUES` in
 * @dentalos/validation (`snapshot-sweep` cron fan-out, `daily-snapshot` per branch -> `AnalyticsSnapshot`, then queue
 * `AI_QUEUES.DAILY_SUMMARY` when the capability is enabled). Placeholder: registers nothing yet.
 */
export const registerAnalyticsHandlers: HandlerRegistrar = async () => {};
