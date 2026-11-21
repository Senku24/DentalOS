import { randomUUID } from "node:crypto";
import { type Prisma, PrismaClient, type Tx } from "@dentalos/db";
import {
  type AdjustPatientCreditRequest,
  INVOICE_OPEN_STATUSES,
  INVOICE_OUTSTANDING_STATUSES,
  type IssueAdjustmentRequest,
  type ListAdjustmentsQuery,
  type PatientStatementQuery,
  financialYearOf,
  formatDocumentNumber,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan, branchWhere } from "../common/principal";
import { findPatientOr404 } from "../patients/patient-common";
import {
  allocateSeq,
  badRequest,
  claimDedupe,
  conflict,
  dayAfter,
  dayStartInZone,
  decodeCursor,
  encodeCursor,
  findInvoiceScoped,
  loadBranchSettings,
  lockInvoice,
  notFound,
  requestHash,
  runTx,
  toAdjustmentResponse,
  toInvoiceSummary,
} from "./billing-common";

const iso = (d: Date) => d.toISOString();

/**
 * Credit / debit notes (the only correction of an issued invoice), the patient's advance ledger adjustments and the
 * patient account statement (ADR 0004 §4.3, §4.5, §4.7).
 */
@Injectable()
export class AccountService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Credit / debit notes
  // -------------------------------------------------------------------------------------------

  async issueAdjustment(p: Principal, invoiceId: string, body: IssueAdjustmentRequest) {
    const out = await runTx(
      this.prisma,
      p,
      async (tx) => {
        const probe = await findInvoiceScoped(tx, p, invoiceId);
        assertCan(p, "invoice:adjust", { branchId: probe.branchId });
        const id = randomUUID();
        const replay = await claimDedupe(tx, p, {
          scope: "invoice.adjust",
          key: body.idempotencyKey,
          hash: requestHash({ invoiceId, ...body }),
          refType: "adjustment",
          refId: id,
        });
        if (replay) {
          const a = await tx.invoiceAdjustment.findUnique({ where: { id: replay } });
          if (!a) throw notFound("invoice_not_found");
          return { replay: true as const, adj: a };
        }
        if ((body.taxPaise ?? 0) > body.amountPaise) throw badRequest("tax_exceeds_amount");
        await lockInvoice(tx, invoiceId);
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
        if (!(INVOICE_OPEN_STATUSES as readonly string[]).includes(inv.status))
          throw conflict("invoice_not_adjustable", { status: inv.status });
        if (body.kind === "CREDIT" && body.amountPaise > inv.balancePaise)
          throw conflict("invoice_overpaid", { balancePaise: inv.balancePaise });
        const { branch } = await loadBranchSettings(tx, p.tenantId, inv.branchId);
        const now = new Date();
        const fy = financialYearOf(now, branch.timezone);
        const series = body.kind === "CREDIT" ? "CN" : "DN";
        const seq = await allocateSeq(tx, p.tenantId, branch.id, series, fy);
        const adj = await tx.invoiceAdjustment.create({
          data: {
            id,
            tenantId: p.tenantId,
            branchId: inv.branchId,
            patientId: inv.patientId,
            invoiceId,
            kind: body.kind,
            number: formatDocumentNumber({
              branchCode: branch.code,
              financialYear: fy,
              seq,
              series,
            }),
            amountPaise: body.amountPaise,
            taxPaise: body.taxPaise ?? 0,
            reason: body.reason,
            issuedBy: p.userId,
            issuedAt: now,
          },
        });
        await tx.financeLedgerEntry.create({
          data: {
            tenantId: p.tenantId,
            branchId: inv.branchId,
            patientId: inv.patientId,
            kind: body.kind === "CREDIT" ? "CREDIT_NOTE" : "DEBIT_NOTE",
            amountPaise: body.kind === "CREDIT" ? -body.amountPaise : body.amountPaise,
            invoiceId,
            adjustmentId: id,
            occurredAt: now,
            createdBy: p.userId,
          },
        });
        return { replay: false as const, adj: adj };
      },
      { retryUnique: true },
    );
    if (!out.replay)
      await this.audit.record(p, {
        action: "adjustment.issue",
        resource: "invoice_adjustment",
        resourceId: out.adj.id,
        branchId: out.adj.branchId,
        outcome: "success",
      });
    return toAdjustmentResponse(out.adj);
  }

  async listAdjustments(p: Principal, q: ListAdjustmentsQuery) {
    return runTx(this.prisma, p, async (tx) => {
      const and: Prisma.InvoiceAdjustmentWhereInput[] = [branchWhere(p)];
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.patientId) and.push({ patientId: q.patientId });
      if (q.invoiceId) and.push({ invoiceId: q.invoiceId });
      if (q.kind) and.push({ kind: q.kind });
      if (q.from || q.to)
        and.push({
          issuedAt: {
            ...(q.from ? { gte: dayStartInZone(q.from) } : {}),
            ...(q.to ? { lt: dayStartInZone(dayAfter(q.to)) } : {}),
          },
        });
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        and.push({
          OR: [{ issuedAt: { lt: c.createdAt } }, { issuedAt: c.createdAt, id: { lt: c.id } }],
        });
      }
      const rows = await tx.invoiceAdjustment.findMany({
        where: { AND: and },
        orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toAdjustmentResponse),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.issuedAt, last.id) : null,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Patient advance
  // -------------------------------------------------------------------------------------------

  private async creditView(tx: Tx, p: Principal, patientId: string, limit: number) {
    await findPatientOr404(tx, patientId);
    const sum = await tx.patientCreditEntry.aggregate({
      where: { patientId },
      _sum: { amountPaise: true },
    });
    const rows = await tx.patientCreditEntry.findMany({
      where: { AND: [{ patientId }, branchWhere(p)] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    return {
      patientId,
      balancePaise: sum._sum.amountPaise ?? 0,
      entries: rows.map((e) => ({
        id: e.id,
        patientId: e.patientId,
        branchId: e.branchId,
        kind: e.kind,
        amountPaise: e.amountPaise,
        paymentId: e.paymentId,
        allocationId: e.allocationId,
        refundId: e.refundId,
        reason: e.reason,
        createdBy: e.createdBy,
        createdAt: iso(e.createdAt),
      })),
    };
  }

  getCredit(p: Principal, patientId: string, limit = 50) {
    return runTx(this.prisma, p, (tx) => this.creditView(tx, p, patientId, limit));
  }

  /** Manual correction of the advance balance: reason required, never below zero (DB), audited. */
  async adjustCredit(p: Principal, patientId: string, body: AdjustPatientCreditRequest) {
    assertCan(p, "invoice:adjust", { branchId: body.branchId });
    const out = await runTx(
      this.prisma,
      p,
      async (tx) => {
        await findPatientOr404(tx, patientId);
        const replay = await claimDedupe(tx, p, {
          scope: "credit.adjust",
          key: body.idempotencyKey,
          hash: requestHash({ patientId, ...body }),
          refType: "patient",
          refId: patientId,
        });
        if (!replay) {
          if (!(await tx.branch.findUnique({ where: { id: body.branchId } })))
            throw notFound("branch_not_found");
          await tx.patientCreditEntry.create({
            data: {
              tenantId: p.tenantId,
              patientId,
              branchId: body.branchId,
              kind: "ADJUSTMENT",
              amountPaise: body.amountPaise,
              reason: body.reason,
              createdBy: p.userId,
            },
          });
        }
        return { replay: Boolean(replay), view: await this.creditView(tx, p, patientId, 50) };
      },
      { retryUnique: true },
    );
    if (!out.replay)
      await this.audit.record(p, {
        action: "credit.adjust",
        resource: "patient",
        resourceId: patientId,
        branchId: body.branchId,
        outcome: "success",
      });
    return out.view;
  }

  // -------------------------------------------------------------------------------------------
  // Statement
  // -------------------------------------------------------------------------------------------

  async statement(p: Principal, patientId: string, q: Omit<PatientStatementQuery, "patientId">) {
    const res = await runTx(this.prisma, p, async (tx) => {
      await findPatientOr404(tx, patientId);
      if (q.branchId) assertCan(p, "finance:report", { branchId: q.branchId });
      const scope: Prisma.FinanceLedgerEntryWhereInput[] = [
        { patientId },
        branchWhere(p),
        ...(q.branchId ? [{ branchId: q.branchId }] : []),
      ];
      const fromAt = q.from ? dayStartInZone(q.from) : undefined;
      const toAt = q.to ? dayStartInZone(dayAfter(q.to)) : undefined;
      const opening = fromAt
        ? ((
            await tx.financeLedgerEntry.aggregate({
              where: { AND: [...scope, { occurredAt: { lt: fromAt } }] },
              _sum: { amountPaise: true },
            })
          )._sum.amountPaise ?? 0)
        : 0;
      const rows = await tx.financeLedgerEntry.findMany({
        where: {
          AND: [
            ...scope,
            ...(fromAt || toAt
              ? [
                  {
                    occurredAt: {
                      ...(fromAt ? { gte: fromAt } : {}),
                      ...(toAt ? { lt: toAt } : {}),
                    },
                  },
                ]
              : []),
          ],
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: 2000,
      });
      let running = opening;
      const entries = rows.map((e) => {
        running += e.amountPaise;
        return {
          id: e.id,
          branchId: e.branchId,
          patientId: e.patientId,
          kind: e.kind,
          amountPaise: e.amountPaise,
          invoiceId: e.invoiceId,
          paymentId: e.paymentId,
          refundId: e.refundId,
          adjustmentId: e.adjustmentId,
          occurredAt: iso(e.occurredAt),
          createdBy: e.createdBy,
          runningBalancePaise: running,
        };
      });
      const outstanding = await tx.invoice.findMany({
        where: {
          AND: [
            {
              patientId,
              status: { in: [...INVOICE_OUTSTANDING_STATUSES] as ("ISSUED" | "PARTIALLY_PAID")[] },
            },
            branchWhere(p),
            ...(q.branchId ? [{ branchId: q.branchId }] : []),
          ],
        },
        orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
        include: { patient: { select: { firstName: true, lastName: true } } },
      });
      const advance = await tx.patientCreditEntry.aggregate({
        where: { patientId },
        _sum: { amountPaise: true },
      });
      return {
        patientId,
        from: q.from ?? null,
        to: q.to ?? null,
        openingBalancePaise: opening,
        entries,
        closingBalancePaise: running,
        outstandingInvoices: outstanding.map(toInvoiceSummary),
        advanceBalancePaise: advance._sum.amountPaise ?? 0,
      };
    });
    await this.audit.record(p, {
      action: "statement.read",
      resource: "patient",
      resourceId: patientId,
      branchId: q.branchId,
      outcome: "success",
    });
    return res;
  }
}
