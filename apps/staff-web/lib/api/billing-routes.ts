import { API_PREFIX } from "./routes";

/**
 * M3 billing paths, aligned with the Wave 1 controllers in apps/api/src/billing
 * (invoices.controller.ts, money.controller.ts). Kept apart from the frozen `routes.ts`.
 */
const p = (path: string) => `${API_PREFIX}${path}`;
const id = (v: string) => encodeURIComponent(v);

export const billingRoutes = {
  // ---- Estimates & invoices (billing:read / invoice:write) ---------------------------------
  /** GET ?planId&planVersion → estimateResponse */
  estimates: () => p("/estimates"),
  /** GET listInvoicesQuery → page(invoiceSummary), POST createInvoiceRequest → invoiceDetail */
  invoices: () => p("/invoices"),
  /** POST createInvoiceFromPlanRequest → invoiceDetail */
  invoicesFromPlan: () => p("/invoices/from-plan"),
  /** GET invoiceDetail, PATCH updateInvoiceRequest (DRAFT) */
  invoice: (invoiceId: string) => p(`/invoices/${id(invoiceId)}`),
  /** GET → invoicePrintResponse */
  invoicePrint: (invoiceId: string) => p(`/invoices/${id(invoiceId)}/print`),
  /** PUT setInvoiceDiscountRequest (DRAFT; discount:apply) */
  invoiceDiscount: (invoiceId: string) => p(`/invoices/${id(invoiceId)}/discount`),
  /** POST invoiceLineInput (DRAFT) */
  invoiceLines: (invoiceId: string) => p(`/invoices/${id(invoiceId)}/lines`),
  /** PATCH updateInvoiceLineRequest, DELETE (DRAFT) */
  invoiceLine: (invoiceId: string, lineId: string) =>
    p(`/invoices/${id(invoiceId)}/lines/${id(lineId)}`),
  /** POST issueInvoiceRequest (200) */
  invoiceIssue: (invoiceId: string) => p(`/invoices/${id(invoiceId)}/issue`),
  /** POST voidInvoiceRequest (200) */
  invoiceVoid: (invoiceId: string) => p(`/invoices/${id(invoiceId)}/void`),
  /** POST issueAdjustmentRequest (invoice:adjust) → adjustmentResponse */
  invoiceAdjustments: (invoiceId: string) => p(`/invoices/${id(invoiceId)}/adjustments`),
  /** GET listAdjustmentsQuery → page(adjustment) */
  adjustments: () => p("/adjustments"),

  // ---- Payments (billing:read / payment:record) --------------------------------------------
  /** GET listPaymentsQuery → page(payment), POST recordPaymentRequest → paymentDetail */
  payments: () => p("/payments"),
  /** GET → paymentDetailResponse */
  payment: (paymentId: string) => p(`/payments/${id(paymentId)}`),
  /** POST allocatePaymentRequest (200) → paymentDetail */
  paymentAllocate: (paymentId: string) => p(`/payments/${id(paymentId)}/allocate`),
  /** POST createGatewayCheckoutRequest → gatewayCheckoutResponse (PENDING until the webhook) */
  gatewayCheckout: () => p("/payments/gateway/checkout"),

  // ---- Patient account ---------------------------------------------------------------------
  /** POST applyAdvanceRequest (200) → invoiceDetail */
  patientAdvanceApply: (patientId: string) => p(`/patients/${id(patientId)}/advance/apply`),
  /** GET ?limit → patientCreditResponse */
  patientCredit: (patientId: string) => p(`/patients/${id(patientId)}/credit`),
  /** POST adjustPatientCreditRequest (200, invoice:adjust) → patientCreditResponse */
  patientCreditAdjust: (patientId: string) => p(`/patients/${id(patientId)}/credit/adjust`),
  /** GET ?branchId&from&to → patientStatementResponse (finance:report) */
  patientStatement: (patientId: string) => p(`/patients/${id(patientId)}/statement`),

  // ---- Refunds (refund:issue / refund:approve) ---------------------------------------------
  /** GET listRefundsQuery → page(refund), POST requestRefundRequest → refundResponse */
  refunds: () => p("/refunds"),
  /** GET → refundResponse */
  refund: (refundId: string) => p(`/refunds/${id(refundId)}`),
  /** POST approveRefundRequest (200) */
  refundApprove: (refundId: string) => p(`/refunds/${id(refundId)}/approve`),
  /** POST rejectRefundRequest (200) */
  refundReject: (refundId: string) => p(`/refunds/${id(refundId)}/reject`),
  /** POST processRefundRequest (200) */
  refundProcess: (refundId: string) => p(`/refunds/${id(refundId)}/process`),

  // ---- Reports & settings ------------------------------------------------------------------
  /** GET revenueReportQuery → revenueReportResponse (finance:report) */
  revenueReport: () => p("/reports/revenue"),
  /** GET ?branchId → billingSettingsResponse, PATCH update{Tenant,Branch}BillingSettingsRequest */
  settings: () => p("/billing/settings"),
  /** PUT updateServiceTaxProfileRequest (catalog:manage) */
  serviceTaxProfile: (serviceId: string) => p(`/services/${id(serviceId)}/tax-profile`),
} as const;
