import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@dentalos/db";
import type {
  CreateCommissionAdjustmentRequest,
  DentistStatementQuery,
  DentistStatementResponse,
  ListCommissionEntriesQuery,
} from "@dentalos/validation";
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan } from "../common/principal";
import { type AccrualResult, accrueAllocation } from "./accrual";
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
} from "./commission-common";

const DAY_MS = 86_400_000;
/** Upper bound of entries embedded in a statement (the totals always cover the whole period). */
const STATEMENT_ENTRY_LIMIT = 1000;

/**
 * Commission ledger (ADR 0004 §7.3): list, manual adjustments, dentist statements, and the manual / recovery accrual
 * endpoint. compensation:read is SELF-scoped: a dentist sees only their own rows; org-wide accountants / owners see all.
 * Dates in queries are UTC calendar days.
 */
@Injectable()
export class LedgerService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** The dentist whose ledger the caller may read: themselves, or anyone for an org-wide reader. */
  private scopeDentist(p: Principal, requested: string | undefined): string | undefined {
    if (!canReadOwnCompensation(p)) throw new ForbiddenException();
    if (canReadAllCompensation(p)) return requested;
    if (requested !== undefined && requested !== p.userId) throw new ForbiddenException();
    return p.userId;
  }

  async listEntries(p: Principal, q: ListCommissionEntriesQuery) {
    const dentist = this.scopeDentist(p, q.dentistUserId);
    const and: Prisma.CommissionEntryWhereInput[] = [afterCursor(q.cursor)];
    if (q.branchId) and.push({ branchId: q.branchId });
    if (q.invoiceId) and.push({ invoiceId: q.invoiceId });
    if (q.kind) and.push({ kind: q.kind });
    if (q.settled === true)
      and.push({ OR: [{ settlementItem: { isNot: null } }, { kind: "SETTLEMENT" }] });
    if (q.settled === false) and.push({ settlementItem: null, kind: { not: "SETTLEMENT" } });
    if (q.from) and.push({ createdAt: { gte: toDate(q.from) } });
    if (q.to) and.push({ createdAt: { lt: new Date(toDate(q.to).getTime() + DAY_MS) } });
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.commissionEntry.findMany({
        where: { tenantId: p.tenantId, ...(dentist ? { dentistUserId: dentist } : {}), AND: and },
        include: { settlementItem: { select: { id: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    await this.audit.record(p, {
      action: "commission.entries.read",
      resource: "commission_entry",
      resourceId: dentist,
      outcome: "success",
    });
    return pageOf(rows, q.limit, toEntryResponse);
  }

  /** Manual correction: signed, reason required, replay-safe (`RequestDedupe` scope `commission.adjust`). */
  async adjust(p: Principal, body: CreateCommissionAdjustmentRequest) {
    assertCan(p, "compensation:manage");
    const newId = randomUUID();
    const entry = await runTx(this.prisma, p, async (tx) => {
      const replay = await claimRequest(
        tx,
        p,
        "commission.adjust",
        body.idempotencyKey,
        body,
        "CommissionEntry",
        newId,
      );
      if (replay)
        return {
          entry: await tx.commissionEntry.findFirstOrThrow({
            where: { id: replay, tenantId: p.tenantId },
            include: { settlementItem: { select: { id: true } } },
          }),
          replay: true,
        };
      const branch = await tx.branch.findFirst({
        where: { id: body.branchId, tenantId: p.tenantId },
        select: { id: true },
      });
      if (!branch) throw notFound("branch_not_found");
      const member = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId: p.tenantId, userId: body.dentistUserId } },
        select: { userId: true },
      });
      if (!member) throw badRequest("dentistUserId", "Not a member of this organisation");
      const created = await tx.commissionEntry.create({
        data: {
          id: newId,
          tenantId: p.tenantId,
          branchId: body.branchId,
          dentistUserId: body.dentistUserId,
          kind: "ADJUSTMENT",
          amountPaise: body.amountPaise,
          baseAmountPaise: 0,
          reason: body.reason,
          createdBy: p.userId,
        },
      });
      return { entry: { ...created, settlementItem: null }, replay: false };
    });
    if (!entry.replay)
      await this.audit.record(p, {
        action: "commission.adjustment.create",
        resource: "commission_entry",
        resourceId: entry.entry.id,
        branchId: entry.entry.branchId,
        outcome: "success",
      });
    return toEntryResponse(entry.entry);
  }

  async statement(p: Principal, q: DentistStatementQuery): Promise<DentistStatementResponse> {
    const dentist = this.scopeDentist(p, q.dentistUserId ?? p.userId) ?? p.userId;
    if (q.to < q.from) throw badRequest("to", "Must not be before from");
    const start = toDate(q.from);
    const end = new Date(toDate(q.to).getTime() + DAY_MS);
    const inPeriod: Prisma.CommissionEntryWhereInput = {
      tenantId: p.tenantId,
      dentistUserId: dentist,
      createdAt: { gte: start, lt: end },
      ...(q.branchId ? { branchId: q.branchId } : {}),
    };
    const { sums, balance, rows } = await runTx(this.prisma, p, async (tx) => {
      const [sums, balance, rows] = await Promise.all([
        tx.commissionEntry.groupBy({ by: ["kind"], where: inPeriod, _sum: { amountPaise: true } }),
        tx.commissionEntry.aggregate({
          where: { tenantId: p.tenantId, dentistUserId: dentist, createdAt: { lt: end } },
          _sum: { amountPaise: true },
        }),
        tx.commissionEntry.findMany({
          where: inPeriod,
          include: { settlementItem: { select: { id: true } } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: STATEMENT_ENTRY_LIMIT,
        }),
      ]);
      return { sums, balance, rows };
    });
    const sum = (k: string) => sums.find((s) => s.kind === k)?._sum.amountPaise ?? 0;
    const accruedPaise = sum("ACCRUAL");
    const reversedPaise = sum("REVERSAL");
    const adjustedPaise = sum("ADJUSTMENT");
    const settledPaise = sum("SETTLEMENT");
    await this.audit.record(p, {
      action: "commission.statement.read",
      resource: "commission_statement",
      resourceId: dentist,
      outcome: "success",
    });
    return {
      dentistUserId: dentist,
      from: q.from,
      to: q.to,
      accruedPaise,
      reversedPaise,
      adjustedPaise,
      settledPaise,
      netPaise: accruedPaise + reversedPaise + adjustedPaise + settledPaise,
      payableBalancePaise: balance._sum.amountPaise ?? 0,
      entries: rows.map(toEntryResponse),
    };
  }

  /** Manual / recovery accrual for one payment-allocation row (idempotent: replays write nothing). */
  async accrue(p: Principal, allocationId: string): Promise<AccrualResult> {
    assertCan(p, "compensation:manage");
    const r = await runTx(this.prisma, p, (tx) =>
      accrueAllocation(tx, p.tenantId, allocationId, p.userId),
    );
    if (r.status === "not_found") throw notFound("allocation_not_found");
    await this.audit.record(p, {
      action: "commission.accrue",
      resource: "payment_allocation",
      resourceId: allocationId,
      outcome: "success",
    });
    return r;
  }
}
