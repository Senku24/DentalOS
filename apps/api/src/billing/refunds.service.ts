import { randomUUID } from "node:crypto";
import { type Prisma, PrismaClient, type Refund, type Tx } from "@dentalos/db";
import {
  type ApproveRefundRequest,
  type ListRefundsQuery,
  NOTIFICATION_QUEUES,
  type ProcessRefundRequest,
  type RejectRefundRequest,
  type RequestRefundRequest,
  refundNeedsApproval,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { JobQueueService } from "../common/job-queue.service";
import { assertCan, branchWhere } from "../common/principal";
import {
  advisoryLock,
  conflict,
  dayAfter,
  dayStartInZone,
  decodeCursor,
  encodeCursor,
  findInvoiceScoped,
  findPaymentScoped,
  findRefundScoped,
  fireAndLog,
  loadBranchSettings,
  lockPayment,
  runTx,
  toRefundResponse,
} from "./billing-common";
import type { Writer } from "./payment-core";

/**
 * Money out of a RECORDED payment: request -> (approve above the threshold) -> process (ADR 0004 §4.4). Payments are
 * never reversed: the refund's reversal allocation reopens the invoice, an advance refund spends the credit.
 */
@Injectable()
export class RefundsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {}

  private record(p: Principal, action: string, id: string, branchId: string) {
    return this.audit.record(p, {
      action,
      resource: "refund",
      resourceId: id,
      branchId,
      outcome: "success",
    });
  }

  /** Locks Payment then Refund (the lock order everywhere) and re-reads the refund. */
  private async lockRefund(tx: Tx, refund: Refund): Promise<Refund> {
    await lockPayment(tx, refund.paymentId);
    await tx.$queryRaw`SELECT 1 FROM "Refund" WHERE "id" = ${refund.id}::uuid FOR UPDATE`;
    return tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
  }

  async request(p: Principal, body: RequestRefundRequest) {
    const out = await runTx(
      this.prisma,
      p,
      async (tx) => {
        await advisoryLock(tx, `refund:${p.tenantId}:${body.idempotencyKey}`);
        const existing = await tx.refund.findUnique({
          where: {
            tenantId_idempotencyKey: { tenantId: p.tenantId, idempotencyKey: body.idempotencyKey },
          },
        });
        if (existing) {
          assertCan(p, "refund:issue", { branchId: existing.branchId });
          const same =
            existing.paymentId === body.paymentId &&
            existing.invoiceId === (body.invoiceId ?? null) &&
            existing.amountPaise === body.amountPaise &&
            (body.method === undefined || existing.method === body.method) &&
            existing.reason === body.reason;
          if (!same) throw conflict("idempotency_conflict");
          return { replay: true as const, refund: existing };
        }
        const pay = await findPaymentScoped(tx, p, body.paymentId);
        assertCan(p, "refund:issue", { branchId: pay.branchId });
        await lockPayment(tx, pay.id);
        const fresh = await tx.payment.findUniqueOrThrow({ where: { id: pay.id } });
        if (fresh.status !== "RECORDED") throw conflict("payment_not_recorded");
        if (body.invoiceId) {
          const inv = await findInvoiceScoped(tx, p, body.invoiceId);
          if (inv.patientId !== pay.patientId || inv.branchId !== pay.branchId)
            throw conflict("link_mismatch", { constraint: "Refund_invoice_patient_branch" });
        }
        const { settings } = await loadBranchSettings(tx, p.tenantId, pay.branchId);
        const auto = !refundNeedsApproval(body.amountPaise, settings.refundApprovalThresholdPaise);
        const now = new Date();
        const refund = await tx.refund.create({
          data: {
            tenantId: p.tenantId,
            branchId: pay.branchId,
            patientId: pay.patientId,
            paymentId: pay.id,
            invoiceId: body.invoiceId ?? null,
            amountPaise: body.amountPaise,
            method: body.method ?? pay.method,
            reason: body.reason,
            status: auto ? "APPROVED" : "REQUESTED",
            requestedBy: p.userId,
            requestedAt: now,
            ...(auto ? { approvedBy: p.userId, approvedAt: now } : {}),
            idempotencyKey: body.idempotencyKey,
            gateway: pay.gateway,
            gatewayRef:
              pay.gateway === "MANUAL" ? null : `${pay.gateway.toLowerCase()}_rf_${randomUUID()}`,
          },
        });
        return { replay: false as const, refund, auto };
      },
      { retryUnique: true },
    );
    if (!out.replay) {
      await this.record(p, "refund.request", out.refund.id, out.refund.branchId);
      if (out.auto) await this.record(p, "refund.approve", out.refund.id, out.refund.branchId);
    }
    return toRefundResponse(out.refund);
  }

  async approve(p: Principal, id: string, _body: ApproveRefundRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const probe = await findRefundScoped(tx, p, id);
      assertCan(p, "refund:approve", { branchId: probe.branchId });
      const r = await this.lockRefund(tx, probe);
      if (r.status !== "REQUESTED") throw conflict("refund_invalid_state", { status: r.status });
      const { settings } = await loadBranchSettings(tx, p.tenantId, r.branchId);
      if (settings.separateApprover && r.requestedBy === p.userId)
        throw conflict("refund_self_approval");
      return tx.refund.update({
        where: { id },
        data: { status: "APPROVED", approvedBy: p.userId, approvedAt: new Date() },
      });
    });
    await this.record(p, "refund.approve", id, res.branchId);
    return toRefundResponse(res);
  }

  async reject(p: Principal, id: string, body: RejectRefundRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const probe = await findRefundScoped(tx, p, id);
      assertCan(p, "refund:approve", { branchId: probe.branchId });
      const r = await this.lockRefund(tx, probe);
      if (r.status !== "REQUESTED" && r.status !== "APPROVED")
        throw conflict("refund_invalid_state", { status: r.status });
      return tx.refund.update({
        where: { id },
        data: {
          status: "REJECTED",
          rejectedBy: p.userId,
          rejectedAt: new Date(),
          rejectionReason: body.reason,
        },
      });
    });
    await this.record(p, "refund.reject", id, res.branchId);
    return toRefundResponse(res);
  }

  /** Marks the money as returned. Gateway refunds are confirmed by the gateway webhook only, never by a client. */
  async process(p: Principal, id: string, body: ProcessRefundRequest) {
    const res = await runTx(this.prisma, p, async (tx) => {
      const probe = await findRefundScoped(tx, p, id);
      assertCan(p, "refund:issue", { branchId: probe.branchId });
      const r = await this.lockRefund(tx, probe);
      if (r.status === "REQUESTED") throw conflict("refund_approval_required");
      if (r.status !== "APPROVED") throw conflict("refund_invalid_state", { status: r.status });
      if (r.gateway !== "MANUAL") throw conflict("refund_gateway_confirmation_required");
      return processApprovedRefund(tx, p, r, body.reference);
    });
    await this.record(p, "refund.process", id, res.branchId);
    this.refundJob(p, id);
    return toRefundResponse(res);
  }

  refundJob(who: { tenantId: string; userId: string }, refundId: string) {
    fireAndLog(
      "refund-processed",
      this.jobs.enqueue(NOTIFICATION_QUEUES.REFUND_PROCESSED, {
        tenantId: who.tenantId,
        actorId: who.userId,
        source: "billing",
        idempotencyKey: `refund-processed:${refundId}`,
        data: { refundId },
      }),
    );
  }

  async list(p: Principal, q: ListRefundsQuery) {
    return runTx(this.prisma, p, async (tx) => {
      const and: Prisma.RefundWhereInput[] = [branchWhere(p)];
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.patientId) and.push({ patientId: q.patientId });
      if (q.paymentId) and.push({ paymentId: q.paymentId });
      if (q.status) and.push({ status: q.status });
      if (q.from || q.to)
        and.push({
          requestedAt: {
            ...(q.from ? { gte: dayStartInZone(q.from) } : {}),
            ...(q.to ? { lt: dayStartInZone(dayAfter(q.to)) } : {}),
          },
        });
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        and.push({
          OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
        });
      }
      const rows = await tx.refund.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toRefundResponse),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  async get(p: Principal, id: string) {
    return runTx(this.prisma, p, async (tx) => toRefundResponse(await findRefundScoped(tx, p, id)));
  }
}

/**
 * ADR 0004 §4.4 (one transaction, the refund row and its payment already locked, status APPROVED): reversal
 * allocation (invoice-linked) or REFUNDED credit entry (advance) FIRST, then the flip to PROCESSED (the trigger
 * verifies the reversal), then the REFUND ledger entry. Commission reversals are the commission module's job (it reads
 * the negative allocation).
 */
export async function processApprovedRefund(
  tx: Tx,
  who: Writer,
  r: Refund,
  reference?: string,
): Promise<Refund> {
  if (r.invoiceId) {
    await tx.paymentAllocation.create({
      data: {
        tenantId: who.tenantId,
        paymentId: r.paymentId,
        invoiceId: r.invoiceId,
        patientId: r.patientId,
        branchId: r.branchId,
        amountPaise: -r.amountPaise,
        refundId: r.id,
        allocatedBy: who.userId,
      },
    });
  } else {
    await tx.patientCreditEntry.create({
      data: {
        tenantId: who.tenantId,
        patientId: r.patientId,
        branchId: r.branchId,
        kind: "REFUNDED",
        amountPaise: -r.amountPaise,
        paymentId: r.paymentId,
        refundId: r.id,
        createdBy: who.userId,
      },
    });
  }
  const now = new Date();
  const done = await tx.refund.update({
    where: { id: r.id },
    data: {
      status: "PROCESSED",
      processedBy: who.userId,
      processedAt: now,
      ...(reference ? { reference } : {}),
    },
  });
  await tx.financeLedgerEntry.create({
    data: {
      tenantId: who.tenantId,
      branchId: r.branchId,
      patientId: r.patientId,
      kind: "REFUND",
      amountPaise: r.amountPaise,
      refundId: r.id,
      occurredAt: now,
      createdBy: who.userId,
    },
  });
  return done;
}
