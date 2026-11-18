import { Module } from "@nestjs/common";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";
import { DuplicatesService } from "./duplicates.service";
import { EnquiriesController } from "./enquiries.controller";
import { EnquiriesService } from "./enquiries.service";
import { MedicalController } from "./medical.controller";
import { MedicalService } from "./medical.service";
import { DuplicateCandidatesController, PatientMergesController } from "./merge.controller";
import { MergeService } from "./merge.service";
import { PatientsController } from "./patients.controller";
import { PatientsService } from "./patients.service";

/**
 * M1 Patients: shared profile, intake/enquiries, medical history, allergies, alerts, consent,
 * communication preferences, search, duplicate detection and controlled merge.
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 */
@Module({
  controllers: [
    PatientsController,
    MedicalController,
    ConsentController,
    EnquiriesController,
    DuplicateCandidatesController,
    PatientMergesController,
  ],
  providers: [
    PatientsService,
    DuplicatesService,
    EnquiriesService,
    MedicalService,
    ConsentService,
    MergeService,
  ],
})
export class PatientsModule {}
