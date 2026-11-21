import { z } from "zod";
import { gstin, idempotencyKey } from "./billing";
import {
  dateOnly,
  email,
  isoDateTime,
  optionalText,
  pageQuery,
  phone,
  trimmed,
  uuid,
} from "./common";
import { type TransitionTable, canTransition } from "./state-machine";

// Inventory: items, suppliers, receipts, consumption, adjustments, transfers, balances (PRD 4.8).
// Rules: docs/adr/0004-business-operations-rules.md §8 (PROPOSED — needs product sign-off). The DB keeps
// the per-branch balance in step with the append-only stock ledger (trigger, migration 0008).

export const INVENTORY_UNITS = [
  "PIECE",
  "BOX",
  "PACK",
  "SET",
  "VIAL",
  "CARTRIDGE",
  "GRAM",
  "KILOGRAM",
  "MILLILITRE",
  "LITRE",
] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];
export const COSTING_METHODS = ["WEIGHTED_AVERAGE"] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];
export const STOCK_MOVEMENT_KINDS = [
  "RECEIPT",
  "CONSUMPTION",
  "ADJUSTMENT",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "WASTE",
] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];
export const STOCK_TRANSFER_STATUSES = ["IN_TRANSIT", "RECEIVED"] as const;
export type StockTransferStatus = (typeof STOCK_TRANSFER_STATUSES)[number];

export const inventoryUnit = z.enum(INVENTORY_UNITS);
export const stockMovementKind = z.enum(STOCK_MOVEMENT_KINDS);
export const stockTransferStatus = z.enum(STOCK_TRANSFER_STATUSES);

/** IN_TRANSIT -> RECEIVED (mirrors the stock_transfer_guard trigger). */
export const STOCK_TRANSFER_TRANSITIONS: TransitionTable<StockTransferStatus> = {
  IN_TRANSIT: ["RECEIVED"],
  RECEIVED: [],
};
export const canTransitionTransfer = (from: StockTransferStatus, to: StockTransferStatus) =>
  canTransition(STOCK_TRANSFER_TRANSITIONS, from, to);

/** Sign each movement kind must have (DB CHECK StockMovement_sign_chk). ADJUSTMENT may be either. */
export const STOCK_MOVEMENT_SIGN: Readonly<Record<StockMovementKind, 1 | -1 | 0>> = {
  RECEIPT: 1,
  TRANSFER_IN: 1,
  CONSUMPTION: -1,
  TRANSFER_OUT: -1,
  WASTE: -1,
  ADJUSTMENT: 0,
};

/** Stable error codes of the inventory API (409 unless noted). */
export const INVENTORY_ERROR_CODES = [
  "insufficient_stock",
  "stock_transfer_state",
  "stock_item_missing",
  "item_inactive",
  "batch_required",
  "transfer_same_branch",
] as const;

// ---------------------------------------------------------------------------------------------
// Quantities: numeric(14,3) in the DB — at most 3 decimals, JSON numbers on the wire.
// ---------------------------------------------------------------------------------------------

const hasMax3Decimals = (n: number) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6;
/** Positive quantity, ≤ 3 decimals (e.g. 2.5 ml). */
export const stockQuantity = z
  .number()
  .positive()
  .max(1_000_000_000)
  .refine(hasMax3Decimals, "At most 3 decimal places");
/** Signed, non-zero quantity (stock adjustments). */
export const signedStockQuantity = z
  .number()
  .min(-1_000_000_000)
  .max(1_000_000_000)
  .refine((n) => n !== 0, "Quantity must not be zero")
  .refine(hasMax3Decimals, "At most 3 decimal places");
/** Paise per unit; fractions allowed (₹0.37/ml = 37.0000 paise... stored with 4 decimals). */
export const unitCostPaise = z
  .number()
  .min(0)
  .max(1_000_000_000)
  .refine((n) => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6, "At most 4 decimal places");
const sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_.-]{1,39}$/, "2-40 chars: letters, digits, . _ or -");
const batchNo = z.string().trim().min(1).max(60);

/** Rounds to the 3-decimal stock scale (avoids 0.1 + 0.2 noise before comparing with the DB). */
export const roundQuantity = (n: number) => Math.round(n * 1000) / 1000;
/** Rounds to the 4-decimal cost scale. */
export const roundCost = (n: number) => Math.round(n * 10_000) / 10_000;

// ---------------------------------------------------------------------------------------------
// Pure helpers — mirror the stock_movement_apply trigger (the DB is the final authority)
// ---------------------------------------------------------------------------------------------

/**
 * Weighted-average cost after receiving `inQty` at `inCost`. A non-positive balance restarts the average at
 * the incoming cost (same as the trigger). Outflows never change the average.
 */
export function weightedAverageCost(
  balanceQty: number,
  avgCost: number,
  inQty: number,
  inCost: number,
): number {
  const next = balanceQty + inQty;
  if (balanceQty <= 0 || next <= 0) return roundCost(inCost);
  return roundCost((balanceQty * avgCost + inQty * inCost) / next);
}

/** Value of a balance in whole paise (quantity × weighted-average cost, half up). */
export const stockValuePaise = (quantity: number, avgUnitCostPaise: number) =>
  Math.round(quantity * avgUnitCostPaise);

/** Low stock = at or below the reorder level (and a reorder level is set). */
export const isLowStock = (quantity: number, reorderLevel: number) =>
  reorderLevel > 0 && quantity <= reorderLevel;

export interface StockBatch {
  batchNo: string | null;
  expiryDate: string | null;
  quantity: number;
}
export interface FefoPick {
  batchNo: string | null;
  expiryDate: string | null;
  quantity: number;
}
/**
 * First-expiry-first-out plan for consuming `needed` units: batches with an earlier expiry first,
 * batches without an expiry last (then by batch number for determinism); only positive batch balances.
 * `shortfall` > 0 means not enough batch stock (the DB then refuses unless the item allows overdraw).
 */
export function planFefoConsumption(
  batches: readonly StockBatch[],
  needed: number,
): { picks: FefoPick[]; shortfall: number } {
  const ordered = batches
    .filter((b) => b.quantity > 0)
    .sort((a, b) => {
      if (a.expiryDate !== b.expiryDate) {
        if (a.expiryDate === null) return 1;
        if (b.expiryDate === null) return -1;
        return a.expiryDate < b.expiryDate ? -1 : 1;
      }
      return (a.batchNo ?? "").localeCompare(b.batchNo ?? "");
    });
  let left = roundQuantity(needed);
  const picks: FefoPick[] = [];
  for (const b of ordered) {
    if (left <= 0) break;
    const take = roundQuantity(Math.min(left, b.quantity));
    picks.push({ batchNo: b.batchNo, expiryDate: b.expiryDate, quantity: take });
    left = roundQuantity(left - take);
  }
  return { picks, shortfall: left };
}

/** True when a batch expires on or before `on` ("YYYY-MM-DD"). */
export const isExpired = (expiryDate: string | null, on: string) =>
  expiryDate !== null && expiryDate <= on;

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

export const createInventoryItemRequest = z.object({
  sku,
  name: trimmed(160),
  category: optionalText(80),
  unit: inventoryUnit.default("PIECE"),
  /** Low-stock alert at or below this quantity (per branch). */
  reorderLevel: z.number().min(0).max(1_000_000_000).refine(hasMax3Decimals).default(0),
  /** Record batch number + expiry on receipts and consume first-expiry-first-out. */
  tracksBatches: z.boolean().default(false),
  /** Allow a branch balance below zero (otherwise consumption beyond stock is refused). */
  allowOverdraw: z.boolean().default(false),
});
export type CreateInventoryItemRequest = z.infer<typeof createInventoryItemRequest>;

/** PATCH: no defaults (absent keys keep stored values). SKU and unit are fixed once stock exists. */
export const updateInventoryItemRequest = z.object({
  name: trimmed(160).optional(),
  category: optionalText(80).nullable(),
  reorderLevel: z.number().min(0).max(1_000_000_000).refine(hasMax3Decimals).optional(),
  tracksBatches: z.boolean().optional(),
  allowOverdraw: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateInventoryItemRequest = z.infer<typeof updateInventoryItemRequest>;

export const listInventoryItemsQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(80).optional(),
  active: z.stringbool().optional(),
  /** When set, each item carries its balance at this branch. */
  branchId: uuid.optional(),
});
export type ListInventoryItemsQuery = z.infer<typeof listInventoryItemsQuery>;

export const inventoryItemResponse = z.object({
  id: uuid,
  sku: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  unit: inventoryUnit,
  reorderLevel: z.number(),
  costingMethod: z.enum(COSTING_METHODS),
  tracksBatches: z.boolean(),
  allowOverdraw: z.boolean(),
  active: z.boolean(),
  createdAt: isoDateTime,
  /** Only with `branchId` in the query. */
  quantity: z.number().optional(),
  avgUnitCostPaise: z.number().optional(),
  low: z.boolean().optional(),
});
export type InventoryItemResponse = z.infer<typeof inventoryItemResponse>;

// ---------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------

export const createSupplierRequest = z.object({
  name: trimmed(160),
  contactName: optionalText(120),
  phone: phone.optional(),
  email: email.optional(),
  gstin: gstin.optional(),
  address: optionalText(500),
  notes: optionalText(1000),
});
export type CreateSupplierRequest = z.infer<typeof createSupplierRequest>;
export const updateSupplierRequest = z.object({
  name: trimmed(160).optional(),
  contactName: optionalText(120).nullable(),
  phone: phone.nullable().optional(),
  email: email.nullable().optional(),
  gstin: gstin.nullable().optional(),
  address: optionalText(500).nullable(),
  notes: optionalText(1000).nullable(),
  active: z.boolean().optional(),
});
export type UpdateSupplierRequest = z.infer<typeof updateSupplierRequest>;
export const listSuppliersQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  active: z.stringbool().optional(),
});
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuery>;
export const supplierResponse = z.object({
  id: uuid,
  name: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  gstin: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  createdAt: isoDateTime,
});
export type SupplierResponse = z.infer<typeof supplierResponse>;

// ---------------------------------------------------------------------------------------------
// Movements: receipts, consumption, adjustments, waste
// ---------------------------------------------------------------------------------------------

export const stockMovementResponse = z.object({
  id: uuid,
  branchId: uuid,
  itemId: uuid,
  kind: stockMovementKind,
  /** Signed. */
  quantity: z.number(),
  unitCostPaise: z.number().nullable(),
  batchNo: z.string().nullable(),
  expiryDate: dateOnly.nullable(),
  receiptId: uuid.nullable(),
  transferId: uuid.nullable(),
  procedureRecordId: uuid.nullable(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  reason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  balanceAfter: z.number().nullable(),
});
export type StockMovementResponse = z.infer<typeof stockMovementResponse>;

/** Purchase receipt: one header + RECEIPT movements. Batch/expiry required for items that track batches. */
export const receiveStockRequest = z.object({
  branchId: uuid,
  supplierId: uuid.optional(),
  /** Supplier invoice / challan number. */
  reference: z.string().trim().max(100).optional(),
  receivedOn: dateOnly,
  notes: optionalText(500),
  /** Replay key (RequestDedupe scope `stock.receive`): a retried request must not receive the goods twice. */
  idempotencyKey,
  lines: z
    .array(
      z.object({
        itemId: uuid,
        quantity: stockQuantity,
        unitCostPaise,
        batchNo: batchNo.optional(),
        expiryDate: dateOnly.optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type ReceiveStockRequest = z.infer<typeof receiveStockRequest>;
export const stockReceiptResponse = z.object({
  id: uuid,
  branchId: uuid,
  supplierId: uuid.nullable(),
  reference: z.string().nullable(),
  receivedOn: dateOnly,
  totalCostPaise: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  movements: z.array(stockMovementResponse),
});
export type StockReceiptResponse = z.infer<typeof stockReceiptResponse>;
export const listStockReceiptsQuery = pageQuery.extend({
  branchId: uuid.optional(),
  supplierId: uuid.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListStockReceiptsQuery = z.infer<typeof listStockReceiptsQuery>;

/**
 * Consumption (usage record), optionally tied to a procedure. Without `batchNo` the server consumes
 * first-expiry-first-out across batches (one movement per batch used).
 */
export const consumeStockRequest = z.object({
  branchId: uuid,
  procedureRecordId: uuid.optional(),
  reason: optionalText(300),
  /** Replay key (scope `stock.consume`). */
  idempotencyKey,
  lines: z
    .array(z.object({ itemId: uuid, quantity: stockQuantity, batchNo: batchNo.optional() }))
    .min(1)
    .max(100),
});
export type ConsumeStockRequest = z.infer<typeof consumeStockRequest>;
export const consumeStockResponse = z.object({ movements: z.array(stockMovementResponse) });
export type ConsumeStockResponse = z.infer<typeof consumeStockResponse>;

/** Count correction or write-on / write-off with a mandatory reason and actor (PRD 4.8). `delta` is signed. */
export const adjustStockRequest = z.object({
  branchId: uuid,
  itemId: uuid,
  delta: signedStockQuantity,
  reason: z.string().trim().min(3).max(300),
  batchNo: batchNo.optional(),
  expiryDate: dateOnly.optional(),
  /** Needed only for a positive delta into an empty balance (otherwise the average cost is used). */
  unitCostPaise: unitCostPaise.optional(),
  /** Replay key (scope `stock.adjust`). */
  idempotencyKey,
});
export type AdjustStockRequest = z.infer<typeof adjustStockRequest>;
/** Damaged / expired / lost stock (a WASTE movement; quantity is the positive amount wasted). */
export const recordWasteRequest = z.object({
  branchId: uuid,
  itemId: uuid,
  quantity: stockQuantity,
  reason: z.string().trim().min(3).max(300),
  batchNo: batchNo.optional(),
  /** Replay key (scope `stock.waste`). */
  idempotencyKey,
});
export type RecordWasteRequest = z.infer<typeof recordWasteRequest>;

export const listStockMovementsQuery = pageQuery.extend({
  branchId: uuid.optional(),
  itemId: uuid.optional(),
  kind: stockMovementKind.optional(),
  procedureRecordId: uuid.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListStockMovementsQuery = z.infer<typeof listStockMovementsQuery>;

// ---------------------------------------------------------------------------------------------
// Transfers (inventory:transfer)
// ---------------------------------------------------------------------------------------------

/** Dispatch: writes TRANSFER_OUT at the source now; the destination books TRANSFER_IN on receipt. */
export const sendTransferRequest = z
  .object({
    fromBranchId: uuid,
    toBranchId: uuid,
    notes: optionalText(500),
    /** Replay key (scope `stock.transfer.send`): a retried dispatch must not ship the goods twice. */
    idempotencyKey,
    lines: z
      .array(z.object({ itemId: uuid, quantity: stockQuantity, batchNo: batchNo.optional() }))
      .min(1)
      .max(100),
  })
  .refine((t) => t.fromBranchId !== t.toBranchId, {
    message: "Source and destination must differ",
    path: ["toBranchId"],
  });
export type SendTransferRequest = z.infer<typeof sendTransferRequest>;
/** Receipt: omit `lines` to accept everything as sent; a short receipt records `receivedQuantity` per line. */
export const receiveTransferRequest = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuid,
        receivedQuantity: z.number().min(0).max(1_000_000_000).refine(hasMax3Decimals),
      }),
    )
    .max(100)
    .optional(),
  notes: optionalText(500),
});
export type ReceiveTransferRequest = z.infer<typeof receiveTransferRequest>;
export const listTransfersQuery = pageQuery.extend({
  fromBranchId: uuid.optional(),
  toBranchId: uuid.optional(),
  status: stockTransferStatus.optional(),
});
export type ListTransfersQuery = z.infer<typeof listTransfersQuery>;
export const stockTransferLineResponse = z.object({
  id: uuid,
  itemId: uuid,
  quantity: z.number(),
  batchNo: z.string().nullable(),
  expiryDate: dateOnly.nullable(),
  unitCostPaise: z.number().nullable(),
  receivedQuantity: z.number().nullable(),
});
export const stockTransferResponse = z.object({
  id: uuid,
  fromBranchId: uuid,
  toBranchId: uuid,
  status: stockTransferStatus,
  notes: z.string().nullable(),
  sentBy: z.string(),
  sentAt: isoDateTime,
  receivedBy: z.string().nullable(),
  receivedAt: isoDateTime.nullable(),
  lines: z.array(stockTransferLineResponse),
});
export type StockTransferResponse = z.infer<typeof stockTransferResponse>;

// ---------------------------------------------------------------------------------------------
// Balances, low stock, valuation
// ---------------------------------------------------------------------------------------------

export const stockBalancesQuery = pageQuery.extend({
  branchId: uuid.optional(),
  itemId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
  /** Only items at or below their reorder level. */
  lowStockOnly: z.stringbool().optional(),
});
export type StockBalancesQuery = z.infer<typeof stockBalancesQuery>;
export const stockBalanceResponse = z.object({
  branchId: uuid,
  itemId: uuid,
  sku: z.string(),
  name: z.string(),
  unit: inventoryUnit,
  quantity: z.number(),
  avgUnitCostPaise: z.number(),
  /** quantity × weighted-average cost, whole paise. */
  valuePaise: z.number().int(),
  reorderLevel: z.number(),
  low: z.boolean(),
  updatedAt: isoDateTime,
});
export type StockBalanceResponse = z.infer<typeof stockBalanceResponse>;

/** Batches with stock for one item at a branch (FEFO order), derived from the ledger. */
export const stockBatchesQuery = z.object({ branchId: uuid, itemId: uuid });
export const stockBatchResponse = z.object({
  batchNo: z.string().nullable(),
  expiryDate: dateOnly.nullable(),
  quantity: z.number(),
});
export type StockBatchResponse = z.infer<typeof stockBatchResponse>;

export const stockValuationQuery = z.object({ branchId: uuid.optional() });
export const stockValuationResponse = z.object({
  rows: z.array(
    z.object({ branchId: uuid, valuePaise: z.number().int(), itemCount: z.number().int() }),
  ),
  totalPaise: z.number().int(),
});
export type StockValuationResponse = z.infer<typeof stockValuationResponse>;
