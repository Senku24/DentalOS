import { randomUUID } from "node:crypto";
import { type Prisma, PrismaClient } from "@dentalos/db";
import {
  type AllocatePaymentRequest,
  type ApplyAdvanceRequest,
  type ListPaymentsQuery,
  NOTIFICATION_QUEUES,
  type RecordPaymentRequest,
  financialYearOf,
  formatDocumentNumber,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { JobQueueService } from "../common/job-queue.service";
import { assertCan, branchWhere } from "../common/principal";
import { findActivePatient } from "../patients/patient-common";
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
  findPaymentScoped,
  fireAndLog,
  loadBranchSettings,
  loadInvoiceDetail,
  loadPaymentDetail,
  lockInvoice,
  lockPayment,
  notFound,
  paymentTotals,
  requestHash,
  runTx,
  toPaymentResponse,
} from "./billing-common";
import { insertAllocations, settleRecordedPayment } from "./payment-core";

/**
 * Payments (append-only), allocations and patient advance (ADR 0004 §4.1-4.3). A payment is never edited or
 * reversed: mistakes are refunds (RefundsService) or credit adjustments (AccountService).
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {}

  private record(p: Principal, action: string, id: string, branchId: string) {
    return this.audit.record(p, {
      action,
      resource: "payment",
      resourceId: id,
      branchId,
      outcome: "success",
    });
  }

  private receiptJob(p: Principal, paymentId: string) {
    fireAndLog(
      "payment-recorded",
      this.jobs.enqueue(NOTIFICATION_QUEUES.PAYMENT_RECEIPT, {
        tenantId: p.tenantId,
        actorId: p.userId,
        source: "billing",
        idempotencyKey: `payment-recorded:${paymentId}`,
        data: { paymentId },
      }),
    );
  }

  /** Records money received at a branch (born RECORDED) and applies it. Replay-safe by `idempotencyKey`. */
  async create(p: Principal, body: RecordPaymentRequest) {
    assertCan(p, "payment:record", { branchId: body.branchId });
    const out = await runTx(
      this.prisma,
      p,
      async (tx) => {
        const id = randomUUID();
        const replay = await claimDedupe(tx, p, {
          scope: "payment.record",
          key: body.idempotencyKey,
          hash: requestHash(body),
          refType: "payment",
          refId: id,
        });
        if (replay) return { replay: true as const, detail: await loadPaymentDetail(tx, replay) };
        // The same key may already belong to a gateway checkout (same unique column): never silently reuse it.
        if (
          await tx.payment.findUnique({
            where: {
              tenantId_idempotencyKey: {
                tenantId: p.tenantId,
                idempotencyKey: body.idempotencyKey,
              },
            },
          })
        )
          throw conflict("idempotency_conflict");

        await findActivePatient(tx, body.patientId);
        const { branch, settings } = await loadBranchSettings(tx, p.tenantId, body.branchId);
        if (!settings.allowedPaymentMethods.includes(body.method))
          throw badRequest("payment_method_not_allowed", { method: body.method });

        let allocs = body.allocations ?? [];
        if (!body.allocations && body.autoAllocate) {
          const open = await tx.invoice.findMany({
            where: {
              branchId: body.branchId,
              patientId: body.patientId,
              status: { in: ["ISSUED", "PARTIALLY_PAID"] },
            },
            orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
          });
          let left = body.amountPaise;
          allocs = [];
          for (const inv of open) {
            if (left <= 0) break;
            const take = Math.min(left, inv.balancePaise);
            allocs.push({ invoiceId: inv.id, amountPaise: take });
            left -= take;
          }
        }
        if (allocs.reduce((a, x) => a + x.amountPaise, 0) > body.amountPaise)
          throw conflict("allocation_exceeds_payment");

        const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
        const fy = financialYearOf(receivedAt, branch.timezone);
        const seq = await allocateSeq(tx, p.tenantId, branch.id, "RCP", fy);
        const pay = await tx.payment.create({
          data: {
            id,
            tenantId: p.tenantId,
            branchId: body.branchId,
            patientId: body.patientId,
            method: body.method,
            amountPaise: body.amountPaise,
            reference: body.reference || null,
            receivedAt,
            receivedBy: p.userId,
            idempotencyKey: body.idempotencyKey,
            gateway: "MANUAL",
            status: "RECORDED",
            receiptNumber: formatDocumentNumber({
              branchCode: branch.code,
              financialYear: fy,
              seq,
              series: "RCP",
            }),
            notes: body.notes || null,
          },
        });
        await settleRecordedPayment(tx, p, pay, allocs, settings, { occurredAt: receivedAt });
        return { replay: false as const, detail: await loadPaymentDetail(tx, id) };
      },
      { retryUnique: true },
    );
    if (!out.replay) {
      await this.record(p, "payment.record", out.detail.id, out.detail.branchId);
      this.receiptJob(p, out.detail.id);
    }
    return out.detail;
  }

  async list(p: Principal, q: ListPaymentsQuery) {
    return runTx(this.prisma, p, async (tx) => {
      const and: Prisma.PaymentWhereInput[] = [branchWhere(p)];
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.patientId) and.push({ patientId: q.patientId });
      if (q.method) and.push({ method: q.method });
      if (q.status) and.push({ status: q.status });
      if (q.from || q.to)
        and.push({
          receivedAt: {
            ...(q.from ? { gte: dayStartInZone(q.from) } : {}),
            ...(q.to ? { lt: dayStartInZone(dayAfter(q.to)) } : {}),
          },
        });
      if (q.hasAdvance !== undefined) {
        const adv = await tx.$queryRaw<{ id: string }[]>`
          SELECT p."id" FROM "Payment" p
           WHERE p."status" = 'RECORDED'
             AND p."amountPaise"
                 - coalesce((SELECT sum(r."amountPaise") FROM "Refund" r WHERE r."paymentId" = p."id" AND r."status" = 'PROCESSED'), 0)
                 - coalesce((SELECT sum(a."amountPaise") FROM "PaymentAllocation" a WHERE a."paymentId" = p."id"), 0) > 0
           LIMIT 5000`;
        const ids = adv.map((r) => r.id);
        and.push({ id: q.hasAdvance ? { in: ids } : { notIn: ids } });
      }
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        and.push({
          OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
        });
      }
      const rows = await tx.payment.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const totals = await paymentTotals(
        tx,
        items.map((r) => r.id),
      );
      const last = items[items.length - 1];
      return {
        items: items.map((r) =>
          toPaymentResponse(r, totals.get(r.id) ?? { allocated: 0, refunded: 0 }),
        ),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  async get(p: Principal, id: string) {
    return runTx(this.prisma, p, async (tx) => {
      await findPaymentScoped(tx, p, id);
      return loadPaymentDetail(tx, id);
    });
  }

  /** Allocates the unallocated (advance) money of a RECORDED payment to invoices of the same patient and branch. */
  async allocate(p: Principal, id: string, body: AllocatePaymentRequest) {
    const out = await runTx(
      this.prisma,
      p,
      async (tx) => {
        const pay = await findPaymentScoped(tx, p, id);
        assertCan(p, "payment:record", { branchId: pay.branchId });
        const replay = await claimDedupe(tx, p, {
          scope: "payment.allocate",
          key: body.idempotencyKey,
          hash: requestHash({ id, ...body }),
          refType: "payment",
          refId: id,
        });
        if (replay) return { replay: true as const, detail: await loadPaymentDetail(tx, id) };
        await lockPayment(tx, id);
        const fresh = await tx.payment.findUniqueOrThrow({ where: { id } });
        if (fresh.status !== "RECORDED") throw conflict("payment_not_recorded");
        const detail = await loadPaymentDetail(tx, id);
        const total = body.allocations.reduce((a, x) => a + x.amountPaise, 0);
        if (total > detail.unallocatedPaise)
          throw conflict("allocation_exceeds_payment", {
            unallocatedPaise: detail.unallocatedPaise,
          });
        await insertAllocations(tx, p, fresh, body.allocations, { applied: true });
        return { replay: false as const, detail: await loadPaymentDetail(tx, id) };
      },
      { retryUnique: true },
    );
    if (!out.replay) await this.record(p, "payment.allocate", id, out.detail.branchId);
    return out.detail;
  }

  /** Spends the patient's advance on an invoice: source payments of the invoice's branch, oldest first. */
  async applyAdvance(p: Principal, patientId: string, body: ApplyAdvanceRequest) {
    const out = await runTx(
      this.prisma,
      p,
      async (tx) => {
        const probe = await findInvoiceScoped(tx, p, body.invoiceId);
        if (probe.patientId !== patientId) throw notFound("invoice_not_found");
        assertCan(p, "payment:record", { branchId: probe.branchId });
        const replay = await claimDedupe(tx, p, {
          scope: "advance.apply",
          key: body.idempotencyKey,
          hash: requestHash({ patientId, ...body }),
          refType: "invoice",
          refId: body.invoiceId,
        });
        if (replay)
          return {
            replay: true as const,
            branchId: probe.branchId,
            detail: await loadInvoiceDetail(tx, replay),
          };

        // Lock the candidate payments (ordered: a fixed lock order), then read what each still holds.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Payment"
           WHERE "patientId" = ${patientId}::uuid AND "branchId" = ${probe.branchId}::uuid AND "status" = 'RECORDED'
           ORDER BY "receivedAt", "id" FOR UPDATE`;
        const held: { id: string; held: number }[] = [];
        for (const r of locked) {
          const h = await tx.$queryRaw<
            { held: bigint }[]
          >`SELECT payment_advance_held(${p.tenantId}::uuid, ${r.id}::uuid) AS held`;
          const n = Number(h[0]?.held ?? 0);
          if (n > 0) held.push({ id: r.id, held: n });
        }
        if (held.reduce((a, x) => a + x.held, 0) < body.amountPaise)
          throw conflict("credit_insufficient");
        await lockInvoice(tx, body.invoiceId);
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id: body.invoiceId } });
        if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID")
          throw conflict("invoice_not_payable", { status: inv.status });
        if (body.amountPaise > inv.balancePaise)
          throw conflict("invoice_overpaid", { balancePaise: inv.balancePaise });

        let left = body.amountPaise;
        for (const src of held) {
          if (left <= 0) break;
          const take = Math.min(left, src.held);
          await insertAllocations(
            tx,
            p,
            { id: src.id, patientId, branchId: probe.branchId },
            [{ invoiceId: body.invoiceId, amountPaise: take }],
            { applied: true },
          );
          left -= take;
        }
        return {
          replay: false as const,
          branchId: probe.branchId,
          detail: await loadInvoiceDetail(tx, body.invoiceId),
        };
      },
      { retryUnique: true },
    );
    if (!out.replay)
      await this.audit.record(p, {
        action: "advance.apply",
        resource: "invoice",
        resourceId: body.invoiceId,
        branchId: out.branchId,
        outcome: "success",
      });
    return out.detail;
  }
}
