import { Module } from "@nestjs/common";
import { AccountService } from "./account.service";
import { GatewayService } from "./gateway.service";
import { EstimatesController, InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import {
  AdjustmentsController,
  BillingReportsController,
  BillingSettingsController,
  PatientAccountController,
  PaymentWebhookController,
  PaymentsController,
  RefundsController,
} from "./money.controller";
import { PaymentsService } from "./payments.service";
import { RefundsService } from "./refunds.service";
import { ReportsService } from "./reports.service";
import { BillingSettingsService } from "./settings.service";

/**
 * M3 Billing (PRD 4.6): estimates from frozen plan items, invoices (DRAFT -> ISSUED -> PAID / VOID, immutable once
 * issued), GST, discounts, payments (append-only) + allocations, patient advance, refunds, credit/debit notes,
 * payment gateway (manual + stub, signed idempotent webhook), patient statements, revenue reports, billing knobs.
 * Rules: docs/adr/0004-business-operations-rules.md §1–§6, §10; DTOs + pure helpers in @dentalos/validation `billing.ts`.
 * No imports from ../commissions, ../inventory or ../notifications: other modules react to the allocation / invoice
 * rows and to the notification jobs enqueued here (NOTIFICATION_QUEUES by name). See docs/M3-business-ops.md.
 */
@Module({
  controllers: [
    EstimatesController,
    InvoicesController,
    PaymentsController,
    PaymentWebhookController,
    PatientAccountController,
    RefundsController,
    AdjustmentsController,
    BillingReportsController,
    BillingSettingsController,
  ],
  providers: [
    InvoicesService,
    PaymentsService,
    RefundsService,
    GatewayService,
    AccountService,
    ReportsService,
    BillingSettingsService,
  ],
})
export class BillingModule {}
