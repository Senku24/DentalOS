import type { HandlerRegistrar } from "../index";
import { registerDailySummaryHandler } from "./daily-summary";
import { registerDraftExpiryHandler } from "./draft-expiry";

/**
 * M4 AI handlers (ADR 0005 §5.2, §5.8). Owner: I1 (apps/worker/src/handlers/ai/**). Queues: `AI_QUEUES` in
 * @dentalos/validation — `ai.daily-summary` (narrative onto an existing AnalyticsSnapshot; the model sees numbers
 * only) and `ai.draft-expiry-sweep` (DRAFT past `expiresAt` -> EXPIRED, daily cron fan-out through `ai.sweep-tick`).
 */
export const registerAiHandlers: HandlerRegistrar = async (ctx) => {
  await registerDailySummaryHandler(ctx);
  await registerDraftExpiryHandler(ctx);
};
