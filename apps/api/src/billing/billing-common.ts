import { createHash, randomInt } from "node:crypto";
import {
  type Invoice,
  type InvoiceAdjustment,
  type InvoiceLine,
  type Payment,
  type PaymentAllocation,
  type PrismaClient,
  type Refund,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  type AdjustmentResponse,
  type InvoiceDetailResponse,
  type InvoiceLineResponse,
  type InvoiceResponse,
  type InvoiceSummary,
  type PaymentAllocationResponse,
  type PaymentResponse,
  type RefundResponse,
  type ResolvedBillingSettings,
  resolveBillingSettings,
  unallocatedPaise,
  uuid,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import type { Principal } from "../auth/roles";
import {
  M3_GUARD_HTTP,
  checkViolation,
  foreignKeyViolation,
  isRetryableTxError,
  isUniqueViolation,
  m3GuardError,
  notAMember,
  privilegeDenied,
} from "../common/db-errors";
import { withBranchScope } from "../common/principal";
import { logger } from "../observability/logger";
import { dateOnly } from "../patients/patient-common";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * API-level codes of the billing module that are NOT in `BILLING_ERROR_CODES` (@dentalos/validation) yet. Proposed
 * for addition there (see "Flags for Commander"). 409 unless noted.
 */
export const BILLING_LOCAL_ERROR_CODES = [
  "invoice_not_found", // 404
  "invoice_line_not_found", // 404
  "payment_not_found", // 404
  "refund_not_found", // 404
  "plan_not_found", // 404
  "plan_item_not_found", // 404
  "plan_version_not_found", // 404
  "service_not_found", // 404
  "branch_not_found", // 404
  "invoice_not_issued",
  "plan_item_plan_mismatch",
  "plan_nothing_to_bill",
  "service_inactive",
  "procedure_not_billable",
  "advance_not_allowed",
  "payment_method_not_allowed", // 400
  "payment_not_pending",
  "gateway_not_configured",
  "refund_gateway_confirmation_required",
  "refund_not_approved",
  "refund_invalid_state",
  "webhook_amount_mismatch", // 400
  "link_patient_mismatch",
  "retry_later",
] as const;

export const conflict = (error: string, extra: Record<string, unknown> = {}) =>
  new ConflictException({ error, ...extra });
export const badRequest = (error: string, extra: Record<string, unknown> = {}) =>
  new BadRequestException({ error, ...extra });
export const notFound = (error: string) => new NotFoundException({ error });

/** Translates the DB's guard errors into stable API errors (HttpExceptions pass through). */
export function mapBillingDbError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  const g = m3GuardError(e);
  if (g) {
    const status = M3_GUARD_HTTP[g];
    if (status === 500) {
      logger.error({ code: g }, "billing: tenant_mismatch from a SECURITY DEFINER function");
      throw new InternalServerErrorException({ error: g });
    }
    if (status === 400) throw new BadRequestException({ error: g });
    throw new ConflictException({ error: g });
  }
  const check = checkViolation(e);
  if (check) throw new ConflictException({ error: "constraint_violated", constraint: check });
  const fk = foreignKeyViolation(e);
  if (fk) throw new ConflictException({ error: "link_mismatch", constraint: fk });
  const member = notAMember(e);
  if (member) throw new BadRequestException({ error: "not_a_member", field: member });
  if (privilegeDenied(e)) {
    logger.error("billing: privilege denied on an append-only table (programming error)");
    throw new InternalServerErrorException();
  }
  if (isRetryableTxError(e)) throw new ConflictException({ error: "retry_later" });
  if (isUniqueViolation(e)) throw new ConflictException({ error: "duplicate" });
  throw e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One unit of work: `withTenant` (+ actor for DB triggers), retried on deadlock / serialization failure, DB errors
 * mapped to API errors. `retryUnique`: a unique violation (the idempotency race) re-runs the unit so the replay is
 * found by the pre-insert lookup.
 */
export async function runTx<T>(
  prisma: PrismaClient,
  who: { tenantId: string; userId: string },
  fn: (tx: Tx) => Promise<T>,
  opts: { retryUnique?: boolean } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTenant(prisma, who.tenantId, fn, { actorId: who.userId });
    } catch (e) {
      const retry =
        attempt < 4 && (isRetryableTxError(e) || (opts.retryUnique && isUniqueViolation(e)));
      if (!retry) return mapBillingDbError(e);
      await sleep(10 + randomInt(40) * attempt);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Idempotency (RequestDedupe) + locks + numbering
// ---------------------------------------------------------------------------------------------

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
};
export const requestHash = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex");

/** Transaction-scoped advisory lock on an arbitrary string (serialises idempotent replays / plan billing). */
export async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * ADR 0004 §4.1: the RequestDedupe row is inserted FIRST, in the same transaction as the write. Returns the stored
 * `refId` on a replay (same key, same body: write nothing), throws 409 `idempotency_conflict` for a different body.
 * An advisory lock on (tenant, scope, key) makes two parallel identical requests queue instead of racing.
 */
export async function claimDedupe(
  tx: Tx,
  who: { tenantId: string; userId: string },
  d: { scope: string; key: string; hash: string; refType: string; refId: string },
): Promise<string | null> {
  await advisoryLock(tx, `dedupe:${who.tenantId}:${d.scope}:${d.key}`);
  const existing = await tx.requestDedupe.findUnique({
    where: {
      tenantId_scope_idempotencyKey: {
        tenantId: who.tenantId,
        scope: d.scope,
        idempotencyKey: d.key,
      },
    },
  });
  if (existing) {
    if (existing.requestHash !== d.hash) throw conflict("idempotency_conflict");
    return existing.refId ?? null;
  }
  await tx.requestDedupe.create({
    data: {
      tenantId: who.tenantId,
      scope: d.scope,
      idempotencyKey: d.key,
      requestHash: d.hash,
      refType: d.refType,
      refId: d.refId,
      createdBy: who.userId,
    },
  });
  return null;
}

/** Gap-free number: `allocate_document_seq` locks the counter row until the surrounding transaction ends. */
export async function allocateSeq(
  tx: Tx,
  tenantId: string,
  branchId: string,
  series: "INV" | "CN" | "DN" | "RCP",
  financialYear: string,
): Promise<number> {
  const rows = await tx.$queryRaw<
    { seq: number }[]
  >`SELECT allocate_document_seq(${tenantId}::uuid, ${branchId}::uuid, ${series}, ${financialYear}) AS seq`;
  return Number(rows[0]?.seq);
}

export const lockInvoice = async (tx: Tx, id: string) => {
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${id}::uuid FOR UPDATE`;
};
export const lockPayment = async (tx: Tx, id: string) => {
  await tx.$queryRaw`SELECT 1 FROM "Payment" WHERE "id" = ${id}::uuid FOR UPDATE`;
};

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** Out-of-scope or foreign-tenant ids are indistinguishable from missing ones: 404. */
export async function findInvoiceScoped(tx: Tx, p: Principal, id: string): Promise<Invoice> {
  const inv = await tx.invoice.findFirst({ where: withBranchScope(p, { id }) });
  if (!inv) throw notFound("invoice_not_found");
  return inv;
}
export async function findPaymentScoped(tx: Tx, p: Principal, id: string): Promise<Payment> {
  const pay = await tx.payment.findFirst({ where: withBranchScope(p, { id }) });
  if (!pay) throw notFound("payment_not_found");
  return pay;
}
export async function findRefundScoped(tx: Tx, p: Principal, id: string): Promise<Refund> {
  const r = await tx.refund.findFirst({ where: withBranchScope(p, { id }) });
  if (!r) throw notFound("refund_not_found");
  return r;
}

/** Branch + the effective billing knobs (branch override > tenant > default). */
export async function loadBranchSettings(
  tx: Tx,
  tenantId: string,
  branchId: string,
): Promise<{
  branch: NonNullable<Awaited<ReturnType<Tx["branch"]["findUnique"]>>>;
  settings: ResolvedBillingSettings;
}> {
  const branch = await tx.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw notFound("branch_not_found");
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  return { branch, settings: resolveBillingSettings(tenant?.settings, branch.settings) };
}

// ---------------------------------------------------------------------------------------------
// Cursors, dates
// ---------------------------------------------------------------------------------------------

export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  if (rest.length > 0 || !uuid.safeParse(id).success || Number.isNaN(createdAt.getTime()))
    throw badRequest("invalid_cursor");
  return { createdAt, id: id as string };
}

/** Minutes the zone is ahead of UTC at `at`. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((a, x) => {
      a[x.type] = x.value;
      return a;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The instant a calendar day ("YYYY-MM-DD") starts in a time zone. */
export function dayStartInZone(day: string, timeZone = "Asia/Kolkata"): Date {
  const guess = new Date(`${day}T00:00:00.000Z`);
  return new Date(guess.getTime() - zoneOffsetMinutes(guess, timeZone) * 60_000);
}
export const dayAfter = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
/** Calendar date in a zone, plus N days ("YYYY-MM-DD"). */
export function localDatePlus(at: Date, timeZone: string, days: number): string {
  const d = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return days === 0
    ? d
    : new Date(Date.parse(`${d}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();
const isoN = (d: Date | null) => (d ? d.toISOString() : null);

type WithPatientName = { patient?: { firstName: string; lastName: string | null } | null };

export function toInvoiceSummary(i: Invoice & WithPatientName): InvoiceSummary {
  return {
    id: i.id,
    number: i.number,
    status: i.status,
    branchId: i.branchId,
    patientId: i.patientId,
    ...(i.patient
      ? { patientName: `${i.patient.firstName} ${i.patient.lastName ?? ""}`.trim() }
      : {}),
    issuedAt: isoN(i.issuedAt),
    dueDate: i.dueDate ? dateOnly(i.dueDate) : null,
    currency: "INR",
    totalPaise: i.totalPaise,
    adjustmentPaise: i.adjustmentPaise,
    paidPaise: i.paidPaise,
    balancePaise: i.balancePaise,
    planId: i.planId,
    createdAt: iso(i.createdAt),
  };
}

export function toInvoiceResponse(i: Invoice & WithPatientName): InvoiceResponse {
  return {
    ...toInvoiceSummary(i),
    taxInclusive: i.taxInclusive,
    supplierGstin: i.supplierGstin,
    supplierStateCode: i.supplierStateCode,
    placeOfSupplyStateCode: i.placeOfSupplyStateCode,
    subtotalPaise: i.subtotalPaise,
    discountPaise: i.discountPaise,
    invoiceDiscountPaise: i.invoiceDiscountPaise,
    invoiceDiscountPercentBp: i.invoiceDiscountPercentBp,
    discountReason: i.discountReason,
    taxPaise: i.taxPaise,
    planVersion: i.planVersion,
    encounterId: i.encounterId,
    notes: i.notes,
    issuedBy: i.issuedBy,
    voidReason: i.voidReason,
    voidedBy: i.voidedBy,
    voidedAt: isoN(i.voidedAt),
    createdBy: i.createdBy,
  };
}

export function toLineResponse(l: InvoiceLine): InvoiceLineResponse {
  return {
    id: l.id,
    lineNo: l.lineNo,
    serviceId: l.serviceId,
    serviceCategoryId: l.serviceCategoryId,
    description: l.description,
    hsnSac: l.hsnSac,
    quantity: l.quantity,
    unitPricePaise: l.unitPricePaise,
    grossPaise: l.grossPaise,
    discountPaise: l.discountPaise,
    discountReason: l.discountReason,
    allocatedDiscountPaise: l.allocatedDiscountPaise,
    taxableValuePaise: l.taxableValuePaise,
    taxRateBp: l.taxRateBp,
    cgstPaise: l.cgstPaise,
    sgstPaise: l.sgstPaise,
    igstPaise: l.igstPaise,
    totalPaise: l.totalPaise,
    planItemId: l.planItemId,
    procedureRecordId: l.procedureRecordId,
    encounterId: l.encounterId,
    dentistUserId: l.dentistUserId,
    toothCode: l.toothCode,
  };
}

export function toAllocationResponse(a: PaymentAllocation): PaymentAllocationResponse {
  return {
    id: a.id,
    paymentId: a.paymentId,
    invoiceId: a.invoiceId,
    amountPaise: a.amountPaise,
    refundId: a.refundId,
    allocatedBy: a.allocatedBy,
    createdAt: iso(a.createdAt),
  };
}

export function toAdjustmentResponse(a: InvoiceAdjustment): AdjustmentResponse {
  return {
    id: a.id,
    invoiceId: a.invoiceId,
    branchId: a.branchId,
    kind: a.kind,
    number: a.number,
    amountPaise: a.amountPaise,
    taxPaise: a.taxPaise,
    reason: a.reason,
    issuedBy: a.issuedBy,
    issuedAt: iso(a.issuedAt),
  };
}

export function toRefundResponse(r: Refund): RefundResponse {
  return {
    id: r.id,
    branchId: r.branchId,
    patientId: r.patientId,
    paymentId: r.paymentId,
    invoiceId: r.invoiceId,
    amountPaise: r.amountPaise,
    method: r.method,
    reference: r.reference,
    reason: r.reason,
    status: r.status,
    requestedBy: r.requestedBy,
    requestedAt: iso(r.requestedAt),
    approvedBy: r.approvedBy,
    approvedAt: isoN(r.approvedAt),
    rejectedBy: r.rejectedBy,
    rejectedAt: isoN(r.rejectedAt),
    rejectionReason: r.rejectionReason,
    processedBy: r.processedBy,
    processedAt: isoN(r.processedAt),
    gateway: r.gateway,
    gatewayRef: r.gatewayRef,
    createdAt: iso(r.createdAt),
  };
}

export async function loadInvoiceDetail(tx: Tx, id: string): Promise<InvoiceDetailResponse> {
  const inv = await tx.invoice.findUnique({
    where: { id },
    include: {
      patient: { select: { firstName: true, lastName: true } },
      lines: { orderBy: { lineNo: "asc" } },
      allocations: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      adjustments: { orderBy: [{ issuedAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!inv) throw notFound("invoice_not_found");
  return {
    ...toInvoiceResponse(inv),
    lines: inv.lines.map(toLineResponse),
    allocations: inv.allocations.map(toAllocationResponse),
    adjustments: inv.adjustments.map(toAdjustmentResponse),
  };
}

/** Per-payment money figures: net allocations, processed refunds, patient advance still on the payment. */
export async function paymentTotals(
  tx: Tx,
  paymentIds: string[],
): Promise<Map<string, { allocated: number; refunded: number }>> {
  const out = new Map<string, { allocated: number; refunded: number }>();
  for (const id of paymentIds) out.set(id, { allocated: 0, refunded: 0 });
  if (paymentIds.length === 0) return out;
  const allocs = await tx.paymentAllocation.groupBy({
    by: ["paymentId"],
    where: { paymentId: { in: paymentIds } },
    _sum: { amountPaise: true },
  });
  for (const a of allocs) {
    const t = out.get(a.paymentId);
    if (t) t.allocated = a._sum.amountPaise ?? 0;
  }
  const refunds = await tx.refund.groupBy({
    by: ["paymentId"],
    where: { paymentId: { in: paymentIds }, status: "PROCESSED" },
    _sum: { amountPaise: true },
  });
  for (const r of refunds) {
    const t = out.get(r.paymentId);
    if (t) t.refunded = r._sum.amountPaise ?? 0;
  }
  return out;
}

export function toPaymentResponse(
  pay: Payment,
  totals: { allocated: number; refunded: number },
): PaymentResponse {
  return {
    id: pay.id,
    branchId: pay.branchId,
    patientId: pay.patientId,
    method: pay.method,
    amountPaise: pay.amountPaise,
    reference: pay.reference,
    receivedAt: iso(pay.receivedAt),
    receivedBy: pay.receivedBy,
    gateway: pay.gateway,
    gatewayRef: pay.gatewayRef,
    status: pay.status,
    receiptNumber: pay.receiptNumber,
    notes: pay.notes,
    allocatedPaise: totals.allocated,
    refundedPaise: totals.refunded,
    unallocatedPaise:
      pay.status === "RECORDED"
        ? unallocatedPaise(pay.amountPaise, totals.refunded, totals.allocated)
        : 0,
    createdAt: iso(pay.createdAt),
  };
}

export async function loadPaymentDetail(tx: Tx, id: string) {
  const pay = await tx.payment.findUnique({
    where: { id },
    include: {
      allocations: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      refunds: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!pay) throw notFound("payment_not_found");
  const totals = await paymentTotals(tx, [id]);
  return {
    ...toPaymentResponse(pay, totals.get(id) ?? { allocated: 0, refunded: 0 }),
    allocations: pay.allocations.map(toAllocationResponse),
    refunds: pay.refunds.map(toRefundResponse),
  };
}

/**
 * Domain events for other modules (notifications) — enqueued by queue name AFTER the business commit, best effort
 * (a job is a nudge; the source rows are the truth). Never blocks or fails the request.
 */
export function fireAndLog(label: string, work: Promise<unknown>): void {
  work.catch((err) => logger.warn({ err: String(err), label }, "billing: job enqueue failed"));
}
