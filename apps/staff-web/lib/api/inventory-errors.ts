import { ApiError, asApiError } from "./errors";

/**
 * Friendly copy for the inventory API's error codes (ADR 0004 §8, apps/api/src/inventory).
 * The frozen `errors.ts` only knows M1 codes, so the inventory client re-labels its errors here;
 * screens keep using `err.message` / `err.fieldErrors` as everywhere else.
 */

type Body = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const qty = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(n);

export const INVENTORY_ERROR_MESSAGES: Record<string, string | ((b: Body) => string)> = {
  insufficient_stock: (b) => {
    const have = num(b.available);
    const need = num(b.needed);
    const where = str(b.batchNo) ? ` in batch ${str(b.batchNo)}` : "";
    const counts =
      have !== undefined && need !== undefined
        ? ` Only ${qty(have)} available${where}, ${qty(need)} needed.`
        : "";
    return `Not enough stock.${counts} Lower the quantity, or allow overdraw on the item.`;
  },
  stock_transfer_state: "This transfer has already been received.",
  stock_item_missing: "That item has no stock record at this branch.",
  item_inactive: "That item is inactive. Re-activate it before moving stock.",
  batch_required: "This item tracks batches: enter a batch number and an expiry date.",
  transfer_same_branch: "Source and destination must be different branches.",
  item_not_found: "That item no longer exists.",
  supplier_not_found: "That supplier no longer exists.",
  supplier_inactive: "That supplier is inactive.",
  branch_not_found: "That branch no longer exists.",
  transfer_not_found: "That transfer isn't available at your branches.",
  receipt_not_found: "That receipt no longer exists.",
  procedure_record_not_found: "That procedure record id was not found.",
  procedure_branch_mismatch: "That procedure was recorded at a different branch.",
  batch_not_found: (b) =>
    `Batch ${str(b.batchNo) ?? ""} has no stock at this branch. Pick a batch from the batches list.`,
  batch_expiry_conflict: (b) =>
    `Batch ${str(b.batchNo) ?? ""} already exists with expiry ${str(b.expiryDate) ?? "a different date"}. A batch number carries one expiry date.`,
  unit_cost_required: "A unit cost is required when adding stock to an empty balance.",
  receive_exceeds_sent: (b) =>
    `Received quantity can't exceed the quantity sent${
      num(b.sent) !== undefined ? ` (${qty(num(b.sent) as number)})` : ""
    }. Record the shortfall by receiving less.`,
  sku_taken: "That SKU is already used by another item.",
  supplier_name_taken: "A supplier with that name already exists.",
  idempotency_conflict:
    "This request key was already used with different details. Close the form and start again.",
  link_mismatch: "One of the linked records doesn't belong here.",
  concurrent_edit: "Someone else changed this at the same time. Refresh and try again.",
};

export function inventoryErrorMessage(code: string | undefined, body: Body = {}) {
  if (!code) return undefined;
  const m = INVENTORY_ERROR_MESSAGES[code];
  return typeof m === "function" ? m(body) : m;
}

/** Re-labels an ApiError with inventory copy. */
export function withInventoryMessage(e: unknown): ApiError {
  const err = asApiError(e);
  const message = inventoryErrorMessage(err.code, err.body);
  if (!message) return err;
  return new ApiError({
    kind: err.kind,
    status: err.status,
    message,
    code: err.code,
    fieldErrors: err.fieldErrors,
    body: err.body,
  });
}
