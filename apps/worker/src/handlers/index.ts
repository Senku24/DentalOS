import type { PrismaClient } from "@dentalos/db";
import type { PgBoss } from "pg-boss";

/**
 * Background-job handler registry (M3). Owned by Wave 1 worker N1 (apps/worker/src/handlers/**).
 *
 * Each handler file exports a registrar that calls `registerTenantJob(boss, prisma, queue, handler, opts)` from
 * `../jobs` — so every handler runs inside the tenant's RLS context (`withTenant`), continues the enqueuer's trace
 * and gets retries with backoff (`ensureQueue`: policy "short", retryBackoff on). Queue names and ids-only payload
 * schemas live in `@dentalos/validation` (`NOTIFICATION_QUEUES`, `sendNotificationJob`, …). Handlers must be
 * idempotent: delivery is at-least-once. Add the registrar to `handlerRegistrars` below, e.g.
 *
 *   import { registerNotificationHandlers } from "./notifications";
 *   export const handlerRegistrars: HandlerRegistrar[] = [registerNotificationHandlers];
 *
 * (The worker has no @dentalos/validation dependency yet: add `"@dentalos/validation": "workspace:*"` to
 * apps/worker/package.json — a Wave 1 request to the commander — when a handler needs the shared DTOs.)
 */
export interface HandlerContext {
  boss: PgBoss;
  prisma: PrismaClient;
}
export type HandlerRegistrar = (ctx: HandlerContext) => Promise<void>;

/** Wave 1 fills this list. While it is empty the worker does not start pg-boss at all. */
export const handlerRegistrars: HandlerRegistrar[] = [];

export async function registerHandlers(ctx: HandlerContext): Promise<void> {
  for (const register of handlerRegistrars) await register(ctx);
}
