import {
  type AdjustPatientCreditRequest,
  type AllocatePaymentRequest,
  type ApplyAdvanceRequest,
  type ApproveRefundRequest,
  type CreateGatewayCheckoutRequest,
  GATEWAY_SIGNATURE_HEADER,
  type IssueAdjustmentRequest,
  type ListAdjustmentsQuery,
  type ListPaymentsQuery,
  type ListRefundsQuery,
  type PatientStatementQuery,
  type ProcessRefundRequest,
  type RecordPaymentRequest,
  type RejectRefundRequest,
  type RequestRefundRequest,
  type RevenueReportQuery,
  type UpdateServiceTaxProfileRequest,
  adjustPatientCreditRequest,
  allocatePaymentRequest,
  applyAdvanceRequest,
  approveRefundRequest,
  billingSettingsQuery,
  createGatewayCheckoutRequest,
  issueAdjustmentRequest,
  listAdjustmentsQuery,
  listPaymentsQuery,
  listRefundsQuery,
  patientCreditQuery,
  patientStatementQuery,
  processRefundRequest,
  recordPaymentRequest,
  rejectRefundRequest,
  requestRefundRequest,
  revenueReportQuery,
  updateServiceTaxProfileRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  type RawBodyRequest,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Can, Public } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { AccountService } from "./account.service";
import { GatewayService } from "./gateway.service";
import { PaymentsService } from "./payments.service";
import { RefundsService } from "./refunds.service";
import { ReportsService } from "./reports.service";
import { BillingSettingsService } from "./settings.service";

const Id = () => Param("id", new ParseUUIDPipe());

/**
 * Payments + allocations + gateway checkout. Capability via @Can; the payment's branch is checked in the service
 * (foreign / out-of-scope ids answer 404).
 */
@Controller("payments")
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly gateway: GatewayService,
  ) {}

  @Can("payment:record")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(recordPaymentRequest)) body: RecordPaymentRequest,
  ) {
    return this.payments.create(p, body);
  }

  @Can("billing:read")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listPaymentsQuery)) q: ListPaymentsQuery,
  ) {
    return this.payments.list(p, q);
  }

  @Can("payment:record")
  @Post("gateway/checkout")
  checkout(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createGatewayCheckoutRequest)) body: CreateGatewayCheckoutRequest,
  ) {
    return this.gateway.checkout(p, body);
  }

  @Can("billing:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.payments.get(p, id);
  }

  @Can("payment:record")
  @Post(":id/allocate")
  @HttpCode(200)
  allocate(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(allocatePaymentRequest)) body: AllocatePaymentRequest,
  ) {
    return this.payments.allocate(p, id, body);
  }
}

/** Signed gateway webhook: no staff auth, the HMAC over the raw body is the authentication (ADR 0004 §5). */
@Controller("webhooks/payments")
export class PaymentWebhookController {
  constructor(private readonly gateway: GatewayService) {}

  @Public()
  @Post(":gateway/:tenantId")
  @HttpCode(200)
  handle(
    @Param("gateway") gateway: string,
    @Param("tenantId", new ParseUUIDPipe()) tenantId: string,
    @Headers(GATEWAY_SIGNATURE_HEADER) signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.gateway.handleWebhook(gateway, tenantId, req.rawBody, signature);
  }
}

/** Patient advance, credit adjustments and the account statement. */
@Controller("patients")
export class PatientAccountController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly account: AccountService,
  ) {}

  @Can("payment:record")
  @Post(":id/advance/apply")
  @HttpCode(200)
  applyAdvance(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(applyAdvanceRequest)) body: ApplyAdvanceRequest,
  ) {
    return this.payments.applyAdvance(p, id, body);
  }

  @Can("billing:read")
  @Get(":id/credit")
  credit(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Query(new ZodPipe(patientCreditQuery)) q: z.infer<typeof patientCreditQuery>,
  ) {
    return this.account.getCredit(p, id, q.limit);
  }

  @Can("invoice:adjust")
  @Post(":id/credit/adjust")
  @HttpCode(200)
  adjustCredit(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(adjustPatientCreditRequest)) body: AdjustPatientCreditRequest,
  ) {
    return this.account.adjustCredit(p, id, body);
  }

  @Can("finance:report")
  @Get(":id/statement")
  statement(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Query(new ZodPipe(patientStatementQuery.omit({ patientId: true })))
    q: Omit<PatientStatementQuery, "patientId">,
  ) {
    return this.account.statement(p, id, q);
  }
}

/** Refunds: request / process = refund:issue, approve / reject = refund:approve (maker-checker above the threshold). */
@Controller("refunds")
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Can("refund:issue")
  @Post()
  request(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(requestRefundRequest)) body: RequestRefundRequest,
  ) {
    return this.refunds.request(p, body);
  }

  @Can("billing:read")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listRefundsQuery)) q: ListRefundsQuery,
  ) {
    return this.refunds.list(p, q);
  }

  @Can("billing:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.refunds.get(p, id);
  }

  @Can("refund:approve")
  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(approveRefundRequest)) body: ApproveRefundRequest,
  ) {
    return this.refunds.approve(p, id, body);
  }

  @Can("refund:approve")
  @Post(":id/reject")
  @HttpCode(200)
  reject(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(rejectRefundRequest)) body: RejectRefundRequest,
  ) {
    return this.refunds.reject(p, id, body);
  }

  @Can("refund:issue")
  @Post(":id/process")
  @HttpCode(200)
  process(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(processRefundRequest)) body: ProcessRefundRequest,
  ) {
    return this.refunds.process(p, id, body);
  }
}

/** Credit / debit notes. */
@Controller()
export class AdjustmentsController {
  constructor(private readonly account: AccountService) {}

  @Can("invoice:adjust")
  @Post("invoices/:id/adjustments")
  issue(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(issueAdjustmentRequest)) body: IssueAdjustmentRequest,
  ) {
    return this.account.issueAdjustment(p, id, body);
  }

  @Can("billing:read")
  @Get("adjustments")
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listAdjustmentsQuery)) q: ListAdjustmentsQuery,
  ) {
    return this.account.listAdjustments(p, q);
  }
}

@Controller("reports")
export class BillingReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Can("finance:report")
  @Get("revenue")
  revenue(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(revenueReportQuery)) q: RevenueReportQuery,
  ) {
    return this.reports.revenue(p, q);
  }
}

/** Billing knobs (tenant, or one branch with `?branchId=`) and the GST profile of a service. */
@Controller()
export class BillingSettingsController {
  constructor(private readonly settings: BillingSettingsService) {}

  @Can("billing:read")
  @Get("billing/settings")
  get(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(billingSettingsQuery)) q: z.infer<typeof billingSettingsQuery>,
  ) {
    return this.settings.get(p, q.branchId);
  }

  /** org:manage (tenant scope) or branch:manage (`?branchId=`), checked in the service. */
  @Can("billing:read")
  @Patch("billing/settings")
  update(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(billingSettingsQuery)) q: z.infer<typeof billingSettingsQuery>,
    @Body() body: unknown,
  ) {
    return this.settings.update(p, q.branchId, body);
  }

  @Can("catalog:manage")
  @Put("services/:id/tax-profile")
  taxProfile(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateServiceTaxProfileRequest)) body: UpdateServiceTaxProfileRequest,
  ) {
    return this.settings.updateTaxProfile(p, id, body);
  }
}
