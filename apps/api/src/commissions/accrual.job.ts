import type { Tx } from "@dentalos/db";
import { z } from "zod";
import { accrueAllocation } from "./accrual";

/**
 * pg-boss entry point for commission accrual (no Nest imports: the worker can register it as-is, or the file pair
 * `accrual.ts` + `accrual.job.ts` can move to a shared package).
 *
 *   // apps/worker/src/handlers/commissions.ts  (owned by the worker owner / commander)
 *   import { COMMISSION_ACCRUE_QUEUE, createCommissionAccrueHandler } from "<shared path>/accrual.job";
 *   export const registerCommissionHandlers: HandlerRegistrar = async ({ boss, prisma }) => {
 *     await registerTenantJob(boss, prisma, COMMISSION_ACCRUE_QUEUE, createCommissionAccrueHandler());
 *   };
 *
 * Enqueue (API, AFTER the allocation transaction committed; ids only):
 *   jobs.enqueue(COMMISSION_ACCRUE_QUEUE, { tenantId, actorId, source: "billing", idempotencyKey: `accrue:${allocationId}`,
 *                                          data: { allocationId } })
 * One job per allocation row (positive payment rows and negative refund-reversal rows alike). Delivery is
 * at-least-once; the accrual is idempotent per (allocation, invoice line).
 */
export const COMMISSION_ACCRUE_QUEUE = "commission.accrue";

export const commissionAccrueJob = z.object({ allocationId: z.string().uuid() });
export type CommissionAccrueJob = z.infer<typeof commissionAccrueJob>;

/** The part of the worker's JobEnvelope the handler reads. */
export interface CommissionAccrueEnvelope {
  tenantId: string;
  actorId: string;
  data: unknown;
}

/**
 * Returns a handler `(tx, envelope)` for `registerTenantJob`: it already runs inside the tenant's RLS context.
 * A malformed payload or an allocation that does not exist is dropped (retrying cannot help); any database error
 * throws so pg-boss retries with backoff.
 */
export function createCommissionAccrueHandler(
  onResult?: (r: Awaited<ReturnType<typeof accrueAllocation>>) => void,
) {
  return async (tx: Tx, env: CommissionAccrueEnvelope): Promise<void> => {
    const parsed = commissionAccrueJob.safeParse(env.data);
    if (!parsed.success) return;
    const r = await accrueAllocation(tx, env.tenantId, parsed.data.allocationId, env.actorId);
    onResult?.(r);
  };
}
