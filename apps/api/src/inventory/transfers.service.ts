import { randomUUID } from "node:crypto";
import type { InventoryItem, Prisma, PrismaClient, Tx } from "@dentalos/db";
import {
  type ListTransfersQuery,
  type ReceiveTransferRequest,
  type SendTransferRequest,
  roundQuantity,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, branchFilter } from "../auth/roles";
import { assertCan } from "../common/principal";
import {
  assertBranch,
  badRequest,
  balanceOf,
  claimRequest,
  conflict,
  decodeCursor,
  insertMovement,
  loadItems,
  lockItems,
  notFound,
  numOr0,
  pageOf,
  planIssue,
  runTx,
  toDate,
  toTransferResponse,
} from "./inventory-common";

/**
 * Inter-branch transfers (ADR 0004 §8): send writes one TRANSFER_OUT per (item, batch) at the source plus the lines
 * (carrying the weighted-average cost) and an IN_TRANSIT transfer; receive sets `receivedQuantity` per line, writes the
 * TRANSFER_IN rows at the destination (the DB guard: IN needs an OUT, IN <= OUT, IN cost = OUT cost) and flips RECEIVED.
 * A short receipt is allowed (received <= sent); the difference is a transit loss visible as sent vs received on the lines.
 */
@Injectable()
export class TransfersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private record(p: Principal, action: string, id: string, branchId: string) {
    return this.audit.record(p, {
      action,
      resource: "stock_transfer",
      resourceId: id,
      branchId,
      outcome: "success",
    });
  }

  /** Transfers the caller may see: either end inside their branch scope. */
  private scope(p: Principal): Prisma.StockTransferWhereInput {
    const ids = branchFilter(p);
    return ids === undefined
      ? {}
      : { OR: [{ fromBranchId: { in: ids } }, { toBranchId: { in: ids } }] };
  }

  async send(p: Principal, body: SendTransferRequest) {
    assertCan(p, "inventory:transfer", { branchId: body.fromBranchId });
    const newId = randomUUID();
    const out = await runTx(this.prisma, p, async (tx) => {
      const replay = await claimRequest(
        tx,
        p,
        "stock.transfer.send",
        body.idempotencyKey,
        body,
        "StockTransfer",
        newId,
      );
      if (replay) return { transfer: await this.load(tx, p, replay), replay: true };
      if (body.fromBranchId === body.toBranchId) throw conflict("transfer_same_branch");
      await assertBranch(tx, p.tenantId, body.fromBranchId);
      await assertBranch(tx, p.tenantId, body.toBranchId);
      const itemIds = body.lines.map((l) => l.itemId);
      const items = await loadItems(tx, p.tenantId, itemIds);
      for (const it of items.values())
        if (!it.active) throw conflict("item_inactive", { itemId: it.id });
      await lockItems(tx, p.tenantId, body.fromBranchId, itemIds);

      // Plan every item first (nothing is written when any item is short).
      const plans: {
        item: InventoryItem;
        picks: Awaited<ReturnType<typeof planIssue>>;
        cost: number;
      }[] = [];
      for (const itemId of [...new Set(itemIds)].sort()) {
        const item = items.get(itemId) as InventoryItem;
        const picks = await planIssue(
          tx,
          p.tenantId,
          body.fromBranchId,
          item,
          body.lines.filter((l) => l.itemId === itemId),
        );
        const bal = await balanceOf(tx, p.tenantId, body.fromBranchId, itemId);
        plans.push({ item, picks, cost: bal.avgUnitCostPaise });
      }

      await tx.stockTransfer.create({
        data: {
          id: newId,
          tenantId: p.tenantId,
          fromBranchId: body.fromBranchId,
          toBranchId: body.toBranchId,
          notes: body.notes || null,
          sentBy: p.userId,
        },
      });
      for (const { item, picks, cost } of plans) {
        for (const pick of picks)
          await tx.stockTransferLine.create({
            data: {
              tenantId: p.tenantId,
              transferId: newId,
              itemId: item.id,
              quantity: pick.quantity,
              batchNo: pick.batchNo,
              expiryDate: pick.expiryDate ? toDate(pick.expiryDate) : null,
              unitCostPaise: cost,
            },
          });
        for (const pick of picks)
          await insertMovement(tx, p, {
            branchId: body.fromBranchId,
            itemId: item.id,
            kind: "TRANSFER_OUT",
            quantity: -pick.quantity,
            batchNo: pick.batchNo,
            expiryDate: pick.expiryDate ? toDate(pick.expiryDate) : null,
            transferId: newId,
          });
      }
      return { transfer: await this.load(tx, p, newId), replay: false };
    });
    if (!out.replay) await this.record(p, "inventory.transfer.send", newId, body.fromBranchId);
    return toTransferResponse(out.transfer);
  }

  private async load(tx: Tx, p: Principal, id: string) {
    const t = await tx.stockTransfer.findFirst({
      where: { id, tenantId: p.tenantId },
      include: { lines: { orderBy: [{ itemId: "asc" }, { batchNo: "asc" }, { id: "asc" }] } },
    });
    if (!t) throw notFound("transfer_not_found");
    return t;
  }

  /** Visible only when an end of the transfer is in the caller's scope (otherwise 404, no oracle). */
  private inScope(p: Principal, t: { fromBranchId: string; toBranchId: string }): boolean {
    const ids = branchFilter(p);
    return ids === undefined || ids.includes(t.fromBranchId) || ids.includes(t.toBranchId);
  }

  async list(p: Principal, q: ListTransfersQuery) {
    const and: Prisma.StockTransferWhereInput[] = [this.scope(p)];
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      and.push({
        OR: [{ sentAt: { lt: c.createdAt } }, { sentAt: c.createdAt, id: { lt: c.id } }],
      });
    }
    if (q.fromBranchId) and.push({ fromBranchId: q.fromBranchId });
    if (q.toBranchId) and.push({ toBranchId: q.toBranchId });
    if (q.status) and.push({ status: q.status });
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.stockTransfer.findMany({
        where: { tenantId: p.tenantId, AND: and },
        include: { lines: { orderBy: [{ itemId: "asc" }, { batchNo: "asc" }, { id: "asc" }] } },
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    // Rows are ordered by sentAt (== createdAt of the dispatch); the generic cursor uses createdAt, so map it.
    return pageOf(
      rows.map((r) => ({ ...r, createdAt: r.sentAt })),
      q.limit,
      toTransferResponse,
    );
  }

  async get(p: Principal, id: string) {
    const t = await runTx(this.prisma, p, (tx) => this.load(tx, p, id));
    if (!this.inScope(p, t)) throw notFound("transfer_not_found");
    return toTransferResponse(t);
  }

  /** Receive at the destination. Omitted lines are received as sent. */
  async receive(p: Principal, id: string, body: ReceiveTransferRequest) {
    const out = await runTx(this.prisma, p, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "StockTransfer" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const t = await this.load(tx, p, id);
      if (!this.inScope(p, t)) throw notFound("transfer_not_found");
      assertCan(p, "inventory:transfer", { branchId: t.toBranchId });
      if (t.status !== "IN_TRANSIT") throw conflict("stock_transfer_state", { status: t.status });

      const requested = new Map<string, number>();
      for (const l of body.lines ?? []) {
        if (!t.lines.some((x) => x.id === l.lineId))
          throw badRequest("lines", "Line does not belong to this transfer");
        requested.set(l.lineId, roundQuantity(l.receivedQuantity));
      }
      const plan = t.lines.map((l) => {
        const sent = numOr0(l.quantity);
        const got = requested.get(l.id) ?? sent;
        if (got > sent)
          throw conflict("receive_exceeds_sent", { lineId: l.id, sent, received: got });
        return { line: l, sent, got };
      });
      await lockItems(
        tx,
        p.tenantId,
        t.toBranchId,
        t.lines.map((l) => l.itemId),
      );
      for (const { line, got } of plan)
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { receivedQuantity: got },
        });
      for (const { line, got } of [...plan].sort((a, b) =>
        a.line.itemId === b.line.itemId
          ? a.line.id < b.line.id
            ? -1
            : 1
          : a.line.itemId < b.line.itemId
            ? -1
            : 1,
      ))
        if (got > 0)
          await insertMovement(tx, p, {
            branchId: t.toBranchId,
            itemId: line.itemId,
            kind: "TRANSFER_IN",
            quantity: got,
            unitCostPaise: line.unitCostPaise ? numOr0(line.unitCostPaise) : null,
            batchNo: line.batchNo,
            expiryDate: line.expiryDate,
            transferId: t.id,
            reason: body.notes || null,
          });
      await tx.stockTransfer.update({
        where: { id: t.id },
        data: { status: "RECEIVED", receivedBy: p.userId, receivedAt: new Date() },
      });
      return { transfer: await this.load(tx, p, t.id), toBranchId: t.toBranchId };
    });
    await this.record(p, "inventory.transfer.receive", id, out.toBranchId);
    return toTransferResponse(out.transfer);
  }
}
