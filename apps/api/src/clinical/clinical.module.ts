import { Module } from "@nestjs/common";
import { EncountersController } from "./encounters.controller";
import { EncountersService } from "./encounters.service";
import { PatientClinicalController } from "./patient-clinical.controller";
import { PatientClinicalService } from "./patient-clinical.service";

/**
 * M2 Clinical records (PRD 3.4, 4.4): encounters, notes, sign (treating dentist only) and
 * append-only amendments, odontogram, diagnoses, procedures, encounter documents, clinical context.
 * Owned by Wave 1 worker C1 (apps/api/src/clinical/**). PRISMA, AuditService and EventBus are
 * @Global (AppModule). No imports from scheduling/ or plans/ (linked by id / FK only).
 */
@Module({
  controllers: [EncountersController, PatientClinicalController],
  providers: [EncountersService, PatientClinicalService],
})
export class ClinicalModule {}
