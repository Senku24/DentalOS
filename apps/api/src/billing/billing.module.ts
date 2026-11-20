import { Module } from "@nestjs/common";

/**
 * M3 Billing (PRD 4.6): estimates from frozen plan items, invoices (DRAFT -> ISSUED -> PAID / VOID, immutable once
 * issued), GST, discounts, payments (append-only) + allocations, patient advance, refunds, credit/debit notes,
 * payment gateway (manual + stub, signed idempotent webhook), patient statements, revenue reports.
 * Owned by Wave 1 worker B1 — add controllers/providers here only (apps/api/src/billing/**).
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Rules: docs/adr/0004-business-operations-rules.md §1–§6, §10; DTOs + pure helpers in @dentalos/validation `billing.ts`;
 * map DB errors with `../common/db-errors` (`m3GuardError`, `checkViolation`, `foreignKeyViolation`).
 * Gap-free numbers: `SELECT allocate_document_seq(tenant, branch, 'INV', fy)` inside the issuing transaction.
 * Enqueue notification jobs by queue name (`NOTIFICATION_QUEUES`) — never import from ../notifications.
 * See docs/M3-business-ops.md.
 */
@Module({
  controllers: [],
  providers: [],
})
export class BillingModule {}
