import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, Tx } from "@dentalos/db";
import {
  type ApproveSettlementRequest,
  type CreateSettlementRequest,
  type ListSettlementsQuery,
  type PaySettlementRequest,
  type SettlementDetailResponse,
  resolveBillingSettings,
} from "@dentalos/validation";
import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan } from "../common/principal";
import {
  afterCursor,
  badRequest,
  canReadAllCompensation,
  canReadOwnCompensation,
  claimRequest,
  notFound,
  pageOf,
  runTx,
  toDate,
  toEntryResponse,
  toSettlementResponse,
} from "./commission-common";

/**
 * Settlement runs (ADR 0004 §7.4): per dentist and period [periodStart, periodEnd). Create collects every still-unsettled
 * ledger entry created before `periodEnd` (UTC midnight) into frozen items; approve (`compensation:settle`, a different
 * user when the `separateApprover` knob is on); pay writes the SETTLEMENT payout entry, then flips PAID.
 */
@Injectable()
export class SettlementsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private record(p: Principal, action: string, id: string) {
    return this.audit.record(p, {
      action,
      resource: "commission_settlement",
      resourceId: id,
      outcome: "success",
    });
  }

  private async lock(tx: Tx, p: Principal, id: string) {
    await tx.$queryRaw`SELECT "id" FROM "CommissionSettlement" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const s = await tx.commissionSettlement.findFirst({ where: { id, tenantId: p.tenantId } });
    if (!s) throw notFound("settlement_not_found");
    return s;
  }

  async create(p: Principal, body: CreateSettlementRequest) {
    assertCan(p, "compensation:manage");
    if (body.periodEnd <= body.periodStart)
      throw badRequest("periodEnd", "Must be after periodStart");
    const newId = randomUUID();
    const out = await runTx(this.prisma, p, async (tx) => {
      const replay = await claimRequest(
        tx,
        p,
        "commission.settlement",
        body.idempotencyKey,
        body,
        "CommissionSettlement",
        newId,
      );
      if (replay) {
        const s = await tx.commissionSettlement.findFirstOrThrow({
          where: { id: replay, tenantId: p.tenantId },
          include: { _count: { select: { items: true } } },
        });
        return { s, count: s._count.items, replay: true };
      }
      // Serialise settlement runs per dentist: a second run waits, then sees the first one's items as settled.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`settlement:${body.dentistUserId}`}, 0))`;
      const entries = await tx.commissionEntry.findMany({
        where: {
          tenantId: p.tenantId,
          dentistUserId: body.dentistUserId,
          kind: { not: "SETTLEMENT" },
          settlementItem: null,
          createdAt: { lt: toDate(body.periodEnd) },
        },
        select: { id: true, amountPaise: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const total = entries.reduce((a, e) => a + e.amountPaise, 0);
      if (entries.length === 0 || total <= 0)
        throw new ConflictException({
          error: "settlement_nothing_to_settle",
          unsettledEntries: entries.length,
          totalPaise: total,
        });
      const s = await tx.commissionSettlement.create({
        data: {
          id: newId,
          tenantId: p.tenantId,
          dentistUserId: body.dentistUserId,
          periodStart: toDate(body.periodStart),
          periodEnd: toDate(body.periodEnd),
          totalPaise: total,
          notes: body.notes || null,
          createdBy: p.userId,
        },
      });
      await tx.commissionSettlementItem.createMany({
        data: entries.map((e) => ({
          tenantId: p.tenantId,
          settlementId: s.id,
          entryId: e.id,
          amountPaise: e.amountPaise,
        })),
      });
      return { s, count: entries.length, replay: false };
    });
    if (!out.replay) await this.record(p, "commission.settlement.create", out.s.id);
    return toSettlementResponse(out.s, out.count);
  }

  async list(p: Principal, q: ListSettlementsQuery) {
    if (!canReadOwnCompensation(p)) throw new ForbiddenException();
    const all = canReadAllCompensation(p);
    if (!all && q.dentistUserId !== undefined && q.dentistUserId !== p.userId)
      throw new ForbiddenException();
    const dentist = all ? q.dentistUserId : p.userId;
    const and: Prisma.CommissionSettlementWhereInput[] = [afterCursor(q.cursor)];
    if (q.status) and.push({ status: q.status });
    if (q.from) and.push({ periodEnd: { gt: toDate(q.from) } });
    if (q.to) and.push({ periodStart: { lte: toDate(q.to) } });
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.commissionSettlement.findMany({
        where: { tenantId: p.tenantId, ...(dentist ? { dentistUserId: dentist } : {}), AND: and },
        include: { _count: { select: { items: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    return pageOf(rows, q.limit, (s) => toSettlementResponse(s, s._count.items));
  }

  async get(p: Principal, id: string): Promise<SettlementDetailResponse> {
    if (!canReadOwnCompensation(p)) throw new ForbiddenException();
    const s = await runTx(this.prisma, p, (tx) =>
      tx.commissionSettlement.findFirst({
        where: { id, tenantId: p.tenantId },
        include: {
          items: {
            include: { entry: { include: { settlementItem: { select: { id: true } } } } },
            orderBy: { entry: { createdAt: "asc" } },
          },
        },
      }),
    );
    // A dentist cannot tell another dentist's settlement from a missing one.
    if (!s || (!canReadAllCompensation(p) && s.dentistUserId !== p.userId))
      throw notFound("settlement_not_found");
    await this.record(p, "commission.settlement.read", id);
    return {
      ...toSettlementResponse(s, s.items.length),
      items: s.items.map((i) => ({
        id: i.id,
        entryId: i.entryId,
        amountPaise: i.amountPaise,
        entry: toEntryResponse(i.entry),
      })),
    };
  }

  async approve(p: Principal, id: string, body: ApproveSettlementRequest) {
    // `compensation:settle` is org-wide: assertCan covers the principal check, the route has @Can as well.
    assertCan(p, "compensation:settle");
    const s = await runTx(this.prisma, p, async (tx) => {
      const cur = await this.lock(tx, p, id);
      if (cur.status !== "DRAFT")
        throw new ConflictException({ error: "settlement_state", status: cur.status });
      const tenant = await tx.tenant.findUnique({
        where: { id: p.tenantId },
        select: { settings: true },
      });
      if (resolveBillingSettings(tenant?.settings).separateApprover && cur.createdBy === p.userId)
        throw new ConflictException({ error: "settlement_self_approval" });
      const sum = await tx.commissionSettlementItem.aggregate({
        where: { tenantId: p.tenantId, settlementId: id },
        _sum: { amountPaise: true },
      });
      if ((sum._sum.amountPaise ?? 0) !== cur.totalPaise)
        throw new ConflictException({ error: "settlement_total_mismatch" });
      return tx.commissionSettlement.update({
        where: { id },
        data: {
          status: "APPROVED",
          approvedBy: p.userId,
          approvedAt: new Date(),
          ...(body.note ? { notes: [cur.notes, body.note].filter(Boolean).join("\n") } : {}),
        },
      });
    });
    await this.record(p, "commission.settlement.approve", id);
    return toSettlementResponse(s);
  }

  /**
   * Marks the payout as made (outside the app) and writes the SETTLEMENT ledger entry (-total) before flipping PAID
   * (`settlement_guard` checks that entry exists). The entry's branch is the branch holding most of the settled amount.
   */
  async pay(p: Principal, id: string, body: PaySettlementRequest) {
    assertCan(p, "compensation:manage");
    const s = await runTx(this.prisma, p, async (tx) => {
      const cur = await this.lock(tx, p, id);
      if (cur.status !== "APPROVED")
        throw new ConflictException({ error: "settlement_state", status: cur.status });
      const paidAt = body.paidOn ? toDate(body.paidOn) : new Date();
      if (paidAt.getTime() > Date.now() + 86_400_000)
        throw badRequest("paidOn", "Must not be in the future");
      const items = await tx.commissionSettlementItem.findMany({
        where: { tenantId: p.tenantId, settlementId: id },
        select: { amountPaise: true, entry: { select: { branchId: true } } },
      });
      const byBranch = new Map<string, number>();
      for (const i of items)
        byBranch.set(i.entry.branchId, (byBranch.get(i.entry.branchId) ?? 0) + i.amountPaise);
      const branchId = [...byBranch.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      )[0]?.[0];
      if (!branchId) throw new ConflictException({ error: "settlement_nothing_to_settle" });
      await tx.commissionEntry.create({
        data: {
          tenantId: p.tenantId,
          branchId,
          dentistUserId: cur.dentistUserId,
          kind: "SETTLEMENT",
          amountPaise: -cur.totalPaise,
          baseAmountPaise: 0,
          settlementId: id,
          reason: body.paymentReference ? `payout ${body.paymentReference}` : "payout",
          createdBy: p.userId,
        },
      });
      return tx.commissionSettlement.update({
        where: { id },
        data: {
          status: "PAID",
          paidBy: p.userId,
          paidAt,
          paymentReference: body.paymentReference || null,
        },
      });
    });
    await this.record(p, "commission.settlement.pay", id);
    return toSettlementResponse(s);
  }

  /** Discards a DRAFT run (its entries become unsettled again). */
  async remove(p: Principal, id: string) {
    assertCan(p, "compensation:manage");
    await runTx(this.prisma, p, async (tx) => {
      const cur = await this.lock(tx, p, id);
      if (cur.status !== "DRAFT")
        throw new ConflictException({ error: "settlement_state", status: cur.status });
      await tx.commissionSettlementItem.deleteMany({
        where: { tenantId: p.tenantId, settlementId: id },
      });
      await tx.commissionSettlement.delete({ where: { id } });
    });
    await this.record(p, "commission.settlement.delete", id);
  }
}
