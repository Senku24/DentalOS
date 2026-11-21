import { createHash } from "node:crypto";
import {
  type InventoryItem,
  Prisma,
  type PrismaClient,
  type StockMovement,
  type StockTransfer,
  type StockTransferLine,
  type Supplier,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  INVENTORY_ERROR_CODES,
  type InventoryItemResponse,
  type StockMovementResponse,
  type StockTransferResponse,
  type SupplierResponse,
  isLowStock,
  planFefoConsumption,
  roundQuantity,
  uuid,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import type { Principal } from "../auth/roles";
import {
  checkViolation,
  foreignKeyViolation,
  isRetryableTxError,
  isUniqueViolation,
  m3GuardError,
  privilegeDenied,
} from "../common/db-errors";

/**
 * Shared helpers of the inventory module (ADR 0004 §8). Self-contained on purpose: no imports from the other M3 modules.
 * The ledger rule: write `StockMovement` rows ONLY; the DB trigger `stock_movement_apply` maintains `StockBalance`.
 */

/** Error codes: the shared list plus the ones that only exist at the API layer. */
export const INVENTORY_API_ERROR_CODES = [
  ...INVENTORY_ERROR_CODES,
  "item_not_found",
  "supplier_not_found",
  "supplier_inactive",
  "branch_not_found",
  "transfer_not_found",
  "receipt_not_found",
  "procedure_record_not_found",
  "procedure_branch_mismatch",
  "batch_not_found",
  "batch_expiry_conflict",
  "unit_cost_required",
  "receive_exceeds_sent",
  "sku_taken",
  "supplier_name_taken",
  "idempotency_conflict",
  "link_mismatch",
] as const;

// ---------------------------------------------------------------------------------------------
// Dates / numbers
// ---------------------------------------------------------------------------------------------

export const dateStr = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
export const DAY_MS = 86_400_000;
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

type DecimalLike = { toNumber(): number };
export const num = (d: DecimalLike | null | undefined): number | null =>
  d === null || d === undefined ? null : d.toNumber();
export const numOr0 = (d: DecimalLike | null | undefined): number => (d ? d.toNumber() : 0);

// ---------------------------------------------------------------------------------------------
// Errors + transactions
// ---------------------------------------------------------------------------------------------

export const badRequest = (path: string, message: string) =>
  new BadRequestException({ error: "validation_failed", issues: [{ path, message }] });
export const notFound = (error: (typeof INVENTORY_API_ERROR_CODES)[number]) =>
  new NotFoundException({ error });
export const conflict = (
  error: (typeof INVENTORY_API_ERROR_CODES)[number],
  extra: Record<string, unknown> = {},
) => new ConflictException({ error, ...extra });

/** True when a unique violation came from the RequestDedupe key (a concurrent replay): re-run, the pre-read finds it. */
export function isDedupeRace(e: unknown): boolean {
  if (!isUniqueViolation(e)) return false;
  const err = e as { message?: unknown; meta?: { modelName?: unknown; target?: unknown } };
  const target = Array.isArray(err.meta?.target)
    ? (err.meta?.target as unknown[]).join(",")
    : String(err.meta?.target ?? "");
  return (
    err.meta?.modelName === "RequestDedupe" ||
    String(err.message ?? "").includes("RequestDedupe") ||
    (target.includes("idempotencyKey") && target.includes("scope"))
  );
}

/** Maps DB-enforced failures to stable API errors; anything unknown propagates (500). */
export function mapInventoryDbError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  const g = m3GuardError(e);
  if (g === "insufficient_stock") throw new ConflictException({ error: "insufficient_stock" });
  if (g === "stock_transfer_state") throw new ConflictException({ error: "stock_transfer_state" });
  if (g === "stock_item_missing") throw new BadRequestException({ error: "stock_item_missing" });
  const check = checkViolation(e);
  if (check)
    throw new BadRequestException({
      error: "validation_failed",
      issues: [{ path: "", message: `violates ${check}` }],
    });
  const fk = foreignKeyViolation(e);
  if (fk) throw new ConflictException({ error: "link_mismatch", constraint: fk });
  if (privilegeDenied(e)) throw e; // programming error (append-only table / StockBalance): 500, never masked
  if (isUniqueViolation(e)) throw new ConflictException({ error: "concurrent_edit" });
  throw e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One unit of work in the tenant context. Retries the WHOLE transaction on a serialization failure / deadlock and on a
 * concurrent RequestDedupe replay (a few attempts with jitter), then maps database errors.
 */
export async function runTx<T>(
  prisma: PrismaClient,
  p: Pick<Principal, "tenantId" | "userId">,
  fn: (tx: Tx) => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await withTenant(prisma, p.tenantId, fn, { actorId: p.userId });
    } catch (e) {
      if (i < attempts - 1 && (isRetryableTxError(e) || isDedupeRace(e))) {
        await sleep(15 + Math.random() * 45 * (i + 1));
        continue;
      }
      mapInventoryDbError(e);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Idempotent append-only writes (RequestDedupe)
// ---------------------------------------------------------------------------------------------

/** SHA-256 of the canonical (key-sorted) body without its `idempotencyKey`. */
export function hashBody(body: object): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([k, x]) => k !== "idempotencyKey" && x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canon(body)))
    .digest("hex");
}

/**
 * Inserts the RequestDedupe row FIRST (ADR 0004 §6). Returns the stored `refId` when this key was already used with the
 * same body (a replay: write nothing, answer from that id); throws 409 `idempotency_conflict` when the body differs.
 * A concurrent first use loses the unique race on the insert; `runTx` re-runs and lands here as a replay.
 */
export async function claimRequest(
  tx: Tx,
  p: Pick<Principal, "tenantId" | "userId">,
  scope: string,
  key: string,
  body: object,
  refType: string,
  refId: string,
): Promise<string | null> {
  const requestHash = hashBody(body);
  const prior = await tx.requestDedupe.findUnique({
    where: { tenantId_scope_idempotencyKey: { tenantId: p.tenantId, scope, idempotencyKey: key } },
  });
  if (prior) {
    if (prior.requestHash && prior.requestHash !== requestHash)
      throw conflict("idempotency_conflict");
    if (prior.refId) return prior.refId;
  }
  await tx.requestDedupe.create({
    data: {
      tenantId: p.tenantId,
      scope,
      idempotencyKey: key,
      requestHash,
      refType,
      refId,
      createdBy: p.userId,
    },
  });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------------

export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  if (rest.length > 0 || !uuid.safeParse(id).success || Number.isNaN(createdAt.getTime()))
    throw badRequest("cursor", "Invalid cursor");
  return { createdAt, id: id as string };
}

/** Prisma `where` fragment: rows strictly after the cursor in (createdAt desc, id desc) order. */
export function afterCursor(cursor: string | undefined) {
  if (!cursor) return {};
  const c = decodeCursor(cursor);
  return {
    OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
  };
}

export function pageOf<T extends { createdAt: Date; id: string }, R>(
  rows: T[],
  limit: number,
  map: (r: T) => R,
): { items: R[]; nextCursor: string | null } {
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor: more && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------

export function toItemResponse(
  i: InventoryItem,
  balance?: { quantity: number; avgUnitCostPaise: number },
): InventoryItemResponse {
  const reorder = numOr0(i.reorderLevel);
  return {
    id: i.id,
    sku: i.sku,
    name: i.name,
    category: i.category,
    unit: i.unit,
    reorderLevel: reorder,
    costingMethod: i.costingMethod,
    tracksBatches: i.tracksBatches,
    allowOverdraw: i.allowOverdraw,
    active: i.active,
    createdAt: i.createdAt.toISOString(),
    ...(balance
      ? {
          quantity: balance.quantity,
          avgUnitCostPaise: balance.avgUnitCostPaise,
          low: isLowStock(balance.quantity, reorder),
        }
      : {}),
  };
}

export function toSupplierResponse(s: Supplier): SupplierResponse {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    phone: s.phone,
    email: s.email,
    gstin: s.gstin,
    address: s.address,
    notes: s.notes,
    active: s.active,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toMovementResponse(m: StockMovement): StockMovementResponse {
  return {
    id: m.id,
    branchId: m.branchId,
    itemId: m.itemId,
    kind: m.kind,
    quantity: numOr0(m.quantity),
    unitCostPaise: num(m.unitCostPaise),
    batchNo: m.batchNo,
    expiryDate: dateStr(m.expiryDate),
    receiptId: m.receiptId,
    transferId: m.transferId,
    procedureRecordId: m.procedureRecordId,
    refType: m.refType,
    refId: m.refId,
    reason: m.reason,
    createdBy: m.createdBy,
    createdAt: m.createdAt.toISOString(),
    balanceAfter: num(m.balanceAfter),
  };
}

export function toTransferResponse(
  t: StockTransfer & { lines: StockTransferLine[] },
): StockTransferResponse {
  return {
    id: t.id,
    fromBranchId: t.fromBranchId,
    toBranchId: t.toBranchId,
    status: t.status,
    notes: t.notes,
    sentBy: t.sentBy,
    sentAt: t.sentAt.toISOString(),
    receivedBy: t.receivedBy,
    receivedAt: t.receivedAt ? t.receivedAt.toISOString() : null,
    lines: t.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      quantity: numOr0(l.quantity),
      batchNo: l.batchNo,
      expiryDate: dateStr(l.expiryDate),
      unitCostPaise: num(l.unitCostPaise),
      receivedQuantity: num(l.receivedQuantity),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Stock helpers shared by every write path
// ---------------------------------------------------------------------------------------------

/**
 * Serialises writers per (branch, item): transaction-scoped advisory locks taken in a fixed (sorted) order BEFORE any
 * movement is inserted. This makes FEFO planning read a stable ledger and keeps concurrent writers of overlapping item
 * sets away from deadlocks on the trigger's StockBalance row locks (every writer in this module locks first).
 */
export async function lockItems(
  tx: Tx,
  tenantId: string,
  branchId: string,
  itemIds: readonly string[],
): Promise<void> {
  for (const itemId of [...new Set(itemIds)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock:${tenantId}:${branchId}:${itemId}`}, 0))`;
}

export async function loadItems(
  tx: Tx,
  tenantId: string,
  itemIds: readonly string[],
): Promise<Map<string, InventoryItem>> {
  const ids = [...new Set(itemIds)];
  const rows = await tx.inventoryItem.findMany({ where: { tenantId, id: { in: ids } } });
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) if (!map.has(id)) throw notFound("item_not_found");
  return map;
}

export async function assertBranch(tx: Tx, tenantId: string, branchId: string): Promise<void> {
  const b = await tx.branch.findFirst({ where: { id: branchId, tenantId }, select: { id: true } });
  if (!b) throw notFound("branch_not_found");
}

export interface BatchBalance {
  batchNo: string | null;
  expiryDate: string | null;
  quantity: number;
}

/** Batch balances derived from the ledger (`SUM(quantity) GROUP BY batchNo`), batches with a number only. */
export async function batchBalances(
  tx: Tx,
  tenantId: string,
  branchId: string,
  itemId: string,
): Promise<BatchBalance[]> {
  const rows = await tx.$queryRaw<
    { batchNo: string; expiryDate: Date | null; quantity: number }[]
  >(Prisma.sql`
    SELECT m."batchNo", MAX(m."expiryDate") AS "expiryDate", SUM(m."quantity")::float8 AS "quantity"
    FROM "StockMovement" m
    WHERE m."tenantId" = ${tenantId}::uuid AND m."branchId" = ${branchId}::uuid
      AND m."itemId" = ${itemId}::uuid AND m."batchNo" IS NOT NULL
    GROUP BY m."batchNo"`);
  return rows.map((r) => ({
    batchNo: r.batchNo,
    expiryDate: r.expiryDate ? r.expiryDate.toISOString().slice(0, 10) : null,
    quantity: roundQuantity(Number(r.quantity)),
  }));
}

export async function balanceOf(
  tx: Tx,
  tenantId: string,
  branchId: string,
  itemId: string,
): Promise<{ quantity: number; avgUnitCostPaise: number }> {
  const b = await tx.stockBalance.findUnique({
    where: { tenantId_branchId_itemId: { tenantId, branchId, itemId } },
  });
  return { quantity: numOr0(b?.quantity), avgUnitCostPaise: numOr0(b?.avgUnitCostPaise) };
}

export interface IssuePick {
  batchNo: string | null;
  expiryDate: string | null;
  quantity: number;
}

/**
 * Plans an OUTFLOW of one item at one branch (consumption, waste, negative adjustment, transfer send): explicit-batch
 * requests are taken from that batch; the rest is picked first-expiry-first-out (`planFefoConsumption`, batches without
 * expiry last, stock that has no batch number after them). One pick per batch. Callers must hold `lockItems` for the
 * item. Not enough stock => 409 `insufficient_stock` (unless the item allows overdraw: the remainder is then booked
 * without a batch and the DB lets the balance go negative). The trigger re-checks everything (DB is the authority).
 */
export async function planIssue(
  tx: Tx,
  tenantId: string,
  branchId: string,
  item: Pick<InventoryItem, "id" | "tracksBatches" | "allowOverdraw">,
  requests: ReadonlyArray<{ quantity: number; batchNo?: string | undefined }>,
  fieldPath = "lines",
): Promise<IssuePick[]> {
  const total = roundQuantity(requests.reduce((a, r) => a + r.quantity, 0));
  const bal = await balanceOf(tx, tenantId, branchId, item.id);
  if (!item.tracksBatches) {
    if (requests.some((r) => r.batchNo !== undefined))
      throw badRequest(fieldPath, "Item does not track batches");
    if (!item.allowOverdraw && bal.quantity < total)
      throw conflict("insufficient_stock", {
        itemId: item.id,
        available: bal.quantity,
        needed: total,
      });
    return [{ batchNo: null, expiryDate: null, quantity: total }];
  }

  const batches = await batchBalances(tx, tenantId, branchId, item.id);
  const batchSum = batches.reduce((a, b) => a + b.quantity, 0);
  const unbatched = Math.max(0, roundQuantity(bal.quantity - batchSum));
  const pool = new Map<string, BatchBalance>(batches.map((b) => [b.batchNo as string, { ...b }]));
  const taken = new Map<string | null, IssuePick>();
  const add = (batchNo: string | null, expiryDate: string | null, quantity: number) => {
    const cur = taken.get(batchNo);
    if (cur) cur.quantity = roundQuantity(cur.quantity + quantity);
    else taken.set(batchNo, { batchNo, expiryDate, quantity: roundQuantity(quantity) });
  };

  let rest = 0;
  for (const r of requests) {
    if (r.batchNo === undefined) {
      rest = roundQuantity(rest + r.quantity);
      continue;
    }
    const b = pool.get(r.batchNo);
    if (!b) throw conflict("batch_not_found", { itemId: item.id, batchNo: r.batchNo });
    if (!item.allowOverdraw && b.quantity < r.quantity)
      throw conflict("insufficient_stock", {
        itemId: item.id,
        batchNo: r.batchNo,
        available: Math.max(0, b.quantity),
        needed: r.quantity,
      });
    b.quantity = roundQuantity(b.quantity - r.quantity);
    add(b.batchNo, b.expiryDate, r.quantity);
  }
  if (rest > 0) {
    const candidates: BatchBalance[] = [...pool.values()];
    if (unbatched > 0) candidates.push({ batchNo: null, expiryDate: null, quantity: unbatched });
    const plan = planFefoConsumption(candidates, rest);
    for (const pick of plan.picks) add(pick.batchNo, pick.expiryDate, pick.quantity);
    if (plan.shortfall > 0) {
      if (!item.allowOverdraw)
        throw conflict("insufficient_stock", {
          itemId: item.id,
          available: roundQuantity(rest - plan.shortfall),
          needed: rest,
        });
      add(null, null, plan.shortfall);
    }
  }
  return [...taken.values()];
}

/** Inserts one ledger row. The BEFORE INSERT trigger updates the balance and stamps cost + balanceAfter. */
export function insertMovement(
  tx: Tx,
  p: Pick<Principal, "tenantId" | "userId">,
  data: Omit<Prisma.StockMovementUncheckedCreateInput, "tenantId" | "createdBy">,
): Promise<StockMovement> {
  return tx.stockMovement.create({ data: { ...data, tenantId: p.tenantId, createdBy: p.userId } });
}

/** A batch number carries one expiry per item: a different date for an existing batch is refused. */
export async function assertBatchExpiry(
  tx: Tx,
  tenantId: string,
  itemId: string,
  batchNo: string,
  expiryDate: string,
): Promise<void> {
  const other = await tx.stockMovement.findFirst({
    where: { tenantId, itemId, batchNo, NOT: { expiryDate: toDate(expiryDate) } },
    select: { expiryDate: true },
  });
  if (other?.expiryDate)
    throw conflict("batch_expiry_conflict", {
      itemId,
      batchNo,
      expiryDate: dateStr(other.expiryDate),
    });
}
