import { Module } from "@nestjs/common";

/**
 * M2 Scheduling & front desk (PRD 4.3): chairs, working hours, availability, appointments
 * (book / reschedule / cancel / walk-in / urgent), the ADR 0003 state machine, check-in queue + SSE.
 * Owned by Wave 1 worker S1 — add controllers/providers here only (apps/api/src/scheduling/**).
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Map DB errors with `../common/db-errors` (23P01 -> 409 slot_conflict). See docs/M2-clinical.md.
 */
@Module({
  controllers: [],
  providers: [],
})
export class SchedulingModule {}
