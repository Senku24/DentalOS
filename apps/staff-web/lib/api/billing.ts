import type {
  AdjustPatientCreditRequest,
  AdjustmentResponse,
  AllocatePaymentRequest,
  ApplyAdvanceRequest,
  ApproveRefundRequest,
  BillingSettingsResponse,
  BranchBillingSettings,
  CreateGatewayCheckoutRequest,
  CreateInvoiceFromPlanRequest,
  CreateInvoiceRequest,
  EstimateResponse,
  GatewayCheckoutResponse,
  InvoiceDetailResponse,
  InvoiceLineInput,
  InvoicePrintResponse,
  InvoiceSummary,
  IssueAdjustmentRequest,
  IssueInvoiceRequest,
  ListAdjustmentsQuery,
  ListInvoicesQuery,
  ListPaymentsQuery,
  ListRefundsQuery,
  PatientCreditResponse,
  PatientStatementQuery,
  PatientStatementResponse,
  PaymentDetailResponse,
  PaymentResponse,
  ProcessRefundRequest,
  RecordPaymentRequest,
  RefundResponse,
  RejectRefundRequest,
  RequestRefundRequest,
  RevenueReportQuery,
  RevenueReportResponse,
  SetInvoiceDiscountRequest,
  TenantBillingSettings,
  UpdateInvoiceLineRequest,
  UpdateInvoiceRequest,
  VoidInvoiceRequest,
} from "@dentalos/validation";
import { billingClient } from "./billing-client";
import { billingRoutes as r } from "./billing-routes";
import type { ApiClient } from "./client";
import type { Page } from "./types";

/** Query shapes: the zod types carry output defaults (`limit`), so every key is optional here. */
export type InvoiceListQuery = Partial<ListInvoicesQuery>;
export type PaymentListQuery = Partial<ListPaymentsQuery>;
export type RefundListQuery = Partial<ListRefundsQuery>;
export type AdjustmentListQuery = Partial<ListAdjustmentsQuery>;
export type RevenueQuery = Pick<RevenueReportQuery, "from" | "to"> &
  Partial<Pick<RevenueReportQuery, "branchId" | "groupBy">>;
export type StatementQuery = Partial<Omit<PatientStatementQuery, "patientId">>;

/** PATCH /billing/settings body: tenant scope or (with `branchId`) branch overrides. */
export type BillingSettingsPatch = Partial<TenantBillingSettings> | Partial<BranchBillingSettings>;

/** Typed billing surface. One function per endpoint; screens never build paths themselves. */
export function createBillingApi(c: ApiClient) {
  const get = <T>(path: string, query?: object) =>
    c.request<T>("GET", path, { query: query as Record<string, string> });
  const send = <T>(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) =>
    c.request<T>(method, path, { body: body ?? {} });

  return {
    estimate: (planId: string, planVersion?: number) =>
      get<EstimateResponse>(r.estimates(), { planId, planVersion }),

    invoices: {
      list: (q: InvoiceListQuery) => get<Page<InvoiceSummary>>(r.invoices(), q),
      get: (id: string) => get<InvoiceDetailResponse>(r.invoice(id)),
      print: (id: string) => get<InvoicePrintResponse>(r.invoicePrint(id)),
      create: (b: CreateInvoiceRequest) => send<InvoiceDetailResponse>("POST", r.invoices(), b),
      fromPlan: (b: CreateInvoiceFromPlanRequest) =>
        send<InvoiceDetailResponse>("POST", r.invoicesFromPlan(), b),
      update: (id: string, b: UpdateInvoiceRequest) =>
        send<InvoiceDetailResponse>("PATCH", r.invoice(id), b),
      setDiscount: (id: string, b: SetInvoiceDiscountRequest) =>
        send<InvoiceDetailResponse>("PUT", r.invoiceDiscount(id), b),
      addLine: (id: string, b: InvoiceLineInput) =>
        send<InvoiceDetailResponse>("POST", r.invoiceLines(id), b),
      updateLine: (id: string, lineId: string, b: UpdateInvoiceLineRequest) =>
        send<InvoiceDetailResponse>("PATCH", r.invoiceLine(id, lineId), b),
      deleteLine: (id: string, lineId: string) =>
        c.request<InvoiceDetailResponse>("DELETE", r.invoiceLine(id, lineId)),
      issue: (id: string, b: IssueInvoiceRequest = {}) =>
        send<InvoiceDetailResponse>("POST", r.invoiceIssue(id), b),
      void: (id: string, b: VoidInvoiceRequest) =>
        send<InvoiceDetailResponse>("POST", r.invoiceVoid(id), b),
      adjust: (id: string, b: IssueAdjustmentRequest) =>
        send<AdjustmentResponse>("POST", r.invoiceAdjustments(id), b),
    },
    adjustments: {
      list: (q: AdjustmentListQuery) => get<Page<AdjustmentResponse>>(r.adjustments(), q),
    },

    payments: {
      list: (q: PaymentListQuery) => get<Page<PaymentResponse>>(r.payments(), q),
      get: (id: string) => get<PaymentDetailResponse>(r.payment(id)),
      create: (b: RecordPaymentRequest) => send<PaymentDetailResponse>("POST", r.payments(), b),
      allocate: (id: string, b: AllocatePaymentRequest) =>
        send<PaymentDetailResponse>("POST", r.paymentAllocate(id), b),
      checkout: (b: CreateGatewayCheckoutRequest) =>
        send<GatewayCheckoutResponse>("POST", r.gatewayCheckout(), b),
    },

    refunds: {
      list: (q: RefundListQuery) => get<Page<RefundResponse>>(r.refunds(), q),
      get: (id: string) => get<RefundResponse>(r.refund(id)),
      request: (b: RequestRefundRequest) => send<RefundResponse>("POST", r.refunds(), b),
      approve: (id: string, b: ApproveRefundRequest = {}) =>
        send<RefundResponse>("POST", r.refundApprove(id), b),
      reject: (id: string, b: RejectRefundRequest) =>
        send<RefundResponse>("POST", r.refundReject(id), b),
      process: (id: string, b: ProcessRefundRequest = {}) =>
        send<RefundResponse>("POST", r.refundProcess(id), b),
    },

    patients: {
      credit: (patientId: string, limit = 50) =>
        get<PatientCreditResponse>(r.patientCredit(patientId), { limit }),
      adjustCredit: (patientId: string, b: AdjustPatientCreditRequest) =>
        send<PatientCreditResponse>("POST", r.patientCreditAdjust(patientId), b),
      applyAdvance: (patientId: string, b: ApplyAdvanceRequest) =>
        send<InvoiceDetailResponse>("POST", r.patientAdvanceApply(patientId), b),
      statement: (patientId: string, q: StatementQuery = {}) =>
        get<PatientStatementResponse>(r.patientStatement(patientId), q),
    },

    reports: {
      revenue: (q: RevenueQuery) => get<RevenueReportResponse>(r.revenueReport(), q),
    },

    settings: {
      get: (branchId?: string) => get<BillingSettingsResponse>(r.settings(), { branchId }),
      update: (patch: BillingSettingsPatch, branchId?: string) =>
        c.request<BillingSettingsResponse>("PATCH", r.settings(), {
          query: { branchId },
          body: patch,
        }),
    },
  };
}

export type BillingApi = ReturnType<typeof createBillingApi>;
export const billingApi: BillingApi = createBillingApi(billingClient);
