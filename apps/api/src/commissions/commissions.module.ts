import { Module } from "@nestjs/common";
import {
  CommissionEntriesController,
  CommissionRulesController,
  CommissionSettlementsController,
  CompensationController,
} from "./commissions.controller";
import { LedgerService } from "./ledger.service";
import { RulesService } from "./rules.service";
import { SettlementsService } from "./settlements.service";

/**
 * M3 Dentist compensation (PRD 4.6, 2.5): commission rules (effective-dated, closed never edited), the append-only
 * commission ledger (accrual on payment allocation, reversal on refund, adjustments), settlement runs
 * (DRAFT -> APPROVED -> PAID) and dentist statements.
 * Accrual engine: ./accrual.ts (pure over a Tx) + ./accrual.job.ts (pg-boss handler factory); HTTP recovery endpoint
 * POST /commissions/accrue/:allocationId.
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Rules: docs/adr/0004-business-operations-rules.md §7; DTOs + calculation in @dentalos/validation `commissions.ts`.
 * No imports from billing/: accrual reads PaymentAllocation / Invoice rows directly (shared schema).
 */
@Module({
  controllers: [
    CommissionRulesController,
    CommissionEntriesController,
    CommissionSettlementsController,
    CompensationController,
  ],
  providers: [RulesService, LedgerService, SettlementsService],
})
export class CommissionsModule {}
