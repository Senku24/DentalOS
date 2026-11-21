import type { PrismaClient } from "@dentalos/db";
import type { PgBoss } from "pg-boss";
import { registerNotificationHandlers } from "./notifications";

/**
 * Background-job handler registry (M3): THE single place that main.ts reads. Each module adds one line to
 * `handlerRegistrars` (a registrar calls `registerTenantJob` from `../jobs`, or the notification runner in
 * ./notifications/work.ts when it must keep network I/O out of the transaction). Handlers run inside the tenant's RLS
 * context, continue the enqueuer's trace and must be idempotent (delivery is at-least-once). Queue names and ids-only
 * payload schemas live in `@dentalos/validation` (`NOTIFICATION_QUEUES`, `sendNotificationJob`, ...).
 *
 *   N1 notifications: ./notifications      (send, reminders, receipts, plan consent, recall, cron fan-out)
 *   C1 commissions:   add `registerAccrualHandlers` here
 */
export interface HandlerContext {
  boss: PgBoss;
  prisma: PrismaClient;
}
export type HandlerRegistrar = (ctx: HandlerContext) => Promise<void>;

/** While this list is empty the worker does not start pg-boss at all. */
export const handlerRegistrars: HandlerRegistrar[] = [registerNotificationHandlers];

export async function registerHandlers(ctx: HandlerContext): Promise<void> {
  for (const register of handlerRegistrars) await register(ctx);
}
