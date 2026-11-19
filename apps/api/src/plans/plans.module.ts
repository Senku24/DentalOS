import { Module } from "@nestjs/common";

/**
 * M2 Treatment plans & consent (PRD 4.5): plans, items with frozen estimates (catalog pricing.ts),
 * per-item decisions, sessions, version snapshots + diff, present/approve, consent templates and
 * versions, signed consent tied to a plan version.
 * Owned by Wave 1 worker P1 — add controllers/providers here only (apps/api/src/plans/**).
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Map DB errors with `../common/db-errors`. See docs/M2-clinical.md.
 */
@Module({
  controllers: [],
  providers: [],
})
export class PlansModule {}
