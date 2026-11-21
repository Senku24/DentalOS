import {
  type InventoryItemResponse,
  type StockMovementKind,
  type StockMovementResponse,
  type StockReceiptResponse,
  type StockTransferResponse,
  type SupplierResponse,
  isLowStock,
  planFefoConsumption,
  roundCost,
  roundQuantity,
  stockValuePaise,
  weightedAverageCost,
} from "@dentalos/validation";
import type { Method, MockHandler } from "./client";
import { mapHttpError } from "./errors";
import { branches, fid } from "./fixtures";
import { mockHandler as m1 } from "./mock";
import { API_PREFIX } from "./routes";

/**
 * Mock mode for the inventory screens: lightweight in-memory fixtures behind the same routes as
 * apps/api/src/inventory. Weighted-average cost, FEFO consumption, idempotent writes and the error codes
 * (insufficient_stock, batch_required, receive_exceeds_sent, ...) behave like the API. Anything that is not
 * an inventory route falls through to the shared M1 mock (branches, staff, catalogue).
 */

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw mapHttpError(status, { error, ...extra });
};

const DAY = 86_400_000;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const dateIn = (offsetDays: number) => isoDate(offsetDays).slice(0, 10);

const B = branches.filter((b) => b.active).map((b) => b.id);
const [B1, B2] = [B[0] as string, (B[1] ?? B[0]) as string];

let seq = 1000;
const nid = (kind: string) => fid(kind, seq++);

const items: InventoryItemResponse[] = [
  mkItem(1, "GLOVE-M", "Nitrile gloves (M)", "Consumables", "BOX", 10, false, false),
  mkItem(2, "LIDO-2", "Lignocaine 2% cartridge", "Anaesthesia", "CARTRIDGE", 50, true, false),
  mkItem(3, "COMP-A2", "Composite A2 syringe", "Restorative", "PIECE", 5, true, false),
  mkItem(4, "SUCT-TIP", "Suction tips (pack of 100)", "Consumables", "PACK", 20, false, false),
  mkItem(5, "NAOCL-3", "NaOCl 3% irrigant", "Endodontics", "MILLILITRE", 500, true, true),
];
function mkItem(
  n: number,
  sku: string,
  name: string,
  category: string,
  unit: InventoryItemResponse["unit"],
  reorderLevel: number,
  tracksBatches: boolean,
  allowOverdraw: boolean,
): InventoryItemResponse {
  return {
    id: fid("1a", n),
    sku,
    name,
    category,
    unit,
    reorderLevel,
    costingMethod: "WEIGHTED_AVERAGE",
    tracksBatches,
    allowOverdraw,
    active: true,
    createdAt: isoDate(-90),
  };
}

const suppliers: SupplierResponse[] = [
  {
    id: fid("1b", 1),
    name: "Dental Depot India",
    contactName: "Rakesh Nair",
    phone: "+919000000101",
    email: "orders@dentaldepot.example.com",
    gstin: null,
    address: "Okhla Phase 2, New Delhi",
    notes: null,
    active: true,
    createdAt: isoDate(-90),
  },
  {
    id: fid("1b", 2),
    name: "MedLine Supplies",
    contactName: null,
    phone: null,
    email: null,
    gstin: null,
    address: null,
    notes: "Net 30 terms",
    active: true,
    createdAt: isoDate(-60),
  },
];

const movements: StockMovementResponse[] = [];
const receipts: StockReceiptResponse[] = [];
const transfers: StockTransferResponse[] = [];
const bal = new Map<string, { quantity: number; avg: number; updatedAt: string }>();
const dedupe = new Map<string, unknown>();
const k = (branchId: string, itemId: string) => `${branchId}|${itemId}`;
const ME = "dev-user";

interface Mv {
  branchId: string;
  itemId: string;
  kind: StockMovementKind;
  quantity: number;
  unitCostPaise?: number | null;
  batchNo?: string | null;
  expiryDate?: string | null;
  receiptId?: string | null;
  transferId?: string | null;
  procedureRecordId?: string | null;
  reason?: string | null;
}
function apply(m: Mv, at = new Date().toISOString()): StockMovementResponse {
  const cur = bal.get(k(m.branchId, m.itemId)) ?? { quantity: 0, avg: 0, updatedAt: at };
  let avg = cur.avg;
  if (m.quantity > 0 && m.unitCostPaise !== null && m.unitCostPaise !== undefined)
    avg = weightedAverageCost(cur.quantity, cur.avg, m.quantity, m.unitCostPaise);
  const quantity = roundQuantity(cur.quantity + m.quantity);
  bal.set(k(m.branchId, m.itemId), { quantity, avg, updatedAt: at });
  const row: StockMovementResponse = {
    id: nid("1c"),
    branchId: m.branchId,
    itemId: m.itemId,
    kind: m.kind,
    quantity: m.quantity,
    unitCostPaise: m.quantity > 0 ? (m.unitCostPaise ?? null) : roundCost(cur.avg),
    batchNo: m.batchNo ?? null,
    expiryDate: m.expiryDate ?? null,
    receiptId: m.receiptId ?? null,
    transferId: m.transferId ?? null,
    procedureRecordId: m.procedureRecordId ?? null,
    refType: null,
    refId: null,
    reason: m.reason ?? null,
    createdBy: ME,
    createdAt: at,
    balanceAfter: quantity,
  };
  movements.push(row);
  return row;
}

interface Batch {
  batchNo: string | null;
  expiryDate: string | null;
  quantity: number;
}
function batchesOf(branchId: string, itemId: string): Batch[] {
  const map = new Map<string, Batch>();
  for (const m of movements) {
    if (m.branchId !== branchId || m.itemId !== itemId || !m.batchNo) continue;
    const b = map.get(m.batchNo) ?? { batchNo: m.batchNo, expiryDate: m.expiryDate, quantity: 0 };
    b.quantity = roundQuantity(b.quantity + m.quantity);
    b.expiryDate = b.expiryDate ?? m.expiryDate;
    map.set(m.batchNo, b);
  }
  return [...map.values()].filter((b) => b.quantity > 0);
}

const itemOf = (itemId: string) =>
  items.find((i) => i.id === itemId) ?? fail(404, "item_not_found");

/** Issues stock (consumption / transfer / waste): plans first, throws before writing anything. */
function planIssue(
  branchId: string,
  itemId: string,
  needed: number,
  batchNo?: string,
): { batchNo: string | null; expiryDate: string | null; quantity: number }[] {
  const item = itemOf(itemId);
  const cur = bal.get(k(branchId, itemId))?.quantity ?? 0;
  if (!item.tracksBatches || batchNo === undefined) {
    if (!item.tracksBatches) {
      if (!item.allowOverdraw && cur < needed)
        fail(409, "insufficient_stock", { itemId, available: cur, needed });
      return [{ batchNo: null, expiryDate: null, quantity: needed }];
    }
    const plan = planFefoConsumption(batchesOf(branchId, itemId), needed);
    if (plan.shortfall > 0 && !item.allowOverdraw)
      fail(409, "insufficient_stock", {
        itemId,
        available: roundQuantity(needed - plan.shortfall),
        needed,
      });
    const picks = [...plan.picks];
    if (plan.shortfall > 0)
      picks.push({ batchNo: null, expiryDate: null, quantity: plan.shortfall });
    return picks;
  }
  const b = batchesOf(branchId, itemId).find((x) => x.batchNo === batchNo);
  if (!b) fail(409, "batch_not_found", { itemId, batchNo });
  if (b && !item.allowOverdraw && b.quantity < needed)
    fail(409, "insufficient_stock", { itemId, batchNo, available: b.quantity, needed });
  return [{ batchNo: batchNo ?? null, expiryDate: b?.expiryDate ?? null, quantity: needed }];
}

// ---- Seed --------------------------------------------------------------------------------------
function seed() {
  const at = isoDate(-30);
  const r = (b: string, i: number, qty: number, cost: number, batch?: string, expiry?: string) =>
    apply(
      {
        branchId: b,
        itemId: fid("1a", i),
        kind: "RECEIPT",
        quantity: qty,
        unitCostPaise: cost,
        batchNo: batch ?? null,
        expiryDate: expiry ?? null,
        reason: null,
      },
      at,
    );
  r(B1, 1, 24, 45_000);
  r(B1, 2, 40, 1_800, "LD-2406", dateIn(20));
  r(B1, 2, 120, 1_850, "LD-2511", dateIn(300));
  r(B1, 3, 3, 95_000, "CA-77", dateIn(-5));
  r(B1, 4, 60, 12_000);
  r(B1, 5, 400, 12.5, "NA-01", dateIn(120));
  r(B2, 1, 6, 46_000);
  r(B2, 2, 200, 1_820, "LD-2511", dateIn(300));
  r(B2, 4, 18, 12_000);
  const m = apply({
    branchId: B1,
    itemId: fid("1a", 1),
    kind: "CONSUMPTION",
    quantity: -2,
    reason: "Daily use",
  });
  void m;
}
seed();

// ---- Helpers -----------------------------------------------------------------------------------
type Q = Record<string, string>;
const pageOf = <T>(rows: T[], q: Q) => {
  const limit = Math.min(Number(q.limit) || 25, 100);
  const off = Number(q.cursor) || 0;
  return {
    items: rows.slice(off, off + limit),
    nextCursor: off + limit < rows.length ? String(off + limit) : null,
  };
};
const has = (s: string | null | undefined, term: string | undefined) =>
  !term || (s ?? "").toLowerCase().includes(term.toLowerCase());
const num = (v: unknown) => (typeof v === "number" ? v : Number(v));

interface BalanceRow {
  branchId: string;
  itemId: string;
  sku: string;
  name: string;
  unit: InventoryItemResponse["unit"];
  quantity: number;
  avgUnitCostPaise: number;
  valuePaise: number;
  reorderLevel: number;
  low: boolean;
  updatedAt: string;
}
function balanceRows(q: Q, includeUnstocked: boolean): BalanceRow[] {
  const out: BalanceRow[] = [];
  const bs = q.branchId ? [q.branchId] : B;
  for (const item of [...items].sort((a, b) => a.sku.localeCompare(b.sku))) {
    if (q.itemId && item.id !== q.itemId) continue;
    if (!has(item.name, q.q) && !has(item.sku, q.q)) continue;
    for (const branchId of bs) {
      const b = bal.get(k(branchId, item.id));
      if (!b && !includeUnstocked) continue;
      const quantity = b?.quantity ?? 0;
      const low = isLowStock(quantity, item.reorderLevel);
      if (includeUnstocked && (!item.active || !low)) continue;
      if (q.lowStockOnly === "true" && !low) continue;
      out.push({
        branchId,
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        quantity,
        avgUnitCostPaise: b?.avg ?? 0,
        valuePaise: stockValuePaise(quantity, b?.avg ?? 0),
        reorderLevel: item.reorderLevel,
        low,
        updatedAt: b?.updatedAt ?? item.createdAt,
      });
    }
  }
  return out;
}

const withBalance = (item: InventoryItemResponse, branchId?: string): InventoryItemResponse => {
  if (!branchId) return item;
  const b = bal.get(k(branchId, item.id));
  const quantity = b?.quantity ?? 0;
  return {
    ...item,
    quantity,
    avgUnitCostPaise: b?.avg ?? 0,
    low: isLowStock(quantity, item.reorderLevel),
  };
};

const idem = <T>(scope: string, key: string, body: unknown, run: () => T): T => {
  const sig = JSON.stringify(body);
  const prev = dedupe.get(`${scope}|${key}`) as { sig: string; out: T } | undefined;
  if (prev) {
    if (prev.sig !== sig) fail(409, "idempotency_conflict");
    return prev.out;
  }
  const out = run();
  dedupe.set(`${scope}|${key}`, { sig, out });
  return out;
};

type Route = [Method, RegExp, (m: string[], q: Q, b: Record<string, unknown>) => unknown];
const U = "([0-9a-f-]{36})";
const routes: Route[] = [
  [
    "GET",
    /^\/inventory\/items$/,
    (_m, q) =>
      pageOf(
        items
          .filter(
            (i) =>
              (has(i.name, q.q) || has(i.sku, q.q)) &&
              (!q.category || i.category === q.category) &&
              (q.active === undefined || String(i.active) === q.active),
          )
          .map((i) => withBalance(i, q.branchId)),
        q,
      ),
  ],
  [
    "POST",
    /^\/inventory\/items$/,
    (_m, _q, b) => {
      const sku = String(b.sku).toUpperCase();
      if (items.some((i) => i.sku === sku)) fail(409, "sku_taken");
      const item: InventoryItemResponse = {
        id: nid("1a"),
        sku,
        name: String(b.name),
        category: (b.category as string) ?? null,
        unit: (b.unit as InventoryItemResponse["unit"]) ?? "PIECE",
        reorderLevel: num(b.reorderLevel ?? 0),
        costingMethod: "WEIGHTED_AVERAGE",
        tracksBatches: Boolean(b.tracksBatches),
        allowOverdraw: Boolean(b.allowOverdraw),
        active: true,
        createdAt: new Date().toISOString(),
      };
      items.push(item);
      return item;
    },
  ],
  ["GET", new RegExp(`^/inventory/items/${U}$`), ([id]) => itemOf(id as string)],
  [
    "PATCH",
    new RegExp(`^/inventory/items/${U}$`),
    ([id], _q, b) => Object.assign(itemOf(id as string), b),
  ],
  [
    "GET",
    /^\/inventory\/suppliers$/,
    (_m, q) =>
      pageOf(
        suppliers.filter(
          (s) => has(s.name, q.q) && (q.active === undefined || String(s.active) === q.active),
        ),
        q,
      ),
  ],
  [
    "POST",
    /^\/inventory\/suppliers$/,
    (_m, _q, b) => {
      if (suppliers.some((s) => s.name.toLowerCase() === String(b.name).toLowerCase()))
        fail(409, "supplier_name_taken");
      const s: SupplierResponse = {
        id: nid("1b"),
        name: String(b.name),
        contactName: (b.contactName as string) ?? null,
        phone: (b.phone as string) ?? null,
        email: (b.email as string) ?? null,
        gstin: (b.gstin as string) ?? null,
        address: (b.address as string) ?? null,
        notes: (b.notes as string) ?? null,
        active: true,
        createdAt: new Date().toISOString(),
      };
      suppliers.push(s);
      return s;
    },
  ],
  [
    "PATCH",
    new RegExp(`^/inventory/suppliers/${U}$`),
    ([id], _q, b) =>
      Object.assign(suppliers.find((s) => s.id === id) ?? fail(404, "supplier_not_found"), b),
  ],
  [
    "GET",
    /^\/inventory\/receipts$/,
    (_m, q) =>
      pageOf(
        [...receipts]
          .reverse()
          .filter(
            (r) =>
              (!q.branchId || r.branchId === q.branchId) &&
              (!q.supplierId || r.supplierId === q.supplierId) &&
              (!q.from || r.receivedOn >= q.from) &&
              (!q.to || r.receivedOn <= q.to),
          ),
        q,
      ),
  ],
  [
    "POST",
    /^\/inventory\/receipts$/,
    (_m, _q, b) =>
      idem("receive", String(b.idempotencyKey), b, () => {
        const lines = b.lines as {
          itemId: string;
          quantity: number;
          unitCostPaise: number;
          batchNo?: string;
          expiryDate?: string;
        }[];
        if (b.supplierId) {
          const s = suppliers.find((x) => x.id === b.supplierId) ?? fail(404, "supplier_not_found");
          if (!s.active) fail(409, "supplier_inactive");
        }
        for (const l of lines) {
          const it = itemOf(l.itemId);
          if (!it.active) fail(409, "item_inactive", { itemId: it.id });
          if (it.tracksBatches && (!l.batchNo || !l.expiryDate))
            fail(409, "batch_required", { itemId: it.id });
        }
        const id = nid("1d");
        const at = new Date().toISOString();
        const mv = lines.map((l) =>
          apply(
            {
              branchId: String(b.branchId),
              itemId: l.itemId,
              kind: "RECEIPT",
              quantity: l.quantity,
              unitCostPaise: l.unitCostPaise,
              batchNo: l.batchNo ?? null,
              expiryDate: l.expiryDate ?? null,
              receiptId: id,
            },
            at,
          ),
        );
        const receipt: StockReceiptResponse = {
          id,
          branchId: String(b.branchId),
          supplierId: (b.supplierId as string) ?? null,
          reference: (b.reference as string) ?? null,
          receivedOn: String(b.receivedOn),
          totalCostPaise: lines.reduce(
            (a, l) => a + stockValuePaise(l.quantity, l.unitCostPaise),
            0,
          ),
          notes: (b.notes as string) ?? null,
          createdBy: ME,
          createdAt: at,
          movements: mv,
        };
        receipts.push(receipt);
        return receipt;
      }),
  ],
  [
    "GET",
    new RegExp(`^/inventory/receipts/${U}$`),
    ([id]) => receipts.find((r) => r.id === id) ?? fail(404, "receipt_not_found"),
  ],
  [
    "POST",
    /^\/inventory\/consumption$/,
    (_m, _q, b) =>
      idem("consume", String(b.idempotencyKey), b, () => {
        const branchId = String(b.branchId);
        const lines = b.lines as { itemId: string; quantity: number; batchNo?: string }[];
        // Plan everything first so a shortage writes nothing.
        const planned = lines.map((l) => ({
          l,
          picks: planIssue(branchId, l.itemId, l.quantity, l.batchNo),
        }));
        const out: StockMovementResponse[] = [];
        for (const { l, picks } of planned)
          for (const pick of picks)
            out.push(
              apply({
                branchId,
                itemId: l.itemId,
                kind: "CONSUMPTION",
                quantity: -pick.quantity,
                batchNo: pick.batchNo,
                expiryDate: pick.expiryDate,
                procedureRecordId: (b.procedureRecordId as string) ?? null,
                reason: (b.reason as string) ?? null,
              }),
            );
        return { movements: out };
      }),
  ],
  [
    "POST",
    /^\/inventory\/adjustments$/,
    (_m, _q, b) =>
      idem("adjust", String(b.idempotencyKey), b, () => {
        const branchId = String(b.branchId);
        const itemId = String(b.itemId);
        const item = itemOf(itemId);
        const delta = num(b.delta);
        if (item.tracksBatches && !b.batchNo) fail(409, "batch_required", { itemId });
        const cur = bal.get(k(branchId, itemId));
        if (delta < 0) planIssue(branchId, itemId, -delta, b.batchNo as string | undefined);
        else if ((!cur || cur.quantity <= 0) && b.unitCostPaise === undefined)
          fail(409, "unit_cost_required", { itemId });
        return {
          movements: [
            apply({
              branchId,
              itemId,
              kind: "ADJUSTMENT",
              quantity: delta,
              unitCostPaise: delta > 0 ? ((b.unitCostPaise as number) ?? cur?.avg ?? 0) : null,
              batchNo: (b.batchNo as string) ?? null,
              expiryDate: (b.expiryDate as string) ?? null,
              reason: String(b.reason),
            }),
          ],
        };
      }),
  ],
  [
    "POST",
    /^\/inventory\/waste$/,
    (_m, _q, b) =>
      idem("waste", String(b.idempotencyKey), b, () => {
        const branchId = String(b.branchId);
        const itemId = String(b.itemId);
        const picks = planIssue(branchId, itemId, num(b.quantity), b.batchNo as string | undefined);
        return {
          movements: picks.map((pick) =>
            apply({
              branchId,
              itemId,
              kind: "WASTE",
              quantity: -pick.quantity,
              batchNo: pick.batchNo,
              expiryDate: pick.expiryDate,
              reason: String(b.reason),
            }),
          ),
        };
      }),
  ],
  [
    "GET",
    /^\/inventory\/movements$/,
    (_m, q) =>
      pageOf(
        [...movements]
          .reverse()
          .filter(
            (m) =>
              (!q.branchId || m.branchId === q.branchId) &&
              (!q.itemId || m.itemId === q.itemId) &&
              (!q.kind || m.kind === q.kind) &&
              (!q.procedureRecordId || m.procedureRecordId === q.procedureRecordId) &&
              (!q.from || m.createdAt.slice(0, 10) >= q.from) &&
              (!q.to || m.createdAt.slice(0, 10) <= q.to),
          ),
        q,
      ),
  ],
  [
    "GET",
    /^\/inventory\/transfers$/,
    (_m, q) =>
      pageOf(
        [...transfers]
          .reverse()
          .filter(
            (t) =>
              (!q.fromBranchId || t.fromBranchId === q.fromBranchId) &&
              (!q.toBranchId || t.toBranchId === q.toBranchId) &&
              (!q.status || t.status === q.status),
          ),
        q,
      ),
  ],
  [
    "POST",
    /^\/inventory\/transfers$/,
    (_m, _q, b) =>
      idem("transfer.send", String(b.idempotencyKey), b, () => {
        const from = String(b.fromBranchId);
        const to = String(b.toBranchId);
        if (from === to) fail(409, "transfer_same_branch");
        const lines = b.lines as { itemId: string; quantity: number; batchNo?: string }[];
        const planned = lines.map((l) => ({
          l,
          picks: planIssue(from, l.itemId, l.quantity, l.batchNo),
        }));
        const id = nid("1e");
        const at = new Date().toISOString();
        const tl: StockTransferResponse["lines"] = [];
        for (const { l, picks } of planned)
          for (const pick of picks) {
            apply({
              branchId: from,
              itemId: l.itemId,
              kind: "TRANSFER_OUT",
              quantity: -pick.quantity,
              batchNo: pick.batchNo,
              expiryDate: pick.expiryDate,
              transferId: id,
            });
            tl.push({
              id: nid("1f"),
              itemId: l.itemId,
              quantity: pick.quantity,
              batchNo: pick.batchNo,
              expiryDate: pick.expiryDate,
              unitCostPaise: bal.get(k(from, l.itemId))?.avg ?? 0,
              receivedQuantity: null,
            });
          }
        const t: StockTransferResponse = {
          id,
          fromBranchId: from,
          toBranchId: to,
          status: "IN_TRANSIT",
          notes: (b.notes as string) ?? null,
          sentBy: ME,
          sentAt: at,
          receivedBy: null,
          receivedAt: null,
          lines: tl,
        };
        transfers.push(t);
        return t;
      }),
  ],
  [
    "GET",
    new RegExp(`^/inventory/transfers/${U}$`),
    ([id]) => transfers.find((t) => t.id === id) ?? fail(404, "transfer_not_found"),
  ],
  [
    "POST",
    new RegExp(`^/inventory/transfers/${U}/receive$`),
    ([id], _q, b) => {
      const t = transfers.find((x) => x.id === id) ?? fail(404, "transfer_not_found");
      if (t.status !== "IN_TRANSIT") fail(409, "stock_transfer_state", { status: t.status });
      const got = new Map(
        ((b.lines as { lineId: string; receivedQuantity: number }[]) ?? []).map((l) => [
          l.lineId,
          roundQuantity(l.receivedQuantity),
        ]),
      );
      for (const l of t.lines) {
        const r = got.get(l.id) ?? l.quantity;
        if (r > l.quantity)
          fail(409, "receive_exceeds_sent", { lineId: l.id, sent: l.quantity, received: r });
      }
      for (const l of t.lines) {
        const r = got.get(l.id) ?? l.quantity;
        l.receivedQuantity = r;
        if (r > 0)
          apply({
            branchId: t.toBranchId,
            itemId: l.itemId,
            kind: "TRANSFER_IN",
            quantity: r,
            unitCostPaise: l.unitCostPaise,
            batchNo: l.batchNo,
            expiryDate: l.expiryDate,
            transferId: t.id,
          });
      }
      t.status = "RECEIVED";
      t.receivedBy = ME;
      t.receivedAt = new Date().toISOString();
      return t;
    },
  ],
  ["GET", /^\/inventory\/balances$/, (_m, q) => pageOf(balanceRows(q, false), q)],
  ["GET", /^\/inventory\/low-stock$/, (_m, q) => pageOf(balanceRows(q, true), q)],
  [
    "GET",
    /^\/inventory\/batches$/,
    (_m, q) =>
      batchesOf(q.branchId as string, q.itemId as string)
        .sort((a, b) => (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999"))
        .map((b) => ({ batchNo: b.batchNo, expiryDate: b.expiryDate, quantity: b.quantity })),
  ],
  [
    "GET",
    /^\/inventory\/expiring$/,
    (_m, q) => {
      const within = q.withinDays === undefined ? 30 : Number(q.withinDays);
      const today = dateIn(0);
      const rows = [];
      for (const branchId of q.branchId ? [q.branchId] : B)
        for (const item of items)
          for (const b of batchesOf(branchId, item.id)) {
            if (!b.expiryDate || !b.batchNo) continue;
            const days = Math.round(
              (Date.parse(`${b.expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY,
            );
            if (days > within) continue;
            rows.push({
              branchId,
              itemId: item.id,
              sku: item.sku,
              name: item.name,
              unit: item.unit,
              batchNo: b.batchNo,
              expiryDate: b.expiryDate,
              quantity: b.quantity,
              daysToExpiry: days,
              expired: days <= 0,
            });
          }
      rows.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
      return { items: rows };
    },
  ],
  [
    "GET",
    /^\/inventory\/valuation$/,
    (_m, q) => {
      const rows = (q.branchId ? [q.branchId] : B).map((branchId) => {
        const mine = balanceRows({ branchId }, false).filter((r) => r.quantity > 0);
        return {
          branchId,
          valuePaise: mine.reduce((a, r) => a + r.valuePaise, 0),
          itemCount: mine.length,
        };
      });
      return { rows, totalPaise: rows.reduce((a, r) => a + r.valuePaise, 0) };
    },
  ],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const inventoryMockHandler: MockHandler = async (method, fullPath, query, body) => {
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) : fullPath;
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (!match) continue;
    await sleep(120);
    return structuredClone(
      h(match.slice(1).map(decodeURIComponent), query, (body ?? {}) as Record<string, unknown>),
    );
  }
  return m1(method, fullPath, query, body);
};
