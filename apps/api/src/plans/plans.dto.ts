import { optionalText, uuid } from "@dentalos/validation";
import { z } from "zod";

/**
 * Local DTOs that `@dentalos/validation` does not have yet (frozen package). Proposed for promotion
 * to packages/validation/src/plans.ts — see the P1 report "Flags for Commander".
 */

/**
 * POST /plans/:id/items/reorder — EVERY item of the plan exactly once, in the desired order;
 * optional `phase` moves the item. Sequences are renumbered 1..n within each phase.
 */
export const reorderPlanItemsRequest = z.object({
  items: z
    .array(z.object({ itemId: uuid, phase: z.number().int().min(1).max(20).optional() }))
    .min(1)
    .max(200)
    .refine((d) => new Set(d.map((x) => x.itemId)).size === d.length, "Duplicate item"),
  reason: optionalText(500),
});
export type ReorderPlanItemsRequest = z.infer<typeof reorderPlanItemsRequest>;

/** Version numbers in paths (`/plans/:id/versions/:version`). */
export const versionParam = z.coerce.number().int().min(1).max(1_000_000);
