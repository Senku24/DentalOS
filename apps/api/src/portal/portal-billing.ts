import {
  type Invoice,
  type InvoiceStatus,
  type Payment,
  PrismaClient,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  type ListPortalInvoicesQuery,
  type ListPortalPaymentsQuery,
  type PortalCheckoutRequest,
  type PortalCheckoutResponse,
  type PortalInvoiceDetail,
  type PortalInvoiceSummary,
  type PortalPaymentResponse,
  type PortalReceiptResponse,
  listPortalInvoicesQuery,
  listPortalPaymentsQuery,
  portalCheckoutRequest,
  resolveBillingSettings,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import { CurrentPatient, type PatientPrincipal } from "../auth/patient-principal";
import { PortalAuditService } from "../auth/portal-audit";
import { PortalAuth } from "../auth/portal.guard";
import { advisoryLock, loadBranchSettings } from "../billing/billing-common";
import { CHECKOUT_TTL_MS, type PaymentGateway, StubGateway } from "../billing/gateway";
import { isUniqueViolation } from "../common/db-errors";
import { ZodPipe } from "../common/zod.pipe";
import {
  UUID,
  badRequest,
  conflict,
  dateOnlyOrNull,
  decodeCursor,
  displayName,
  iso,
  notFound,
  pageOf,
  portalTx,
} from "./portal-common";

const SHOWN: InvoiceStatus[] = ["ISSUED", "PARTIALLY_PAID", "PAID"];
const OPEN: InvoiceStatus[] = ["ISSUED", "PARTIALLY_PAID"];
/** Same scope as the staff gateway checkout: the webhook reads the invoices this payment is meant for from it. */
const DEDUPE_INVOICES = "gateway.invoices";

/** https only (http solely for localhost outside production), and the origin of PORTAL_PUBLIC_URL when configured. */
function assertReturnUrl(url: string | undefined) {
  if (!url) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest("invalid_return_url");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const schemeOk =
    u.protocol === "https:" ||
    (u.protocol === "http:" && local && process.env.NODE_ENV !== "production");
  const configured = process.env.PORTAL_PUBLIC_URL;
  let originOk = true;
  if (configured) {
    try {
      originOk = new URL(configured).origin === u.origin;
    } catch {
      originOk = false;
    }
  }
  if (!schemeOk || !originOk) throw badRequest("invalid_return_url");
}

type InvoiceRow = Invoice & { branch: { id: string; name: string; settings: unknown } };

/**
 * Invoices, payments, receipts (read-only views of the M3 data of the principal's patient lineage) and the online
 * checkout. Money is never written by a browser signal: checkout only creates the PENDING payment (+ the invoices it is
 * meant for, exactly like the staff gateway checkout); the signed gateway webhook records it (ADR 0004 §5).
 */
@Injectable()
export class PortalBillingService {
  private readonly gateway: PaymentGateway = new StubGateway();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: PortalAuditService,
  ) {}

  private toSummary(i: InvoiceRow, tenantSettings: unknown): PortalInvoiceSummary {
    const online =
      resolveBillingSettings(tenantSettings, i.branch.settings).gatewayProvider !== "MANUAL";
    return {
      id: i.id,
      number: i.number ?? "",
      status: i.status,
      issuedAt: iso(i.issuedAt ?? i.createdAt),
      dueDate: dateOnlyOrNull(i.dueDate),
      totalPaise: i.totalPaise,
      adjustmentPaise: i.adjustmentPaise,
      paidPaise: i.paidPaise,
      balancePaise: i.balancePaise,
      branchName: i.branch.name,
      payable: OPEN.includes(i.status) && i.balancePaise > 0 && online,
    };
  }

  async invoices(me: PatientPrincipal, q: ListPortalInvoicesQuery) {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: me.tenantId },
        select: { settings: true },
      });
      const c = decodeCursor(q.cursor);
      const statuses =
        q.status === "OPEN" ? OPEN : q.status === "PAID" ? (["PAID"] as InvoiceStatus[]) : SHOWN;
      const rows = await tx.invoice.findMany({
        where: {
          patientId: { in: me.patientIds },
          status: { in: statuses },
          issuedAt: { not: null },
          ...(c ? { OR: [{ issuedAt: { lt: c.at } }, { issuedAt: c.at, id: { lt: c.id } }] } : {}),
        },
        include: { branch: { select: { id: true, name: true, settings: true } } },
        orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const page = pageOf(rows, q.limit, (r) => r.issuedAt ?? r.createdAt);
      return {
        items: page.items.map((i) => this.toSummary(i, tenant.settings)),
        nextCursor: page.nextCursor,
      };
    });
  }

  async invoice(me: PatientPrincipal, id: string): Promise<PortalInvoiceDetail> {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: me.tenantId },
        select: { settings: true },
      });
      const inv = await tx.invoice.findFirst({
        where: { id, patientId: { in: me.patientIds }, status: { in: SHOWN } },
        include: { branch: { select: { id: true, name: true, settings: true } } },
      });
      if (!inv) throw notFound("invoice_not_found");
      const lines = await tx.invoiceLine.findMany({
        where: { invoiceId: inv.id },
        orderBy: { lineNo: "asc" },
      });
      const allocs = await tx.paymentAllocation.findMany({
        where: { invoiceId: inv.id, refundId: null, payment: { status: "RECORDED" } },
        include: { payment: true },
        orderBy: { createdAt: "asc" },
      });
      const payments = await this.paymentResponses(tx, [
        ...new Map(allocs.map((a) => [a.paymentId, a.payment])).values(),
      ]);
      return {
        ...this.toSummary(inv, tenant.settings),
        taxInclusive: inv.taxInclusive,
        subtotalPaise: inv.subtotalPaise,
        discountPaise: inv.discountPaise,
        taxPaise: inv.taxPaise,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPricePaise: l.unitPricePaise,
          discountPaise: l.discountPaise + l.allocatedDiscountPaise,
          taxPaise: l.cgstPaise + l.sgstPaise + l.igstPaise,
          totalPaise: l.totalPaise,
        })),
        payments,
      };
    });
  }

  private async paymentResponses(tx: Tx, payments: Payment[]): Promise<PortalPaymentResponse[]> {
    if (payments.length === 0) return [];
    const allocs = await tx.paymentAllocation.findMany({
      where: { paymentId: { in: payments.map((p) => p.id) }, refundId: null },
      include: { invoice: { select: { number: true } } },
    });
    return payments.map((p) => ({
      id: p.id,
      receiptNumber: p.receiptNumber,
      amountPaise: p.amountPaise,
      method: p.method,
      status: p.status,
      receivedAt: iso(p.receivedAt),
      invoiceNumbers: [
        ...new Set(
          allocs
            .filter((a) => a.paymentId === p.id)
            .map((a) => a.invoice.number)
            .filter((n): n is string => !!n),
        ),
      ],
    }));
  }

  async payments(me: PatientPrincipal, q: ListPortalPaymentsQuery) {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const c = decodeCursor(q.cursor);
      const rows = await tx.payment.findMany({
        where: {
          patientId: { in: me.patientIds },
          status: { in: ["RECORDED", "PENDING"] },
          ...(c
            ? { OR: [{ receivedAt: { lt: c.at } }, { receivedAt: c.at, id: { lt: c.id } }] }
            : {}),
        },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const page = pageOf(rows, q.limit, (r) => r.receivedAt);
      return { items: await this.paymentResponses(tx, page.items), nextCursor: page.nextCursor };
    });
  }

  async receipt(me: PatientPrincipal, id: string): Promise<PortalReceiptResponse> {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const p = await tx.payment.findFirst({
        where: {
          id,
          patientId: { in: me.patientIds },
          status: "RECORDED",
          receiptNumber: { not: null },
        },
        include: {
          branch: { select: { name: true } },
          patient: { select: { firstName: true, lastName: true, preferredName: true } },
        },
      });
      if (!p || !p.receiptNumber) throw notFound("receipt_not_found");
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: me.tenantId },
        select: { name: true },
      });
      const allocs = await tx.paymentAllocation.findMany({
        where: { paymentId: p.id, refundId: null },
        include: { invoice: { select: { number: true } } },
        orderBy: { createdAt: "asc" },
      });
      return {
        receiptNumber: p.receiptNumber,
        paymentId: p.id,
        amountPaise: p.amountPaise,
        method: p.method,
        receivedAt: iso(p.receivedAt),
        clinicName: tenant.name,
        branchName: p.branch.name,
        patientName: displayName(p.patient),
        allocations: allocs.map((a) => ({
          invoiceNumber: a.invoice.number ?? "",
          amountPaise: a.amountPaise,
        })),
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------------------------

  async checkout(
    me: PatientPrincipal,
    body: PortalCheckoutRequest,
  ): Promise<PortalCheckoutResponse> {
    assertReturnUrl(body.returnUrl);
    const payKey = `portal:${me.patientId}:${body.idempotencyKey}`;
    const invoiceIds = [...new Set(body.invoiceIds)];

    // Phase 1: replay / validation (no network I/O inside the transaction).
    const pre = await portalTx(this.prisma, me, async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: { id: { in: invoiceIds }, patientId: { in: me.patientIds } },
      });
      if (invoices.length !== invoiceIds.length) throw notFound("invoice_not_found");
      const first = invoices[0] as Invoice;
      const denied = (reason: string) => conflict("payment_not_allowed", { reason });
      if (invoices.some((i) => !SHOWN.includes(i.status))) throw notFound("invoice_not_found");
      if (invoices.some((i) => !OPEN.includes(i.status) || i.balancePaise <= 0))
        throw conflict("invoice_not_payable");
      if (invoices.some((i) => i.branchId !== first.branchId)) throw denied("mixed_branches");
      if (invoices.some((i) => i.patientId !== first.patientId))
        throw denied("mixed_patient_records");
      const balance = invoices.reduce((s, i) => s + i.balancePaise, 0);
      const amount = body.amountPaise ?? balance;
      // No advance payments from the portal: the staff path keeps them.
      if (amount > balance) throw denied("amount_exceeds_balance");
      const existing = await tx.payment.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: me.tenantId, idempotencyKey: payKey } },
      });
      if (existing) {
        if (existing.patientId !== first.patientId || existing.amountPaise !== amount)
          throw conflict("idempotency_conflict");
        return { replay: existing, branchId: first.branchId, patientId: first.patientId, amount };
      }
      const { settings } = await loadBranchSettings(tx, me.tenantId, first.branchId);
      if (settings.gatewayProvider === "MANUAL" || settings.gatewayProvider !== this.gateway.id)
        throw denied("online_payments_disabled");
      return { replay: null, branchId: first.branchId, patientId: first.patientId, amount };
    });
    if (pre.replay) return this.response(pre.replay);

    // Phase 2: the provider call (outside any transaction; deterministic per key).
    const co = await this.gateway.createCheckout({
      amountPaise: pre.amount,
      patientId: pre.patientId,
      reference: payKey,
      idempotencyKey: payKey,
      returnUrl: body.returnUrl,
    });

    // Phase 3: the PENDING payment and the invoices it is for.
    const pay = await this.createPending(me, pre, payKey, co.gatewayRef, invoiceIds).catch(
      async (e) => {
        if (!isUniqueViolation(e)) throw e;
        return this.createPending(me, pre, payKey, co.gatewayRef, invoiceIds); // lost the race: finds the winner
      },
    );
    if (pay.created)
      await this.audit.record(me, {
        action: "portal.payment.checkout",
        resource: "payment",
        resourceId: pay.row.id,
        branchId: pay.row.branchId,
        outcome: "success",
      });
    return this.response(pay.row);
  }

  private createPending(
    me: PatientPrincipal,
    pre: { branchId: string; patientId: string; amount: number },
    payKey: string,
    gatewayRef: string,
    invoiceIds: string[],
  ) {
    return portalTx(this.prisma, me, async (tx) => {
      await advisoryLock(tx, `payment:${me.tenantId}:${payKey}`);
      const again = await tx.payment.findUnique({
        where: { tenantId_idempotencyKey: { tenantId: me.tenantId, idempotencyKey: payKey } },
      });
      if (again) return { created: false as const, row: again };
      const row = await tx.payment.create({
        data: {
          tenantId: me.tenantId,
          branchId: pre.branchId,
          patientId: pre.patientId,
          method: "OTHER",
          amountPaise: pre.amount,
          receivedBy: me.actorId,
          idempotencyKey: payKey,
          gateway: this.gateway.id,
          gatewayRef,
          status: "PENDING",
        },
      });
      await tx.requestDedupe.create({
        data: {
          tenantId: me.tenantId,
          scope: DEDUPE_INVOICES,
          idempotencyKey: row.id,
          refType: "invoices",
          refId: invoiceIds.join(","),
          createdBy: me.actorId,
        },
      });
      return { created: true as const, row };
    });
  }

  private response(p: Payment): PortalCheckoutResponse {
    return {
      paymentId: p.id,
      status: p.status,
      checkoutUrl: this.gateway.checkoutUrlFor(p.gatewayRef ?? ""),
      expiresAt: iso(new Date(p.createdAt.getTime() + CHECKOUT_TTL_MS)),
    };
  }
}

@Controller("portal")
export class PortalBillingController {
  constructor(private readonly svc: PortalBillingService) {}

  @PortalAuth()
  @Get("invoices")
  invoices(
    @CurrentPatient() me: PatientPrincipal,
    @Query(new ZodPipe(listPortalInvoicesQuery)) q: ListPortalInvoicesQuery,
  ) {
    return this.svc.invoices(me, q);
  }

  @PortalAuth()
  @Get("invoices/:id")
  invoice(@CurrentPatient() me: PatientPrincipal, @Param("id", UUID) id: string) {
    return this.svc.invoice(me, id);
  }

  @PortalAuth()
  @Get("payments")
  payments(
    @CurrentPatient() me: PatientPrincipal,
    @Query(new ZodPipe(listPortalPaymentsQuery)) q: ListPortalPaymentsQuery,
  ) {
    return this.svc.payments(me, q);
  }

  @PortalAuth()
  @Get("payments/:id/receipt")
  receipt(@CurrentPatient() me: PatientPrincipal, @Param("id", UUID) id: string) {
    return this.svc.receipt(me, id);
  }

  @PortalAuth()
  @Post("payments/checkout")
  @HttpCode(200)
  checkout(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalCheckoutRequest)) body: PortalCheckoutRequest,
  ) {
    return this.svc.checkout(me, body);
  }
}
