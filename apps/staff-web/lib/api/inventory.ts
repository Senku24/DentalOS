import type {
  AdjustStockRequest,
  ConsumeStockRequest,
  ConsumeStockResponse,
  CreateInventoryItemRequest,
  CreateSupplierRequest,
  InventoryItemResponse,
  ReceiveStockRequest,
  ReceiveTransferRequest,
  RecordWasteRequest,
  SendTransferRequest,
  StockBalanceResponse,
  StockBatchResponse,
  StockMovementResponse,
  StockReceiptResponse,
  StockTransferResponse,
  StockValuationResponse,
  SupplierResponse,
  UpdateInventoryItemRequest,
  UpdateSupplierRequest,
} from "@dentalos/validation";
import {
  type ApiClient,
  type Method,
  type MockHandler,
  type RequestOptions,
  apiClient,
  createClient,
} from "./client";
import { withInventoryMessage } from "./inventory-errors";
import { API_PREFIX, type QueryValue } from "./routes";
import type { Page } from "./types";

/**
 * Client for the inventory API (PRD 4.8, ADR 0004 §8; apps/api/src/inventory). Same transport as the
 * shared `apiClient`; errors are re-labelled with inventory copy and, in mock mode, requests are served
 * by `inventory-mock.ts` (which falls back to the shared M1 mock for branches, staff, catalogue).
 */
const lazyMock: MockHandler = async (method, path, query, body) =>
  (await import("./inventory-mock")).inventoryMockHandler(method, path, query, body);

function withInventoryErrors(c: ApiClient): ApiClient {
  return {
    config: c.config,
    request<T>(method: Method, path: string, opts?: RequestOptions<T>) {
      return c.request<T>(method, path, opts).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") throw e;
        throw withInventoryMessage(e);
      });
    },
  };
}

export const inventoryClient: ApiClient = withInventoryErrors(
  createClient({ ...apiClient.config, mockHandler: lazyMock }),
);

// ---- Routes ------------------------------------------------------------------------------------
const p = (path: string) => `${API_PREFIX}${path}`;
const id = (v: string) => encodeURIComponent(v);

export const inventoryRoutes = {
  /** GET ?q&category&active&branchId → page(item), POST createInventoryItemRequest */
  items: () => p("/inventory/items"),
  /** GET, PATCH updateInventoryItemRequest */
  item: (itemId: string) => p(`/inventory/items/${id(itemId)}`),
  /** GET ?q&active → page(supplier), POST createSupplierRequest */
  suppliers: () => p("/inventory/suppliers"),
  /** GET, PATCH updateSupplierRequest */
  supplier: (supplierId: string) => p(`/inventory/suppliers/${id(supplierId)}`),
  /** GET ?branchId&supplierId&from&to → page(receipt), POST receiveStockRequest */
  receipts: () => p("/inventory/receipts"),
  receipt: (receiptId: string) => p(`/inventory/receipts/${id(receiptId)}`),
  /** POST consumeStockRequest → { movements } */
  consumption: () => p("/inventory/consumption"),
  /** POST adjustStockRequest → { movements } (inventory:adjust) */
  adjustments: () => p("/inventory/adjustments"),
  /** POST recordWasteRequest → { movements } (inventory:adjust) */
  waste: () => p("/inventory/waste"),
  /** GET ?branchId&itemId&kind&procedureRecordId&from&to → page(movement) */
  movements: () => p("/inventory/movements"),
  /** GET ?fromBranchId&toBranchId&status → page(transfer), POST sendTransferRequest (inventory:transfer) */
  transfers: () => p("/inventory/transfers"),
  transfer: (transferId: string) => p(`/inventory/transfers/${id(transferId)}`),
  /** POST receiveTransferRequest (200) */
  transferReceive: (transferId: string) => p(`/inventory/transfers/${id(transferId)}/receive`),
  /** GET ?branchId&itemId&q&lowStockOnly → page(balance) */
  balances: () => p("/inventory/balances"),
  /** GET same query, includes never-stocked active items below their reorder level */
  lowStock: () => p("/inventory/low-stock"),
  /** GET ?branchId&itemId (required) → StockBatchResponse[] (FEFO order) */
  batches: () => p("/inventory/batches"),
  /** GET ?branchId&withinDays&limit → { items } (already expired included) */
  expiring: () => p("/inventory/expiring"),
  /** GET ?branchId → { rows, totalPaise } */
  valuation: () => p("/inventory/valuation"),
} as const;

// ---- Types (response shapes the API does not export from @dentalos/validation) ----------------------
/** GET /inventory/expiring row (apps/api/src/inventory/inventory.dto.ts `expiringBatchResponse`). */
export interface ExpiringBatch {
  branchId: string;
  itemId: string;
  sku: string;
  name: string;
  unit: string;
  batchNo: string;
  expiryDate: string;
  quantity: number;
  /** Negative when already expired. */
  daysToExpiry: number;
  expired: boolean;
}

export interface ItemListQuery {
  q?: string;
  category?: string;
  active?: boolean;
  /** When set, each item carries its balance at this branch. */
  branchId?: string;
  cursor?: string;
  limit?: number;
}
export interface SupplierListQuery {
  q?: string;
  active?: boolean;
  cursor?: string;
  limit?: number;
}
export interface BalanceQuery {
  branchId?: string;
  itemId?: string;
  q?: string;
  lowStockOnly?: boolean;
  cursor?: string;
  limit?: number;
}
export interface MovementQuery {
  branchId?: string;
  itemId?: string;
  kind?: string;
  procedureRecordId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface ReceiptQuery {
  branchId?: string;
  supplierId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface TransferQuery {
  fromBranchId?: string;
  toBranchId?: string;
  status?: "IN_TRANSIT" | "RECEIVED";
  cursor?: string;
  limit?: number;
}

type Q = Record<string, QueryValue>;

export function createInventoryApi(c: ApiClient) {
  const get = <T>(path: string, query?: object) =>
    c.request<T>("GET", path, { query: query as Q | undefined });
  const post = <T>(path: string, body: unknown) => c.request<T>("POST", path, { body });
  const patch = <T>(path: string, body: unknown) => c.request<T>("PATCH", path, { body });
  const r = inventoryRoutes;
  return {
    items: {
      list: (q: ItemListQuery = {}) => get<Page<InventoryItemResponse>>(r.items(), q),
      get: (itemId: string) => get<InventoryItemResponse>(r.item(itemId)),
      create: (b: CreateInventoryItemRequest) => post<InventoryItemResponse>(r.items(), b),
      update: (itemId: string, b: UpdateInventoryItemRequest) =>
        patch<InventoryItemResponse>(r.item(itemId), b),
    },
    suppliers: {
      list: (q: SupplierListQuery = {}) => get<Page<SupplierResponse>>(r.suppliers(), q),
      create: (b: CreateSupplierRequest) => post<SupplierResponse>(r.suppliers(), b),
      update: (supplierId: string, b: UpdateSupplierRequest) =>
        patch<SupplierResponse>(r.supplier(supplierId), b),
    },
    stock: {
      receive: (b: ReceiveStockRequest) => post<StockReceiptResponse>(r.receipts(), b),
      receipts: (q: ReceiptQuery = {}) => get<Page<StockReceiptResponse>>(r.receipts(), q),
      receipt: (receiptId: string) => get<StockReceiptResponse>(r.receipt(receiptId)),
      consume: (b: ConsumeStockRequest) => post<ConsumeStockResponse>(r.consumption(), b),
      adjust: (b: AdjustStockRequest) => post<ConsumeStockResponse>(r.adjustments(), b),
      waste: (b: RecordWasteRequest) => post<ConsumeStockResponse>(r.waste(), b),
      movements: (q: MovementQuery = {}) => get<Page<StockMovementResponse>>(r.movements(), q),
    },
    transfers: {
      list: (q: TransferQuery = {}) => get<Page<StockTransferResponse>>(r.transfers(), q),
      get: (transferId: string) => get<StockTransferResponse>(r.transfer(transferId)),
      send: (b: SendTransferRequest) => post<StockTransferResponse>(r.transfers(), b),
      receive: (transferId: string, b: ReceiveTransferRequest) =>
        post<StockTransferResponse>(r.transferReceive(transferId), b),
    },
    reports: {
      balances: (q: BalanceQuery = {}) => get<Page<StockBalanceResponse>>(r.balances(), q),
      lowStock: (q: BalanceQuery = {}) => get<Page<StockBalanceResponse>>(r.lowStock(), q),
      batches: (q: { branchId: string; itemId: string }) =>
        get<StockBatchResponse[]>(r.batches(), q),
      expiring: (q: { branchId?: string; withinDays?: number; limit?: number } = {}) =>
        get<{ items: ExpiringBatch[] }>(r.expiring(), q),
      valuation: (q: { branchId?: string } = {}) => get<StockValuationResponse>(r.valuation(), q),
    },
  };
}

export const inventoryApi = createInventoryApi(inventoryClient);
