import {
  type AdjustmentResponse,
  type CreditEntryResponse,
  type DiscountSpec,
  type InvoiceDetailResponse,
  type InvoiceLineResponse,
  type LedgerEntryResponse,
  type PaymentDetailResponse,
  type RefundResponse,
  type ResolvedBillingSettings,
  adjustPatientCreditRequest,
  allocatePaymentRequest,
  amountInWordsINR,
  applyAdvanceRequest,
  branchBillingSettings,
  computeInvoiceTotals,
  createGatewayCheckoutRequest,
  createInvoiceFromPlanRequest,
  createInvoiceRequest,
  discountAmount,
  financialYearOf,
  formatDocumentNumber,
  invoiceLineInput,
  isInterStateSupply,
  issueAdjustmentRequest,
  issueInvoiceRequest,
  lineTaxRateBp,
  recordPaymentRequest,
  refundNeedsApproval,
  refundablePaise,
  rejectRefundRequest,
  requestRefundRequest,
  resolveBillingSettings,
  setInvoiceDiscountRequest,
  summarizeTax,
  tenantBillingSettings,
  updateInvoiceLineRequest,
  updateInvoiceRequest,
  voidInvoiceRequest,
  type z,
} from "@dentalos/validation";
import type { Method, MockHandler } from "./client";
import { B1, P3, P41 } from "./clinical-fixtures";
import { clinicalMockHandler } from "./clinical-mock";
import { mapHttpError } from "./errors";
import { branches, fid, patients, services } from "./fixtures";
import { API_PREFIX } from "./routes";
import type { Page } from "./types";

/**
 * In-memory fake of the M3 billing API for mock mode. It follows the Wave 1 services' rules and error codes
 * (invoice_immutable, invoice_not_voidable, invoice_overpaid, refund_exceeds_allocation, idempotency replay…)
 * and uses the same shared pure helpers as the API for every amount. Anything it does not own (patients,
 * plans, catalogue, branches) is delegated to the clinical mock. The caller is always `dev-user`.
 */

const ME = "dev-user";
const LATENCY_MS = 160;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw mapHttpError(status, { error, ...extra });
};
function parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    fail(400, "validation_failed", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  return (r as { data: z.output<T> }).data;
}
function paginate<T>(rows: T[], q: Record<string, string>): Page<T> {
  const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));
  const offset = Math.max(0, Number(q.cursor ?? 0) || 0);
  return {
    items: rows.slice(offset, offset + limit),
    nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
  };
}

let seq = 9000;
const newId = (kind: string) => fid(kind, ++seq);
const nowIso = () => new Date().toISOString();
const daysAgoIso = (d: number, hour = 11) =>
  new Date(Date.now() - d * 86_400_000 + (hour - 12) * 3_600_000).toISOString();
const dayOf = (iso: string) => iso.slice(0, 10);
const localToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const plusDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---- State --------------------------------------------------------------------------------------------

let tenantBilling: Record<string, unknown> = { stateCode: "07", invoiceDueDays: 7 };
const branchBilling: Record<string, Record<string, unknown>> = {};
const tenantGstin = "07AAAAA0000A1Z5";

function settingsFor(branchId?: string): ResolvedBillingSettings {
  const b = branches.find((x) => x.id === branchId);
  return resolveBillingSettings(
    { billing: tenantBilling, gstin: tenantGstin },
    b ? { billing: branchBilling[b.id] ?? {} } : undefined,
  );
}

type LineMeta = { discount: DiscountSpec | null };
interface Inv extends InvoiceDetailResponse {
  _lineMeta: Record<string, LineMeta>;
  _invDiscount: DiscountSpec | null;
  _copies: number;
}
const db = {
  invoices: [] as Inv[],
  payments: [] as PaymentDetailResponse[],
  refunds: [] as RefundResponse[],
  adjustments: [] as AdjustmentResponse[],
  credit: [] as CreditEntryResponse[],
  ledger: [] as LedgerEntryResponse[],
  keys: new Map<string, { fp: string; id: string }>(),
  counters: new Map<string, number>(),
};

const branchCode = (id: string) => branches.find((b) => b.id === id)?.code ?? "BR";
function nextNumber(branchId: string, series: "INV" | "CN" | "DN" | "RCP") {
  const fy = financialYearOf(new Date());
  const k = `${branchId}|${series}|${fy}`;
  const n = (db.counters.get(k) ?? 0) + 1;
  db.counters.set(k, n);
  return formatDocumentNumber({
    branchCode: branchCode(branchId),
    financialYear: fy,
    seq: n,
    series,
  });
}

const patientName = (id: string) => {
  const p = patients.find((x) => x.id === id);
  return p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : undefined;
};
const strip = (i: Inv): InvoiceDetailResponse => {
  const { _lineMeta, _invDiscount, _copies, ...rest } = i;
  return { ...rest, patientName: patientName(i.patientId) };
};
const summary = (i: Inv) => {
  const { lines, allocations, adjustments, ...rest } = strip(i);
  const {
    taxInclusive,
    supplierGstin,
    supplierStateCode,
    placeOfSupplyStateCode,
    subtotalPaise,
    discountPaise,
    invoiceDiscountPaise,
    invoiceDiscountPercentBp,
    discountReason,
    taxPaise,
    planVersion,
    encounterId,
    notes,
    issuedBy,
    voidReason,
    voidedBy,
    voidedAt,
    createdBy,
    ...s
  } = rest;
  void lines;
  void allocations;
  void adjustments;
  void taxInclusive;
  void supplierGstin;
  void supplierStateCode;
  void placeOfSupplyStateCode;
  void subtotalPaise;
  void discountPaise;
  void invoiceDiscountPaise;
  void invoiceDiscountPercentBp;
  void discountReason;
  void taxPaise;
  void planVersion;
  void encounterId;
  void notes;
  void issuedBy;
  void voidReason;
  void voidedBy;
  void voidedAt;
  void createdBy;
  return s;
};

function findInvoice(id: string | undefined): Inv {
  const i = db.invoices.find((x) => x.id === id);
  if (!i) return fail(404, "invoice_not_found");
  return i;
}
function findPayment(id: string | undefined) {
  const p = db.payments.find((x) => x.id === id);
  if (!p) return fail(404, "payment_not_found");
  return p;
}
function findRefund(id: string | undefined) {
  const r = db.refunds.find((x) => x.id === id);
  if (!r) return fail(404, "refund_not_found");
  return r;
}
const requireDraft = (i: Inv) => {
  if (i.status !== "DRAFT") fail(409, "invoice_immutable", { status: i.status });
};

// ---- Draft maths (shared helpers) -----------------------------------------------------------------------

function recompute(inv: Inv) {
  const bases = inv.lines.map((l) => {
    const spec = inv._lineMeta[l.id]?.discount ?? null;
    const gross = l.quantity * l.unitPricePaise;
    l.discountPaise = spec ? discountAmount(spec, gross) : 0;
    return { l, spec };
  });
  let totals: ReturnType<typeof computeInvoiceTotals>;
  try {
    totals = computeInvoiceTotals({
      lines: bases.map(({ l }) => ({
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        discountPaise: l.discountPaise,
        taxRateBp: l.taxRateBp,
      })),
      taxInclusive: inv.taxInclusive,
      interState: isInterStateSupply(inv.supplierStateCode, inv.placeOfSupplyStateCode),
      invoiceDiscount: inv._invDiscount,
    });
  } catch {
    return fail(409, "discount_exceeds_base");
  }
  inv.lines.forEach((l, idx) => {
    const t = totals.lines[idx];
    if (!t) return;
    Object.assign(l, {
      grossPaise: t.grossPaise,
      allocatedDiscountPaise: t.allocatedDiscountPaise,
      taxableValuePaise: t.taxableValuePaise,
      cgstPaise: t.cgstPaise,
      sgstPaise: t.sgstPaise,
      igstPaise: t.igstPaise,
      totalPaise: t.totalPaise,
    });
  });
  inv.subtotalPaise = totals.subtotalPaise;
  inv.discountPaise = totals.discountPaise;
  inv.invoiceDiscountPaise = totals.invoiceDiscountPaise;
  inv.invoiceDiscountPercentBp =
    inv._invDiscount?.kind === "PERCENT" ? inv._invDiscount.percentBp : null;
  inv.taxPaise = totals.taxPaise;
  inv.totalPaise = totals.totalPaise;
  inv.balancePaise = inv.totalPaise + inv.adjustmentPaise - inv.paidPaise;
}

function refreshStatus(inv: Inv) {
  inv.balancePaise = inv.totalPaise + inv.adjustmentPaise - inv.paidPaise;
  if (inv.status === "DRAFT" || inv.status === "VOID") return;
  inv.status = inv.paidPaise <= 0 ? "ISSUED" : inv.balancePaise <= 0 ? "PAID" : "PARTIALLY_PAID";
}

function addLine(inv: Inv, input: z.output<typeof invoiceLineInput>) {
  const s = settingsFor(inv.branchId);
  const svc = input.serviceId ? services.find((x) => x.id === input.serviceId) : undefined;
  if (input.serviceId && !svc) fail(404, "service_not_found");
  if (svc && !svc.active) fail(409, "service_inactive");
  const unit = svc ? (svc.effectivePricePaise ?? svc.basePricePaise) : (input.unitPricePaise ?? 0);
  const id = newId("5f");
  const line: InvoiceLineResponse = {
    id,
    lineNo: inv.lines.length + 1,
    serviceId: svc?.id ?? null,
    serviceCategoryId: svc?.categoryId ?? null,
    description: svc?.name ?? input.description ?? "Item",
    hsnSac: null,
    quantity: input.quantity,
    unitPricePaise: unit,
    grossPaise: 0,
    discountPaise: 0,
    discountReason: input.discountReason ?? null,
    allocatedDiscountPaise: 0,
    taxableValuePaise: 0,
    taxRateBp: lineTaxRateBp(
      svc ? { taxable: svc.taxable, gstRateBp: null } : null,
      s.defaultGstRateBp,
    ),
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    totalPaise: 0,
    planItemId: input.planItemId ?? null,
    procedureRecordId: input.procedureRecordId ?? null,
    encounterId: input.encounterId ?? null,
    dentistUserId: input.dentistUserId ?? null,
    toothCode: input.toothCode ?? null,
  };
  inv.lines.push(line);
  inv._lineMeta[id] = { discount: input.discount ?? null };
  return line;
}

function newInvoice(args: {
  patientId: string;
  branchId: string;
  dueDate?: string;
  placeOfSupplyStateCode?: string;
  notes?: string;
  planId?: string | null;
  encounterId?: string | null;
}): Inv {
  if (!patients.find((p) => p.id === args.patientId)) fail(404, "patient_not_found");
  if (!branches.find((b) => b.id === args.branchId)) fail(404, "branch_not_found");
  const s = settingsFor(args.branchId);
  const inv: Inv = {
    id: newId("5e"),
    number: null,
    status: "DRAFT",
    branchId: args.branchId,
    patientId: args.patientId,
    issuedAt: null,
    dueDate: args.dueDate ?? null,
    currency: "INR",
    totalPaise: 0,
    adjustmentPaise: 0,
    paidPaise: 0,
    balancePaise: 0,
    planId: args.planId ?? null,
    createdAt: nowIso(),
    taxInclusive: s.taxInclusive,
    supplierGstin: s.gstin,
    supplierStateCode: s.stateCode,
    placeOfSupplyStateCode: args.placeOfSupplyStateCode ?? s.stateCode,
    subtotalPaise: 0,
    discountPaise: 0,
    invoiceDiscountPaise: 0,
    invoiceDiscountPercentBp: null,
    discountReason: null,
    taxPaise: 0,
    planVersion: null,
    encounterId: args.encounterId ?? null,
    notes: args.notes ?? null,
    issuedBy: null,
    voidReason: null,
    voidedBy: null,
    voidedAt: null,
    createdBy: ME,
    lines: [],
    allocations: [],
    adjustments: [],
    _lineMeta: {},
    _invDiscount: null,
    _copies: 0,
  };
  db.invoices.unshift(inv);
  return inv;
}

function ledger(
  kind: LedgerEntryResponse["kind"],
  patientId: string,
  branchId: string,
  amountPaise: number,
  refs: Partial<LedgerEntryResponse>,
  at = nowIso(),
) {
  db.ledger.push({
    id: newId("5d"),
    branchId,
    patientId,
    kind,
    amountPaise,
    invoiceId: null,
    paymentId: null,
    refundId: null,
    adjustmentId: null,
    occurredAt: at,
    createdBy: ME,
    ...refs,
  });
}

function issue(inv: Inv, dueDate?: string, at = nowIso()) {
  requireDraft(inv);
  if (inv.lines.length === 0) fail(409, "invoice_empty");
  const s = settingsFor(inv.branchId);
  inv.number = nextNumber(inv.branchId, "INV");
  inv.issuedAt = at;
  inv.issuedBy = ME;
  inv.dueDate = dueDate ?? inv.dueDate ?? plusDays(dayOf(at), s.invoiceDueDays);
  inv.status = inv.totalPaise === 0 ? "PAID" : "ISSUED";
  inv.balancePaise = inv.totalPaise;
  ledger("INVOICE", inv.patientId, inv.branchId, inv.totalPaise, { invoiceId: inv.id }, at);
}

const withTotals = (p: PaymentDetailResponse) => {
  paymentTotals(p);
  return p;
};
function paymentTotals(p: PaymentDetailResponse) {
  const net = p.allocations.reduce((s, a) => s + a.amountPaise, 0);
  const refunded = p.refunds
    .filter((r) => r.status === "PROCESSED")
    .reduce((s, r) => s + r.amountPaise, 0);
  const pendingAdvance = p.refunds
    .filter((r) => (r.status === "REQUESTED" || r.status === "APPROVED") && !r.invoiceId)
    .reduce((s, r) => s + r.amountPaise, 0);
  p.allocatedPaise = net;
  p.refundedPaise = refunded;
  p.unallocatedPaise = p.amountPaise - refunded - pendingAdvance - net;
}

function allocate(
  p: PaymentDetailResponse,
  items: { invoiceId: string; amountPaise: number }[],
  at = nowIso(),
) {
  const sum = items.reduce((s, a) => s + a.amountPaise, 0);
  paymentTotals(p);
  if (sum > p.unallocatedPaise) fail(409, "allocation_exceeds_payment");
  for (const a of items) {
    const inv = findInvoice(a.invoiceId);
    if (inv.patientId !== p.patientId || inv.branchId !== p.branchId)
      fail(409, "link_mismatch", { constraint: "PaymentAllocation_invoice_patient_branch" });
    if (inv.status === "DRAFT" || inv.status === "VOID")
      fail(409, "invoice_not_payable", { status: inv.status });
    if (a.amountPaise > inv.balancePaise)
      fail(409, "invoice_overpaid", { balancePaise: inv.balancePaise });
  }
  for (const a of items) {
    const inv = findInvoice(a.invoiceId);
    const alloc = {
      id: newId("5c"),
      paymentId: p.id,
      invoiceId: inv.id,
      amountPaise: a.amountPaise,
      refundId: null,
      allocatedBy: ME,
      createdAt: at,
    };
    p.allocations.push(alloc);
    inv.allocations.push(alloc);
    inv.paidPaise += a.amountPaise;
    refreshStatus(inv);
  }
  paymentTotals(p);
}

// ---- Seed -------------------------------------------------------------------------------------------------

function seed() {
  const svc = (code: string) => services.find((s) => s.code === code)?.id as string;
  const mk = (patientId: string, ago: number, items: [string, number][]) => {
    const inv = newInvoice({ patientId, branchId: B1 });
    for (const [code, q] of items)
      addLine(inv, invoiceLineInput.parse({ serviceId: svc(code), quantity: q }));
    recompute(inv);
    issue(inv, undefined, daysAgoIso(ago));
    inv.createdAt = daysAgoIso(ago);
    return inv;
  };
  const pay = (
    patientId: string,
    amountPaise: number,
    method: "CASH" | "UPI" | "CARD",
    ago: number,
    to: { inv: Inv; amount: number }[],
    adv = 0,
  ) => {
    const at = daysAgoIso(ago, 14);
    const p: PaymentDetailResponse = {
      id: newId("5b"),
      branchId: B1,
      patientId,
      method,
      amountPaise,
      reference: method === "UPI" ? "UPI-348201" : null,
      receivedAt: at,
      receivedBy: ME,
      gateway: "MANUAL",
      gatewayRef: null,
      status: "RECORDED",
      receiptNumber: nextNumber(B1, "RCP"),
      notes: null,
      allocatedPaise: 0,
      refundedPaise: 0,
      unallocatedPaise: 0,
      createdAt: at,
      allocations: [],
      refunds: [],
    };
    db.payments.unshift(p);
    ledger("PAYMENT", patientId, B1, -amountPaise, { paymentId: p.id }, at);
    allocate(
      p,
      to.map((t) => ({ invoiceId: t.inv.id, amountPaise: t.amount })),
      at,
    );
    if (adv > 0)
      db.credit.unshift({
        id: newId("5a"),
        patientId,
        branchId: B1,
        kind: "ADVANCE",
        amountPaise: adv,
        paymentId: p.id,
        allocationId: null,
        refundId: null,
        reason: null,
        createdBy: ME,
        createdAt: at,
      });
    return p;
  };
  const a = mk(P41, 12, [
    ["SCAL", 1],
    ["CONS", 1],
  ]);
  pay(P41, a.totalPaise, "CASH", 12, [{ inv: a, amount: a.totalPaise }]);
  const b = mk(P41, 5, [["RCT-MOL", 1]]);
  pay(P41, 400_000, "UPI", 4, [{ inv: b, amount: 400_000 }]);
  mk(P3, 20, [["COMP-1", 2]]);
  pay(P3, 500_000, "CARD", 1, [], 500_000);
  const d = newInvoice({ patientId: P3, branchId: B1 });
  addLine(d, invoiceLineInput.parse({ serviceId: svc("OPG") }));
  recompute(d);
}
seed();

// ---- Routing ------------------------------------------------------------------------------------------------

type Handler = (m: string[], q: Record<string, string>, body: unknown) => unknown;
const table: [Method, RegExp, Handler][] = [];
const on = (method: Method, pattern: string, h: Handler) =>
  table.push([method, new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`), h]);

const inRange = (iso: string | null, q: Record<string, string>) => {
  if (!iso) return !q.from && !q.to;
  const d = dayOf(iso);
  return (!q.from || d >= q.from) && (!q.to || d <= q.to);
};

// Settings ---------------------------------------------------------------------------------------------------
on("GET", "/billing/settings", (_m, q) => ({
  branchId: q.branchId ?? null,
  stored: q.branchId ? (branchBilling[q.branchId] ?? {}) : tenantBilling,
  effective: settingsFor(q.branchId),
}));
on("PATCH", "/billing/settings", (_m, q, b) => {
  if (q.branchId) {
    const patch = parse(branchBillingSettings, b);
    branchBilling[q.branchId] = { ...(branchBilling[q.branchId] ?? {}), ...patch };
  } else {
    tenantBilling = { ...tenantBilling, ...parse(tenantBillingSettings, b) };
  }
  return {
    branchId: q.branchId ?? null,
    stored: q.branchId ? (branchBilling[q.branchId] ?? {}) : tenantBilling,
    effective: settingsFor(q.branchId),
  };
});

// Estimates --------------------------------------------------------------------------------------------------
on("GET", "/estimates", async (_m, q) => {
  const plan = (await clinicalMockHandler(
    "GET",
    `${API_PREFIX}/plans/${q.planId}`,
    {},
    undefined,
  )) as {
    id: string;
    patientId: string;
    branchId: string;
    currentVersion: number;
    items: {
      id: string;
      serviceId: string;
      toothCode: number | null;
      quantity: number;
      estimatePricePaise: number;
      status: string;
    }[];
  };
  const s = settingsFor(plan.branchId);
  const billedIds = new Set(
    db.invoices.filter((i) => i.status !== "VOID").flatMap((i) => i.lines.map((l) => l.planItemId)),
  );
  const lines = plan.items.map((it) => {
    const svc = services.find((x) => x.id === it.serviceId);
    const rate = lineTaxRateBp(
      svc ? { taxable: svc.taxable, gstRateBp: null } : null,
      s.defaultGstRateBp,
    );
    const t = computeInvoiceTotals({
      lines: [{ quantity: it.quantity, unitPricePaise: it.estimatePricePaise, taxRateBp: rate }],
      taxInclusive: s.taxInclusive,
      interState: false,
    });
    return {
      planItemId: it.id,
      serviceId: it.serviceId,
      description: svc?.name ?? "Treatment",
      toothCode: it.toothCode,
      quantity: it.quantity,
      unitPricePaise: it.estimatePricePaise,
      grossPaise: t.subtotalPaise,
      taxRateBp: rate,
      taxPaise: t.taxPaise,
      totalPaise: t.totalPaise,
      status: it.status,
      billed: billedIds.has(it.id),
    };
  });
  return {
    planId: plan.id,
    planVersion: plan.currentVersion,
    patientId: plan.patientId,
    branchId: plan.branchId,
    taxInclusive: s.taxInclusive,
    lines,
    subtotalPaise: lines.reduce((a, l) => a + l.grossPaise, 0),
    taxPaise: lines.reduce((a, l) => a + l.taxPaise, 0),
    totalPaise: lines.reduce((a, l) => a + l.totalPaise, 0),
  };
});

// Invoices ---------------------------------------------------------------------------------------------------
on("GET", "/invoices", (_m, q) =>
  paginate(
    db.invoices
      .filter(
        (i) =>
          (!q.branchId || i.branchId === q.branchId) &&
          (!q.patientId || i.patientId === q.patientId) &&
          (!q.planId || i.planId === q.planId) &&
          (!q.status || i.status === q.status) &&
          (!q.q || (i.number ?? "").startsWith(q.q)) &&
          inRange(i.issuedAt ?? i.createdAt, q) &&
          (q.overdue !== "true" ||
            ((i.status === "ISSUED" || i.status === "PARTIALLY_PAID") &&
              i.balancePaise > 0 &&
              (i.dueDate ?? "9999") < localToday())),
      )
      .map(summary),
    q,
  ),
);
on("POST", "/invoices", (_m, _q, b) => {
  const body = parse(createInvoiceRequest, b);
  const inv = newInvoice({
    ...body,
    planId: body.planId ?? null,
    encounterId: body.encounterId ?? null,
  });
  for (const l of body.lines ?? []) addLine(inv, l);
  if (body.invoiceDiscount) {
    if (!body.discountReason) fail(400, "discount_reason_required");
    inv._invDiscount = body.invoiceDiscount;
    inv.discountReason = body.discountReason ?? null;
  }
  recompute(inv);
  return strip(inv);
});
on("POST", "/invoices/from-plan", async (_m, _q, b) => {
  const body = parse(createInvoiceFromPlanRequest, b);
  const est = (await table.find(([m, re]) => m === "GET" && re.test("/estimates"))?.[2]?.(
    [],
    { planId: body.planId },
    undefined,
  )) as Awaited<ReturnType<Handler>> & {
    patientId: string;
    branchId: string;
    planVersion: number;
    lines: {
      planItemId: string;
      serviceId: string;
      quantity: number;
      unitPricePaise: number;
      billed: boolean;
      status: string;
      toothCode: number | null;
    }[];
  };
  const billable = new Set(["ACCEPTED", "SCHEDULED", "IN_PROGRESS", "COMPLETED"]);
  const pick = est.lines.filter((l) =>
    body.planItemIds
      ? body.planItemIds.includes(l.planItemId)
      : billable.has(l.status) && !l.billed,
  );
  if (body.planItemIds && pick.length !== body.planItemIds.length) fail(404, "plan_item_not_found");
  if (pick.some((l) => !billable.has(l.status))) fail(409, "plan_item_not_billable");
  if (pick.some((l) => l.billed)) fail(409, "plan_item_already_billed");
  if (pick.length === 0) fail(409, "plan_nothing_to_bill");
  const inv = newInvoice({
    patientId: est.patientId,
    branchId: est.branchId,
    dueDate: body.dueDate,
    placeOfSupplyStateCode: body.placeOfSupplyStateCode,
    notes: body.notes,
    planId: body.planId,
    encounterId: body.encounterId ?? null,
  });
  inv.planVersion = est.planVersion;
  for (const l of pick) {
    const line = addLine(
      inv,
      invoiceLineInput.parse({
        serviceId: l.serviceId,
        quantity: l.quantity,
        planItemId: l.planItemId,
        toothCode: l.toothCode ?? undefined,
      }),
    );
    line.unitPricePaise = l.unitPricePaise;
  }
  recompute(inv);
  return strip(inv);
});
on("GET", "/invoices/:id", ([id]) => strip(findInvoice(id)));
on("GET", "/invoices/:id/print", ([id]) => {
  const inv = findInvoice(id);
  if (inv.status === "DRAFT" || !inv.number) fail(409, "invoice_not_issued");
  const branch = branches.find((b) => b.id === inv.branchId);
  const pat = patients.find((p) => p.id === inv.patientId);
  const copy = inv._copies++ === 0 ? ("ORIGINAL" as const) : ("DUPLICATE" as const);
  return {
    invoice: strip(inv),
    supplier: {
      name: "DentalOS Demo Dental Group",
      branchName: branch?.name ?? "Branch",
      branchCode: branch?.code ?? "BR",
      gstin: inv.supplierGstin,
      stateCode: inv.supplierStateCode,
      addressLines: [
        branch?.addressLine1 ?? "",
        [branch?.city, branch?.postalCode].filter(Boolean).join(" "),
      ].filter(Boolean),
      phone: branch?.phone ?? null,
    },
    patient: {
      name: patientName(inv.patientId) ?? "Patient",
      phone: pat?.phone ?? null,
      mrn: pat?.mrn ?? null,
    },
    taxSummary: summarizeTax(inv.lines),
    amountInWords: amountInWordsINR(inv.totalPaise + inv.adjustmentPaise),
    copy,
  };
});
on("PATCH", "/invoices/:id", ([id], _q, b) => {
  const inv = findInvoice(id);
  requireDraft(inv);
  const body = parse(updateInvoiceRequest, b);
  if (body.dueDate !== undefined) inv.dueDate = body.dueDate;
  if (body.placeOfSupplyStateCode !== undefined)
    inv.placeOfSupplyStateCode = body.placeOfSupplyStateCode;
  if (body.notes !== undefined) inv.notes = body.notes ?? null;
  recompute(inv);
  return strip(inv);
});
on("PUT", "/invoices/:id/discount", ([id], _q, b) => {
  const inv = findInvoice(id);
  requireDraft(inv);
  const body = parse(setInvoiceDiscountRequest, b);
  if (body.discount && !body.reason) fail(400, "discount_reason_required");
  inv._invDiscount = body.discount;
  inv.discountReason = body.discount ? (body.reason ?? null) : null;
  recompute(inv);
  return strip(inv);
});
on("POST", "/invoices/:id/lines", ([id], _q, b) => {
  const inv = findInvoice(id);
  requireDraft(inv);
  addLine(inv, parse(invoiceLineInput, b));
  recompute(inv);
  return strip(inv);
});
on("PATCH", "/invoices/:id/lines/:lineId", ([id, lineId], _q, b) => {
  const inv = findInvoice(id);
  requireDraft(inv);
  const line = inv.lines.find((l) => l.id === lineId);
  if (!line) return fail(404, "invoice_line_not_found");
  const body = parse(updateInvoiceLineRequest, b);
  if (body.unitPricePaise !== undefined) {
    if (line.serviceId || line.planItemId) fail(400, "price_override_not_allowed");
    line.unitPricePaise = body.unitPricePaise;
  }
  if (body.description !== undefined) line.description = body.description;
  if (body.quantity !== undefined) line.quantity = body.quantity;
  if (body.discount !== undefined) {
    if (body.discount && !(body.discountReason ?? line.discountReason))
      fail(400, "discount_reason_required");
    inv._lineMeta[line.id] = { discount: body.discount };
  }
  if (body.discountReason !== undefined) line.discountReason = body.discountReason;
  recompute(inv);
  return strip(inv);
});
on("DELETE", "/invoices/:id/lines/:lineId", ([id, lineId]) => {
  const inv = findInvoice(id);
  requireDraft(inv);
  if (!inv.lines.some((l) => l.id === lineId)) fail(404, "invoice_line_not_found");
  inv.lines = inv.lines.filter((l) => l.id !== lineId);
  inv.lines.forEach((l, i) => {
    l.lineNo = i + 1;
  });
  inv._lineMeta = Object.fromEntries(Object.entries(inv._lineMeta).filter(([k]) => k !== lineId));
  recompute(inv);
  return strip(inv);
});
on("POST", "/invoices/:id/issue", ([id], _q, b) => {
  const inv = findInvoice(id);
  const body = parse(issueInvoiceRequest, b);
  issue(inv, body.dueDate);
  return strip(inv);
});
on("POST", "/invoices/:id/void", ([id], _q, b) => {
  const inv = findInvoice(id);
  const body = parse(voidInvoiceRequest, b);
  if (inv.status === "VOID") fail(409, "invoice_invalid_transition", { status: "VOID" });
  if (inv.status !== "DRAFT" && inv.status !== "ISSUED")
    fail(409, "invoice_not_voidable", { status: inv.status });
  if (inv.paidPaise !== 0 || inv.adjustmentPaise !== 0) fail(409, "invoice_not_voidable");
  const wasIssued = inv.status === "ISSUED";
  inv.status = "VOID";
  inv.voidReason = body.reason;
  inv.voidedBy = ME;
  inv.voidedAt = nowIso();
  inv.balancePaise = 0;
  if (wasIssued)
    ledger("INVOICE_VOID", inv.patientId, inv.branchId, -inv.totalPaise, { invoiceId: inv.id });
  return strip(inv);
});
on("POST", "/invoices/:id/adjustments", ([id], _q, b) => {
  const inv = findInvoice(id);
  const body = parse(issueAdjustmentRequest, b);
  const hit = db.keys.get(`adj:${body.idempotencyKey}`);
  if (hit) {
    if (hit.fp !== JSON.stringify(body)) fail(409, "idempotency_conflict");
    return db.adjustments.find((a) => a.id === hit.id);
  }
  if (inv.status === "DRAFT" || inv.status === "VOID")
    fail(409, "invoice_not_adjustable", { status: inv.status });
  if ((body.taxPaise ?? 0) > body.amountPaise) fail(400, "tax_exceeds_amount");
  if (body.kind === "CREDIT" && body.amountPaise > inv.balancePaise)
    fail(409, "invoice_overpaid", { balancePaise: inv.balancePaise });
  const adj: AdjustmentResponse = {
    id: newId("59"),
    invoiceId: inv.id,
    branchId: inv.branchId,
    kind: body.kind,
    number: nextNumber(inv.branchId, body.kind === "CREDIT" ? "CN" : "DN"),
    amountPaise: body.amountPaise,
    taxPaise: body.taxPaise ?? 0,
    reason: body.reason,
    issuedBy: ME,
    issuedAt: nowIso(),
  };
  db.adjustments.unshift(adj);
  inv.adjustments.push(adj);
  inv.adjustmentPaise += body.kind === "CREDIT" ? -body.amountPaise : body.amountPaise;
  refreshStatus(inv);
  ledger(
    body.kind === "CREDIT" ? "CREDIT_NOTE" : "DEBIT_NOTE",
    inv.patientId,
    inv.branchId,
    body.kind === "CREDIT" ? -body.amountPaise : body.amountPaise,
    { invoiceId: inv.id, adjustmentId: adj.id },
  );
  db.keys.set(`adj:${body.idempotencyKey}`, { fp: JSON.stringify(body), id: adj.id });
  return adj;
});
on("GET", "/adjustments", (_m, q) =>
  paginate(
    db.adjustments.filter(
      (a) =>
        (!q.branchId || a.branchId === q.branchId) &&
        (!q.invoiceId || a.invoiceId === q.invoiceId) &&
        (!q.kind || a.kind === q.kind) &&
        (!q.patientId || findInvoice(a.invoiceId).patientId === q.patientId) &&
        inRange(a.issuedAt, q),
    ),
    q,
  ),
);

// Payments ---------------------------------------------------------------------------------------------------
const paymentSummary = (p: PaymentDetailResponse) => {
  paymentTotals(p);
  const { allocations, refunds, ...rest } = p;
  void allocations;
  void refunds;
  return rest;
};
on("GET", "/payments", (_m, q) =>
  paginate(
    db.payments
      .filter(
        (p) =>
          (!q.branchId || p.branchId === q.branchId) &&
          (!q.patientId || p.patientId === q.patientId) &&
          (!q.method || p.method === q.method) &&
          (!q.status || p.status === q.status) &&
          inRange(p.receivedAt, q) &&
          (q.hasAdvance === undefined ||
            withTotals(p).unallocatedPaise > 0 === (q.hasAdvance === "true")),
      )
      .map(paymentSummary),
    q,
  ),
);
on("POST", "/payments", (_m, _q, b) => {
  const body = parse(recordPaymentRequest, b);
  const fp = JSON.stringify(body);
  const hit = db.keys.get(`pay:${body.idempotencyKey}`);
  if (hit) {
    if (hit.fp !== fp) fail(409, "idempotency_conflict");
    return db.payments.find((p) => p.id === hit.id);
  }
  const s = settingsFor(body.branchId);
  if (!s.allowedPaymentMethods.includes(body.method))
    fail(400, "payment_method_not_allowed", { method: body.method });
  if (!patients.find((p) => p.id === body.patientId)) fail(404, "patient_not_found");
  const at = body.receivedAt ?? nowIso();
  const p: PaymentDetailResponse = {
    id: newId("5b"),
    branchId: body.branchId,
    patientId: body.patientId,
    method: body.method,
    amountPaise: body.amountPaise,
    reference: body.reference ?? null,
    receivedAt: at,
    receivedBy: ME,
    gateway: "MANUAL",
    gatewayRef: null,
    status: "RECORDED",
    receiptNumber: nextNumber(body.branchId, "RCP"),
    notes: body.notes ?? null,
    allocatedPaise: 0,
    refundedPaise: 0,
    unallocatedPaise: body.amountPaise,
    createdAt: nowIso(),
    allocations: [],
    refunds: [],
  };
  let items = body.allocations ?? [];
  if (items.length === 0 && body.autoAllocate) {
    let left = body.amountPaise;
    items = db.invoices
      .filter(
        (i) =>
          i.patientId === body.patientId &&
          i.branchId === body.branchId &&
          (i.status === "ISSUED" || i.status === "PARTIALLY_PAID"),
      )
      .sort((a, c) => (a.issuedAt ?? "").localeCompare(c.issuedAt ?? ""))
      .flatMap((i) => {
        const take = Math.min(left, i.balancePaise);
        left -= take;
        return take > 0 ? [{ invoiceId: i.id, amountPaise: take }] : [];
      });
  }
  const sum = items.reduce((a, x) => a + x.amountPaise, 0);
  if (sum > body.amountPaise) fail(409, "allocation_exceeds_payment");
  if (body.amountPaise - sum > 0 && !s.allowAdvancePayments) fail(409, "advance_not_allowed");
  allocate(p, items, at);
  db.payments.unshift(p);
  ledger("PAYMENT", p.patientId, p.branchId, -p.amountPaise, { paymentId: p.id }, at);
  if (body.amountPaise - sum > 0)
    db.credit.unshift({
      id: newId("5a"),
      patientId: p.patientId,
      branchId: p.branchId,
      kind: "ADVANCE",
      amountPaise: body.amountPaise - sum,
      paymentId: p.id,
      allocationId: null,
      refundId: null,
      reason: null,
      createdBy: ME,
      createdAt: at,
    });
  db.keys.set(`pay:${body.idempotencyKey}`, { fp, id: p.id });
  return p;
});
on("POST", "/payments/gateway/checkout", (_m, _q, b) => {
  const body = parse(createGatewayCheckoutRequest, b);
  const hit = db.keys.get(`pay:${body.idempotencyKey}`);
  const existing = hit ? db.payments.find((p) => p.id === hit.id) : undefined;
  const gatewayRef = `stub_${btoa(body.idempotencyKey).replace(/=/g, "").slice(0, 40)}`;
  if (existing && hit?.fp !== JSON.stringify(body)) fail(409, "idempotency_conflict");
  if (settingsFor(body.branchId).gatewayProvider === "MANUAL") fail(409, "gateway_not_configured");
  const p =
    existing ??
    ({
      id: newId("5b"),
      branchId: body.branchId,
      patientId: body.patientId,
      method: "OTHER",
      amountPaise: body.amountPaise,
      reference: null,
      receivedAt: nowIso(),
      receivedBy: ME,
      gateway: "STUB",
      gatewayRef,
      status: "PENDING",
      receiptNumber: null,
      notes: null,
      allocatedPaise: 0,
      refundedPaise: 0,
      unallocatedPaise: body.amountPaise,
      createdAt: nowIso(),
      allocations: [],
      refunds: [],
    } satisfies PaymentDetailResponse);
  if (!existing) {
    db.payments.unshift(p);
    db.keys.set(`pay:${body.idempotencyKey}`, { fp: JSON.stringify(body), id: p.id });
  }
  return {
    paymentId: p.id,
    gateway: "STUB",
    status: p.status,
    gatewayRef,
    checkoutUrl: `https://stub-gateway.invalid/checkout/${encodeURIComponent(gatewayRef)}`,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
});
on("GET", "/payments/:id", ([id]) => {
  const p = findPayment(id);
  paymentTotals(p);
  return p;
});
on("POST", "/payments/:id/allocate", ([id], _q, b) => {
  const p = findPayment(id);
  const body = parse(allocatePaymentRequest, b);
  if (p.status !== "RECORDED") fail(409, "payment_not_recorded");
  const hit = db.keys.get(`alloc:${body.idempotencyKey}`);
  if (hit) {
    if (hit.fp !== JSON.stringify(body)) fail(409, "idempotency_conflict");
    return p;
  }
  allocate(p, body.allocations);
  db.keys.set(`alloc:${body.idempotencyKey}`, { fp: JSON.stringify(body), id: p.id });
  return p;
});

// Patient account --------------------------------------------------------------------------------------------
const creditView = (patientId: string, limit: number) => ({
  patientId,
  balancePaise: db.credit
    .filter((c) => c.patientId === patientId)
    .reduce((s, c) => s + c.amountPaise, 0),
  entries: db.credit.filter((c) => c.patientId === patientId).slice(0, limit),
});
on("GET", "/patients/:id/credit", ([id], q) => creditView(id as string, Number(q.limit ?? 50)));
on("POST", "/patients/:id/credit/adjust", ([id], _q, b) => {
  const body = parse(adjustPatientCreditRequest, b);
  const bal = creditView(id as string, 1).balancePaise;
  if (bal + body.amountPaise < 0) fail(409, "credit_insufficient");
  db.credit.unshift({
    id: newId("5a"),
    patientId: id as string,
    branchId: body.branchId,
    kind: "ADJUSTMENT",
    amountPaise: body.amountPaise,
    paymentId: null,
    allocationId: null,
    refundId: null,
    reason: body.reason,
    createdBy: ME,
    createdAt: nowIso(),
  });
  return creditView(id as string, 50);
});
on("POST", "/patients/:id/advance/apply", ([id], _q, b) => {
  const body = parse(applyAdvanceRequest, b);
  const inv = findInvoice(body.invoiceId);
  if (inv.status !== "ISSUED" && inv.status !== "PARTIALLY_PAID")
    fail(409, "invoice_not_payable", { status: inv.status });
  if (body.amountPaise > inv.balancePaise)
    fail(409, "invoice_overpaid", { balancePaise: inv.balancePaise });
  const held = db.payments
    .filter((p) => p.patientId === id && p.branchId === inv.branchId && p.status === "RECORDED")
    .map(withTotals)
    .filter((p) => p.unallocatedPaise > 0)
    .sort((a, c) => a.receivedAt.localeCompare(c.receivedAt));
  if (held.reduce((s, p) => s + p.unallocatedPaise, 0) < body.amountPaise)
    fail(409, "credit_insufficient");
  let left = body.amountPaise;
  for (const p of held) {
    if (left <= 0) break;
    const take = Math.min(left, p.unallocatedPaise);
    allocate(p, [{ invoiceId: inv.id, amountPaise: take }]);
    left -= take;
  }
  db.credit.unshift({
    id: newId("5a"),
    patientId: id as string,
    branchId: inv.branchId,
    kind: "APPLIED",
    amountPaise: -body.amountPaise,
    paymentId: null,
    allocationId: null,
    refundId: null,
    reason: null,
    createdBy: ME,
    createdAt: nowIso(),
  });
  return strip(inv);
});
on("GET", "/patients/:id/statement", ([id], q) => {
  const all = db.ledger
    .filter((e) => e.patientId === id && (!q.branchId || e.branchId === q.branchId))
    .sort((a, c) => a.occurredAt.localeCompare(c.occurredAt));
  const opening = q.from
    ? all
        .filter((e) => dayOf(e.occurredAt) < (q.from as string))
        .reduce((s, e) => s + e.amountPaise, 0)
    : 0;
  let running = opening;
  const entries = all
    .filter((e) => inRange(e.occurredAt, q))
    .map((e) => {
      running += e.amountPaise;
      return { ...e, runningBalancePaise: running };
    });
  return {
    patientId: id,
    from: q.from ?? null,
    to: q.to ?? null,
    openingBalancePaise: opening,
    entries,
    closingBalancePaise: running,
    outstandingInvoices: db.invoices
      .filter(
        (i) =>
          i.patientId === id &&
          (i.status === "ISSUED" || i.status === "PARTIALLY_PAID") &&
          (!q.branchId || i.branchId === q.branchId),
      )
      .map(summary),
    advanceBalancePaise: creditView(id as string, 1).balancePaise,
  };
});

// Refunds ----------------------------------------------------------------------------------------------------
const reserveRefund = (r: RefundResponse) => {
  findPayment(r.paymentId).refunds.push(r);
};
on("GET", "/refunds", (_m, q) =>
  paginate(
    db.refunds.filter(
      (r) =>
        (!q.branchId || r.branchId === q.branchId) &&
        (!q.patientId || r.patientId === q.patientId) &&
        (!q.paymentId || r.paymentId === q.paymentId) &&
        (!q.status || r.status === q.status) &&
        inRange(r.requestedAt, q),
    ),
    q,
  ),
);
on("GET", "/refunds/:id", ([id]) => findRefund(id));
on("POST", "/refunds", (_m, _q, b) => {
  const body = parse(requestRefundRequest, b);
  const hit = db.keys.get(`ref:${body.idempotencyKey}`);
  if (hit) {
    if (hit.fp !== JSON.stringify(body)) fail(409, "idempotency_conflict");
    return findRefund(hit.id);
  }
  const p = findPayment(body.paymentId);
  if (p.status !== "RECORDED") fail(409, "payment_not_recorded");
  paymentTotals(p);
  if (body.amountPaise > refundablePaise(p.amountPaise, p.refunds))
    fail(409, "refund_exceeds_payment");
  if (body.invoiceId) {
    const inv = findInvoice(body.invoiceId);
    const net = p.allocations
      .filter((a) => a.invoiceId === inv.id)
      .reduce((s, a) => s + a.amountPaise, 0);
    const pending = p.refunds
      .filter((r) => r.invoiceId === inv.id && r.status !== "REJECTED")
      .reduce((s, r) => s + r.amountPaise, 0);
    if (body.amountPaise > net - pending) fail(409, "refund_exceeds_allocation");
  } else if (body.amountPaise > p.unallocatedPaise) {
    fail(409, "refund_exceeds_payment");
  }
  const auto = !refundNeedsApproval(
    body.amountPaise,
    settingsFor(p.branchId).refundApprovalThresholdPaise,
  );
  const r: RefundResponse = {
    id: newId("58"),
    branchId: p.branchId,
    patientId: p.patientId,
    paymentId: p.id,
    invoiceId: body.invoiceId ?? null,
    amountPaise: body.amountPaise,
    method: body.method ?? p.method,
    reference: null,
    reason: body.reason,
    status: auto ? "APPROVED" : "REQUESTED",
    requestedBy: ME,
    requestedAt: nowIso(),
    approvedBy: auto ? ME : null,
    approvedAt: auto ? nowIso() : null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    processedBy: null,
    processedAt: null,
    gateway: p.gateway === "STUB" ? "STUB" : "MANUAL",
    gatewayRef: null,
    createdAt: nowIso(),
  };
  db.refunds.unshift(r);
  reserveRefund(r);
  db.keys.set(`ref:${body.idempotencyKey}`, { fp: JSON.stringify(body), id: r.id });
  return r;
});
on("POST", "/refunds/:id/approve", ([id]) => {
  const r = findRefund(id);
  if (r.status !== "REQUESTED") fail(409, "refund_invalid_state", { status: r.status });
  if (r.requestedBy === ME && settingsFor(r.branchId).separateApprover)
    fail(409, "refund_self_approval");
  Object.assign(r, { status: "APPROVED", approvedBy: ME, approvedAt: nowIso() });
  return r;
});
on("POST", "/refunds/:id/reject", ([id], _q, b) => {
  const r = findRefund(id);
  const body = parse(rejectRefundRequest, b);
  if (r.status !== "REQUESTED" && r.status !== "APPROVED")
    fail(409, "refund_invalid_state", { status: r.status });
  Object.assign(r, {
    status: "REJECTED",
    rejectedBy: ME,
    rejectedAt: nowIso(),
    rejectionReason: body.reason,
  });
  return r;
});
on("POST", "/refunds/:id/process", ([id], _q, b) => {
  const r = findRefund(id);
  const body = (b ?? {}) as { reference?: string; method?: RefundResponse["method"] };
  if (r.status === "REQUESTED") fail(409, "refund_approval_required");
  if (r.status !== "APPROVED") fail(409, "refund_invalid_state", { status: r.status });
  if (r.gateway !== "MANUAL") fail(409, "refund_gateway_confirmation_required");
  Object.assign(r, {
    status: "PROCESSED",
    processedBy: ME,
    processedAt: nowIso(),
    reference: body.reference ?? r.reference,
    method: body.method ?? r.method,
  });
  if (r.invoiceId) {
    const inv = findInvoice(r.invoiceId);
    const p = findPayment(r.paymentId);
    const alloc = {
      id: newId("5c"),
      paymentId: p.id,
      invoiceId: inv.id,
      amountPaise: -r.amountPaise,
      refundId: r.id,
      allocatedBy: ME,
      createdAt: nowIso(),
    };
    p.allocations.push(alloc);
    inv.allocations.push(alloc);
    inv.paidPaise -= r.amountPaise;
    refreshStatus(inv);
  }
  paymentTotals(findPayment(r.paymentId));
  ledger("REFUND", r.patientId, r.branchId, r.amountPaise, {
    refundId: r.id,
    paymentId: r.paymentId,
  });
  return r;
});

// Reports ----------------------------------------------------------------------------------------------------
on("GET", "/reports/revenue", (_m, q) => {
  const from = q.from ?? "";
  const to = q.to ?? "";
  if (!from || !to) fail(400, "validation_failed");
  if (to < from) fail(400, "invalid_range");
  const groupBy = q.groupBy ?? "branch";
  const keyOf = (iso: string, branchId: string, method?: string) =>
    groupBy === "branch"
      ? branchId
      : groupBy === "day"
        ? dayOf(iso)
        : groupBy === "method"
          ? (method ?? "OTHER")
          : "UNATTRIBUTED";
  type R = {
    billedPaise: number;
    discountPaise: number;
    taxPaise: number;
    collectedPaise: number;
    refundedPaise: number;
    netCollectedPaise: number;
    outstandingPaise: number;
  };
  const rows = new Map<string, R>();
  const zero = (): R => ({
    billedPaise: 0,
    discountPaise: 0,
    taxPaise: 0,
    collectedPaise: 0,
    refundedPaise: 0,
    netCollectedPaise: 0,
    outstandingPaise: 0,
  });
  const row = (k: string) => {
    const found = rows.get(k);
    if (found) return found;
    const fresh = zero();
    rows.set(k, fresh);
    return fresh;
  };
  const inScope = (branchId: string) => !q.branchId || q.branchId === branchId;
  const inQ = (iso: string | null) =>
    Boolean(iso) && dayOf(iso as string) >= from && dayOf(iso as string) <= to;
  const total = zero();
  for (const i of db.invoices)
    if (
      ["ISSUED", "PARTIALLY_PAID", "PAID"].includes(i.status) &&
      inScope(i.branchId) &&
      inQ(i.issuedAt) &&
      groupBy !== "method"
    ) {
      for (const r of [row(keyOf(i.issuedAt as string, i.branchId)), total]) {
        r.billedPaise += i.totalPaise + i.adjustmentPaise;
        r.discountPaise += i.discountPaise;
        r.taxPaise += i.taxPaise;
        if (i.status !== "PAID") r.outstandingPaise += i.balancePaise;
      }
    }
  for (const p of db.payments)
    if (p.status === "RECORDED" && inScope(p.branchId) && inQ(p.receivedAt))
      for (const r of [row(keyOf(p.receivedAt, p.branchId, p.method)), total])
        r.collectedPaise += p.amountPaise;
  for (const rf of db.refunds)
    if (rf.status === "PROCESSED" && inScope(rf.branchId) && inQ(rf.processedAt))
      for (const r of [row(keyOf(rf.processedAt as string, rf.branchId, rf.method)), total])
        r.refundedPaise += rf.amountPaise;
  for (const r of [...rows.values(), total])
    r.netCollectedPaise = r.collectedPaise - r.refundedPaise;
  return {
    from,
    to,
    groupBy,
    rows: [...rows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, r]) => ({
        key,
        label: groupBy === "branch" ? (branches.find((b) => b.id === key)?.name ?? null) : null,
        ...r,
      })),
    totals: total,
  };
});

export const billingMockHandler: MockHandler = async (method, fullPath, query, body) => {
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) : fullPath;
  for (const [m, re, h] of table) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (match) {
      await sleep(LATENCY_MS);
      return structuredClone(await h(match.slice(1).map(decodeURIComponent), query, body));
    }
  }
  return clinicalMockHandler(method, fullPath, query, body);
};
