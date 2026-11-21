import { createHash } from "node:crypto";
import { webhookSecrets } from "@dentalos/config";
import { PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type CreateGatewayCheckoutRequest,
  GATEWAY_PROVIDERS,
  type GatewayCheckoutResponse,
  type GatewayWebhookPayload,
  NOTIFICATION_QUEUES,
  financialYearOf,
  formatDocumentNumber,
} from "@dentalos/validation";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ZodError } from "zod";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { isRetryableTxError } from "../common/db-errors";
import { JobQueueService } from "../common/job-queue.service";
import { assertCan } from "../common/principal";
import { findActivePatient } from "../patients/patient-common";
import {
  advisoryLock,
  allocateSeq,
  badRequest,
  conflict,
  findInvoiceScoped,
  fireAndLog,
  loadBranchSettings,
  lockPayment,
  mapBillingDbError,
  notFound,
  runTx,
} from "./billing-common";
import {
  CHECKOUT_TTL_MS,
  type PaymentGateway,
  StubGateway,
  verifyWebhookSignature,
} from "./gateway";
import { type AllocationRequest, type Writer, settleRecordedPayment } from "./payment-core";
import { processApprovedRefund } from "./refunds.service";

const DEDUPE_INVOICES = "gateway.invoices";

type WebhookResult = {
  status: "processed" | "duplicate" | "ignored";
  paymentId?: string;
  refundId?: string;
  branchId?: string;
  action?: string;
};

/**
 * Online payments through the pluggable gateway (ADR 0004 §5): checkout creates a PENDING payment; ONLY the signed,
 * idempotent webhook moves it to RECORDED / FAILED (a client-side "success" is never trusted).
 */
@Injectable()
export class GatewayService {
  private readonly gateways = new Map<string, PaymentGateway>([["STUB", new StubGateway()]]);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
  ) {}

  private response(
    gw: PaymentGateway,
    pay: {
      id: string;
      gateway: string;
      status: GatewayCheckoutResponse["status"];
      gatewayRef: string | null;
      createdAt: Date;
    },
  ): GatewayCheckoutResponse {
    const ref = pay.gatewayRef ?? "";
    return {
      paymentId: pay.id,
      gateway: pay.gateway,
      status: pay.status,
      gatewayRef: ref,
      checkoutUrl: gw.checkoutUrlFor(ref),
      expiresAt: new Date(pay.createdAt.getTime() + CHECKOUT_TTL_MS).toISOString(),
    };
  }

  async checkout(
    p: Principal,
    body: CreateGatewayCheckoutRequest,
  ): Promise<GatewayCheckoutResponse> {
    assertCan(p, "payment:record", { branchId: body.branchId });

    // Phase 1 (transaction): replay / validation. No network I/O inside it.
    const pre = await runTx(this.prisma, p, async (tx) => {
      const existing = await tx.payment.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: p.tenantId, idempotencyKey: body.idempotencyKey },
        },
      });
      if (existing) {
        if (
          existing.gateway === "MANUAL" ||
          existing.patientId !== body.patientId ||
          existing.branchId !== body.branchId ||
          existing.amountPaise !== body.amountPaise
        )
          throw conflict("idempotency_conflict");
        return { replay: existing, provider: existing.gateway };
      }
      await findActivePatient(tx, body.patientId);
      const { settings } = await loadBranchSettings(tx, p.tenantId, body.branchId);
      if (settings.gatewayProvider === "MANUAL" || !this.gateways.has(settings.gatewayProvider))
        throw conflict("gateway_not_configured");
      for (const invoiceId of body.invoiceIds ?? []) {
        const inv = await findInvoiceScoped(tx, p, invoiceId);
        if (inv.patientId !== body.patientId || inv.branchId !== body.branchId)
          throw conflict("link_mismatch", {
            constraint: "PaymentAllocation_invoice_patient_branch",
          });
        if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID")
          throw conflict("invoice_not_payable", { status: inv.status });
      }
      return { replay: null, provider: settings.gatewayProvider };
    });
    const gw = this.gateways.get(pre.provider);
    if (!gw) throw conflict("gateway_not_configured");
    if (pre.replay)
      return this.response(gw, {
        ...pre.replay,
        gatewayRef: pre.replay.gatewayRef,
      });

    // Phase 2: call the provider (outside any transaction; provider-side idempotent by key).
    const co = await gw.createCheckout({
      amountPaise: body.amountPaise,
      patientId: body.patientId,
      reference: body.idempotencyKey,
      idempotencyKey: body.idempotencyKey,
      returnUrl: body.returnUrl,
    });

    // Phase 3 (transaction): the PENDING payment (+ the invoices it is meant for).
    const out = await runTx(
      this.prisma,
      p,
      async (tx) => {
        await advisoryLock(tx, `payment:${p.tenantId}:${body.idempotencyKey}`);
        const again = await tx.payment.findUnique({
          where: {
            tenantId_idempotencyKey: { tenantId: p.tenantId, idempotencyKey: body.idempotencyKey },
          },
        });
        if (again) return { created: false as const, pay: again };
        const pay = await tx.payment.create({
          data: {
            tenantId: p.tenantId,
            branchId: body.branchId,
            patientId: body.patientId,
            method: "OTHER",
            amountPaise: body.amountPaise,
            receivedBy: p.userId,
            idempotencyKey: body.idempotencyKey,
            gateway: gw.id,
            gatewayRef: co.gatewayRef,
            status: "PENDING",
          },
        });
        if (body.invoiceIds?.length)
          await tx.requestDedupe.create({
            data: {
              tenantId: p.tenantId,
              scope: DEDUPE_INVOICES,
              idempotencyKey: pay.id,
              refType: "invoices",
              refId: body.invoiceIds.join(","),
              createdBy: p.userId,
            },
          });
        return { created: true as const, pay };
      },
      { retryUnique: true },
    );
    if (out.created)
      await this.audit.record(p, {
        action: "payment.gateway.pending",
        resource: "payment",
        resourceId: out.pay.id,
        branchId: out.pay.branchId,
        outcome: "success",
      });
    return this.response(gw, out.pay);
  }

  // -------------------------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------------------------

  /**
   * ADR 0004 §5: (1) verify the HMAC over the RAW bytes, (2) parse, (3) ONE `withTenant` transaction holding the
   * event row and every effect. A duplicate event answers 200 without side effects; any failure rolls the event row
   * back too, so the provider's retry is processed again.
   */
  async handleWebhook(
    gatewayParam: string,
    tenantId: string,
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ status: string }> {
    const gateway = gatewayParam.toUpperCase();
    const gw = this.gateways.get(gateway);
    if (!gw || !(GATEWAY_PROVIDERS as readonly string[]).includes(gateway) || gateway === "MANUAL")
      throw new NotFoundException();
    if (!verifyWebhookSignature(rawBody, signature, webhookSecrets(gateway, tenantId)))
      throw new UnauthorizedException({ error: "webhook_signature_invalid" });

    let payload: GatewayWebhookPayload;
    try {
      payload = gw.parseWebhook(rawBody as Buffer);
    } catch (e) {
      if (e instanceof ZodError)
        throw new BadRequestException({
          error: "validation_failed",
          issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      throw new BadRequestException({ error: "validation_failed" });
    }
    const hash = createHash("sha256")
      .update(rawBody as Buffer)
      .digest("hex");
    const who: Writer = { tenantId, userId: `webhook:${gateway.toLowerCase()}` };

    let result: WebhookResult | undefined;
    for (let attempt = 1; !result; attempt++) {
      try {
        result = await withTenant(
          this.prisma,
          tenantId,
          (tx) => this.applyEvent(tx, who, gateway, payload, hash),
          { actorId: who.userId },
        );
      } catch (e) {
        if (attempt < 4 && isRetryableTxError(e)) continue;
        return mapBillingDbError(e);
      }
    }

    if (result.status === "processed") {
      const p: Principal = {
        userId: who.userId,
        tenantId,
        roles: [],
        orgWide: false,
        branchScope: [],
      };
      if (result.action)
        await this.audit.record(p, {
          action: result.action,
          resource: result.refundId ? "refund" : "payment",
          resourceId: result.refundId ?? result.paymentId,
          branchId: result.branchId,
          outcome: "success",
          source: `webhook:${gateway.toLowerCase()}`,
        });
      if (result.paymentId && result.action === "payment.gateway.recorded")
        fireAndLog(
          "payment-recorded",
          this.jobs.enqueue(NOTIFICATION_QUEUES.PAYMENT_RECEIPT, {
            tenantId,
            actorId: who.userId,
            source: "billing",
            idempotencyKey: `payment-recorded:${result.paymentId}`,
            data: { paymentId: result.paymentId },
          }),
        );
      if (result.refundId)
        fireAndLog(
          "refund-processed",
          this.jobs.enqueue(NOTIFICATION_QUEUES.REFUND_PROCESSED, {
            tenantId,
            actorId: who.userId,
            source: "billing",
            idempotencyKey: `refund-processed:${result.refundId}`,
            data: { refundId: result.refundId },
          }),
        );
    }
    return { status: result.status };
  }

  private async applyEvent(
    tx: Tx,
    who: Writer,
    gateway: string,
    ev: GatewayWebhookPayload,
    payloadHash: string,
  ): Promise<WebhookResult> {
    await advisoryLock(tx, `webhook:${who.tenantId}:${gateway}:${ev.eventId}`);
    const seen = await tx.paymentGatewayEvent.findUnique({
      where: { tenantId_gateway_eventId: { tenantId: who.tenantId, gateway, eventId: ev.eventId } },
    });
    if (seen) return { status: "duplicate" };
    // The event row goes in FIRST and commits (or rolls back) together with every effect below.
    await tx.paymentGatewayEvent.create({
      data: {
        tenantId: who.tenantId,
        gateway,
        eventId: ev.eventId,
        eventType: ev.type,
        payloadHash,
        outcome: "processed",
      },
    });

    if (ev.type === "refund.processed") {
      const r = await tx.refund.findFirst({ where: { gateway, gatewayRef: ev.gatewayRef } });
      if (!r) throw notFound("refund_not_found");
      await lockPayment(tx, r.paymentId);
      await tx.$queryRaw`SELECT 1 FROM "Refund" WHERE "id" = ${r.id}::uuid FOR UPDATE`;
      const cur = await tx.refund.findUniqueOrThrow({ where: { id: r.id } });
      if (cur.status === "PROCESSED") return { status: "ignored", refundId: cur.id };
      if (cur.status !== "APPROVED") throw conflict("refund_invalid_state", { status: cur.status });
      if (ev.amountPaise !== cur.amountPaise) throw badRequest("webhook_amount_mismatch");
      await processApprovedRefund(tx, who, cur);
      return {
        status: "processed",
        refundId: cur.id,
        branchId: cur.branchId,
        action: "refund.gateway.confirm",
      };
    }

    const found = await tx.payment.findFirst({ where: { gateway, gatewayRef: ev.gatewayRef } });
    if (!found) throw notFound("payment_not_found");
    await lockPayment(tx, found.id);
    const pay = await tx.payment.findUniqueOrThrow({ where: { id: found.id } });
    if (pay.status !== "PENDING") return { status: "ignored", paymentId: pay.id };

    if (ev.type === "payment.failed") {
      await tx.payment.update({
        where: { id: pay.id },
        data: { status: "FAILED", failureCode: ev.failureCode },
      });
      return {
        status: "processed",
        paymentId: pay.id,
        branchId: pay.branchId,
        action: "payment.gateway.failed",
      };
    }

    if (ev.amountPaise !== pay.amountPaise) throw badRequest("webhook_amount_mismatch");
    const { branch, settings } = await loadBranchSettings(tx, who.tenantId, pay.branchId);
    const now = new Date();
    const fy = financialYearOf(now, branch.timezone);
    const seq = await allocateSeq(tx, who.tenantId, branch.id, "RCP", fy);
    const recorded = await tx.payment.update({
      where: { id: pay.id },
      data: {
        status: "RECORDED",
        receivedAt: now,
        receiptNumber: formatDocumentNumber({
          branchCode: branch.code,
          financialYear: fy,
          seq,
          series: "RCP",
        }),
      },
    });
    // Invoices recorded at checkout, in order, each up to its current balance; the rest becomes advance.
    const dedupe = await tx.requestDedupe.findUnique({
      where: {
        tenantId_scope_idempotencyKey: {
          tenantId: who.tenantId,
          scope: DEDUPE_INVOICES,
          idempotencyKey: pay.id,
        },
      },
    });
    const allocs: AllocationRequest[] = [];
    let left = pay.amountPaise;
    for (const invoiceId of dedupe?.refId?.split(",") ?? []) {
      if (left <= 0) break;
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!inv || (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID")) continue;
      const take = Math.min(left, inv.balancePaise);
      if (take > 0) {
        allocs.push({ invoiceId, amountPaise: take });
        left -= take;
      }
    }
    await settleRecordedPayment(tx, who, recorded, allocs, settings, {
      clamp: true,
      occurredAt: now,
    });
    return {
      status: "processed",
      paymentId: pay.id,
      branchId: pay.branchId,
      action: "payment.gateway.recorded",
    };
  }
}
