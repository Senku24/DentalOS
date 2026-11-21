import { randomUUID } from "node:crypto";
import type { InventoryItem, Prisma, PrismaClient, StockMovement, Tx } from "@dentalos/db";
import {
  type AdjustStockRequest,
  type ConsumeStockRequest,
  type ListStockMovementsQuery,
  type ListStockReceiptsQuery,
  type ReceiveStockRequest,
  type RecordWasteRequest,
  roundQuantity,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan, branchWhere } from "../common/principal";
import {
  DAY_MS,
  type IssuePick,
  afterCursor,
  assertBatchExpiry,
  assertBranch,
  badRequest,
  balanceOf,
  claimRequest,
  conflict,
  insertMovement,
  loadItems,
  lockItems,
  notFound,
  pageOf,
  planIssue,
  runTx,
  toDate,
  toMovementResponse,
} from "./inventory-common";

/**
 * The stock ledger writers (ADR 0004 §8): receipts, consumption (FEFO), adjustments, waste. Only `StockMovement` rows are
 * written; the DB trigger keeps `StockBalance` + weighted-average cost in step and refuses a negative balance (unless the
 * item allows overdraw). Every write inserts its RequestDedupe row first (replay-safe) and takes the per-(branch,item)
 * advisory locks before planning, so concurrent consumption can never drive a balance below zero or split a batch twice.
 */
@Injectable()
export class StockService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private record(p: Principal, action: string, resource: string, id: string, branchId: string) {
    return this.audit.record(p, { action, resource, resourceId: id, branchId, outcome: "success" });
  }

  // -------------------------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------------------------

  private async loadReceipt(tx: Tx, p: Principal, id: string) {
    const r = await tx.stockReceipt.findFirst({
      where: { id, tenantId: p.tenantId },
      include: { movements: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    if (!r) throw notFound("receipt_not_found");
    return r;
  }

  private receiptResponse(r: Awaited<ReturnType<StockService["loadReceipt"]>>) {
    return {
      id: r.id,
      branchId: r.branchId,
      supplierId: r.supplierId,
      reference: r.reference,
      receivedOn: r.receivedOn.toISOString().slice(0, 10),
      totalCostPaise: r.totalCostPaise,
      notes: r.notes,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      movements: r.movements.map(toMovementResponse),
    };
  }

  async receive(p: Principal, body: ReceiveStockRequest) {
    assertCan(p, "inventory:write", { branchId: body.branchId });
    const newId = randomUUID();
    const out = await runTx(this.prisma, p, async (tx) => {
      const replay = await claimRequest(
        tx,
        p,
        "stock.receive",
        body.idempotencyKey,
        body,
        "StockReceipt",
        newId,
      );
      if (replay) return { receipt: await this.loadReceipt(tx, p, replay), replay: true };
      await assertBranch(tx, p.tenantId, body.branchId);
      if (body.supplierId) {
        const s = await tx.supplier.findFirst({
          where: { id: body.supplierId, tenantId: p.tenantId },
          select: { active: true },
        });
        if (!s) throw notFound("supplier_not_found");
        if (!s.active) throw conflict("supplier_inactive");
      }
      const items = await loadItems(
        tx,
        p.tenantId,
        body.lines.map((l) => l.itemId),
      );
      body.lines.forEach((l, i) => {
        const item = items.get(l.itemId) as InventoryItem;
        if (!item.active) throw conflict("item_inactive", { itemId: item.id });
        if (item.tracksBatches) {
          if (!l.batchNo || !l.expiryDate)
            throw conflict("batch_required", { itemId: item.id, field: `lines.${i}` });
        } else if (l.batchNo || l.expiryDate) {
          throw badRequest(`lines.${i}.batchNo`, "Item does not track batches");
        }
      });
      await lockItems(
        tx,
        p.tenantId,
        body.branchId,
        body.lines.map((l) => l.itemId),
      );
      for (const l of body.lines)
        if (l.batchNo && l.expiryDate)
          await assertBatchExpiry(tx, p.tenantId, l.itemId, l.batchNo, l.expiryDate);
      const total = body.lines.reduce((a, l) => a + Math.round(l.quantity * l.unitCostPaise), 0);
      await tx.stockReceipt.create({
        data: {
          id: newId,
          tenantId: p.tenantId,
          branchId: body.branchId,
          supplierId: body.supplierId ?? null,
          reference: body.reference || null,
          receivedOn: toDate(body.receivedOn),
          totalCostPaise: total,
          notes: body.notes || null,
          createdBy: p.userId,
        },
      });
      // Fixed order (item, then request order) keeps the trigger's balance-row locks consistent across writers.
      const ordered = body.lines
        .map((l, i) => ({ l, i }))
        .sort((a, b) => (a.l.itemId === b.l.itemId ? a.i - b.i : a.l.itemId < b.l.itemId ? -1 : 1));
      for (const { l } of ordered)
        await insertMovement(tx, p, {
          branchId: body.branchId,
          itemId: l.itemId,
          kind: "RECEIPT",
          quantity: l.quantity,
          unitCostPaise: l.unitCostPaise,
          batchNo: l.batchNo ?? null,
          expiryDate: l.expiryDate ? toDate(l.expiryDate) : null,
          receiptId: newId,
        });
      return { receipt: await this.loadReceipt(tx, p, newId), replay: false };
    });
    if (!out.replay)
      await this.record(
        p,
        "inventory.receipt.create",
        "stock_receipt",
        out.receipt.id,
        body.branchId,
      );
    return this.receiptResponse(out.receipt);
  }

  async listReceipts(p: Principal, q: ListStockReceiptsQuery) {
    if (q.branchId) assertCan(p, "inventory:read", { branchId: q.branchId });
    const and: Prisma.StockReceiptWhereInput[] = [afterCursor(q.cursor), branchWhere(p)];
    if (q.branchId) and.push({ branchId: q.branchId });
    if (q.supplierId) and.push({ supplierId: q.supplierId });
    if (q.from) and.push({ receivedOn: { gte: toDate(q.from) } });
    if (q.to) and.push({ receivedOn: { lte: toDate(q.to) } });
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.stockReceipt.findMany({
        where: { tenantId: p.tenantId, AND: and },
        include: { movements: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    return pageOf(rows, q.limit, (r) => this.receiptResponse(r));
  }

  async getReceipt(p: Principal, id: string) {
    const r = await runTx(this.prisma, p, (tx) => this.loadReceipt(tx, p, id));
    assertCan(p, "inventory:read", { branchId: r.branchId });
    return this.receiptResponse(r);
  }

  // -------------------------------------------------------------------------------------------
  // Outflows: consumption, waste, negative adjustment
  // -------------------------------------------------------------------------------------------

  /** Plans and writes the outflow of every item of a request; returns the movements in write order. */
  private async issue(
    tx: Tx,
    p: Principal,
    kind: "CONSUMPTION" | "WASTE" | "ADJUSTMENT",
    branchId: string,
    lines: ReadonlyArray<{ itemId: string; quantity: number; batchNo?: string | undefined }>,
    meta: {
      reason?: string | undefined;
      procedureRecordId?: string | undefined;
      requestId: string;
    },
    allowInactive: boolean,
  ): Promise<StockMovement[]> {
    const items = await loadItems(
      tx,
      p.tenantId,
      lines.map((l) => l.itemId),
    );
    if (!allowInactive)
      for (const it of items.values())
        if (!it.active) throw conflict("item_inactive", { itemId: it.id });
    await lockItems(
      tx,
      p.tenantId,
      branchId,
      lines.map((l) => l.itemId),
    );
    const written: StockMovement[] = [];
    for (const itemId of [...new Set(lines.map((l) => l.itemId))].sort()) {
      const item = items.get(itemId) as InventoryItem;
      const picks: IssuePick[] = await planIssue(
        tx,
        p.tenantId,
        branchId,
        item,
        lines.filter((l) => l.itemId === itemId),
      );
      for (const pick of picks)
        written.push(
          await insertMovement(tx, p, {
            branchId,
            itemId,
            kind,
            quantity: -pick.quantity,
            batchNo: pick.batchNo,
            expiryDate: pick.expiryDate ? toDate(pick.expiryDate) : null,
            procedureRecordId: meta.procedureRecordId ?? null,
            reason: meta.reason || null,
            refType: kind,
            refId: meta.requestId,
          }),
        );
    }
    return written;
  }

  private replayMovements(tx: Tx, p: Principal, kind: string, refId: string) {
    return tx.stockMovement.findMany({
      where: { tenantId: p.tenantId, refType: kind, refId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async consume(p: Principal, body: ConsumeStockRequest) {
    assertCan(p, "inventory:write", { branchId: body.branchId });
    const requestId = randomUUID();
    const out = await runTx(this.prisma, p, async (tx) => {
      const replay = await claimRequest(
        tx,
        p,
        "stock.consume",
        body.idempotencyKey,
        body,
        "StockMovement",
        requestId,
      );
      if (replay)
        return {
          movements: await this.replayMovements(tx, p, "CONSUMPTION", replay),
          replay: true,
        };
      await assertBranch(tx, p.tenantId, body.branchId);
      if (body.procedureRecordId) {
        const proc = await tx.procedureRecord.findFirst({
          where: { id: body.procedureRecordId, tenantId: p.tenantId },
          select: { encounter: { select: { branchId: true } } },
        });
        if (!proc) throw notFound("procedure_record_not_found");
        if (proc.encounter.branchId !== body.branchId) throw conflict("procedure_branch_mismatch");
      }
      const movements = await this.issue(
        tx,
        p,
        "CONSUMPTION",
        body.branchId,
        body.lines,
        { reason: body.reason, procedureRecordId: body.procedureRecordId, requestId },
        false,
      );
      return { movements, replay: false };
    });
    if (!out.replay)
      await this.record(
        p,
        "inventory.consumption.create",
        "stock_movement",
        requestId,
        body.branchId,
      );
    return { movements: out.movements.map(toMovementResponse) };
  }

  async waste(p: Principal, body: RecordWasteRequest) {
    assertCan(p, "inventory:adjust", { branchId: body.branchId });
    const requestId = randomUUID();
    const out = await runTx(this.prisma, p, async (tx) => {
      const replay = await claimRequest(
        tx,
        p,
        "stock.waste",
        body.idempotencyKey,
        body,
        "StockMovement",
        requestId,
      );
      if (replay)
        return { movements: await this.replayMovements(tx, p, "WASTE", replay), replay: true };
      await assertBranch(tx, p.tenantId, body.branchId);
      const movements = await this.issue(
        tx,
        p,
        "WASTE",
        body.branchId,
        [{ itemId: body.itemId, quantity: body.quantity, batchNo: body.batchNo }],
        { reason: body.reason, requestId },
        true,
      );
      return { movements, replay: false };
    });
    if (!out.replay)
      await this.record(p, "inventory.waste.create", "stock_movement", requestId, body.branchId);
    return { movements: out.movements.map(toMovementResponse) };
  }

  /** Count correction: a negative delta is an outflow (FEFO when no batch is named); a positive one is stock written on. */
  async adjust(p: Principal, body: AdjustStockRequest) {
    assertCan(p, "inventory:adjust", { branchId: body.branchId });
    const requestId = randomUUID();
    const out = await runTx(this.prisma, p, async (tx) => {
      const replay = await claimRequest(
        tx,
        p,
        "stock.adjust",
        body.idempotencyKey,
        body,
        "StockMovement",
        requestId,
      );
      if (replay)
        return { movements: await this.replayMovements(tx, p, "ADJUSTMENT", replay), replay: true };
      await assertBranch(tx, p.tenantId, body.branchId);
      if (body.delta < 0) {
        const movements = await this.issue(
          tx,
          p,
          "ADJUSTMENT",
          body.branchId,
          [{ itemId: body.itemId, quantity: roundQuantity(-body.delta), batchNo: body.batchNo }],
          { reason: body.reason, requestId },
          true,
        );
        return { movements, replay: false };
      }
      const items = await loadItems(tx, p.tenantId, [body.itemId]);
      const item = items.get(body.itemId) as InventoryItem;
      if (!item.active) throw conflict("item_inactive", { itemId: item.id });
      if (item.tracksBatches) {
        if (!body.batchNo || !body.expiryDate)
          throw conflict("batch_required", { itemId: item.id });
      } else if (body.batchNo || body.expiryDate) {
        throw badRequest("batchNo", "Item does not track batches");
      }
      await lockItems(tx, p.tenantId, body.branchId, [body.itemId]);
      if (body.batchNo && body.expiryDate)
        await assertBatchExpiry(tx, p.tenantId, item.id, body.batchNo, body.expiryDate);
      const bal = await balanceOf(tx, p.tenantId, body.branchId, item.id);
      if (body.unitCostPaise === undefined && bal.avgUnitCostPaise === 0)
        throw conflict("unit_cost_required", { itemId: item.id });
      const m = await insertMovement(tx, p, {
        branchId: body.branchId,
        itemId: item.id,
        kind: "ADJUSTMENT",
        quantity: body.delta,
        unitCostPaise: body.unitCostPaise ?? null,
        batchNo: body.batchNo ?? null,
        expiryDate: body.expiryDate ? toDate(body.expiryDate) : null,
        reason: body.reason,
        refType: "ADJUSTMENT",
        refId: requestId,
      });
      return { movements: [m], replay: false };
    });
    if (!out.replay)
      await this.record(
        p,
        "inventory.adjustment.create",
        "stock_movement",
        requestId,
        body.branchId,
      );
    return { movements: out.movements.map(toMovementResponse) };
  }

  // -------------------------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------------------------

  async listMovements(p: Principal, q: ListStockMovementsQuery) {
    if (q.branchId) assertCan(p, "inventory:read", { branchId: q.branchId });
    const and: Prisma.StockMovementWhereInput[] = [afterCursor(q.cursor), branchWhere(p)];
    if (q.branchId) and.push({ branchId: q.branchId });
    if (q.itemId) and.push({ itemId: q.itemId });
    if (q.kind) and.push({ kind: q.kind });
    if (q.procedureRecordId) and.push({ procedureRecordId: q.procedureRecordId });
    if (q.from) and.push({ createdAt: { gte: toDate(q.from) } });
    if (q.to) and.push({ createdAt: { lt: new Date(toDate(q.to).getTime() + DAY_MS) } });
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.stockMovement.findMany({
        where: { tenantId: p.tenantId, AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    return pageOf(rows, q.limit, toMovementResponse);
  }
}
