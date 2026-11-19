import { Module } from "@nestjs/common";

/**
 * M2 Clinical records (PRD 3.4, 4.4): encounters, notes, sign (treating dentist only) and
 * append-only amendments, odontogram, diagnoses, procedures, encounter documents, clinical context.
 * Owned by Wave 1 worker C1 — add controllers/providers here only (apps/api/src/clinical/**).
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Map DB errors with `../common/db-errors` (encounter_signed -> 409). See docs/M2-clinical.md.
 */
@Module({
  controllers: [],
  providers: [],
})
export class ClinicalModule {}
