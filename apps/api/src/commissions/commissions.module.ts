import { Module } from "@nestjs/common";

/**
 * M3 Dentist compensation (PRD 4.6, 2.5): commission rules (effective-dated, closed never edited), the append-only
 * commission ledger (accrual on payment allocation, reversal on refund, adjustments), settlement runs
 * (DRAFT -> APPROVED -> PAID) and dentist statements.
 * Owned by Wave 1 worker C1 — add controllers/providers here only (apps/api/src/commissions/**).
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Rules: docs/adr/0004-business-operations-rules.md §7; DTOs + calculation in @dentalos/validation `commissions.ts`.
 * Accrual is driven by the billing module's payment allocations: no imports between billing/ and commissions/ —
 * read PaymentAllocation / Invoice rows directly (shared schema) or react to a queued job. See docs/M3-business-ops.md.
 */
@Module({
  controllers: [],
  providers: [],
})
export class CommissionsModule {}
