import { uuid } from "@dentalos/validation";
import { z } from "zod";

/**
 * Query / response shapes that exist only in the inventory API (the shared contract in @dentalos/validation has no
 * "expiring batches" report). Proposed for promotion to `packages/validation/src/inventory.ts` (see the worker report).
 */
export const expiringBatchesQuery = z.object({
  branchId: uuid.optional(),
  /** Batches expiring on or before today + N days (already expired batches included). */
  withinDays: z.coerce.number().int().min(0).max(730).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ExpiringBatchesQuery = z.infer<typeof expiringBatchesQuery>;

export const expiringBatchResponse = z.object({
  branchId: uuid,
  itemId: uuid,
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  batchNo: z.string(),
  expiryDate: z.string(),
  quantity: z.number(),
  /** Negative when already expired. */
  daysToExpiry: z.number().int(),
  expired: z.boolean(),
});
export type ExpiringBatchResponse = z.infer<typeof expiringBatchResponse>;
