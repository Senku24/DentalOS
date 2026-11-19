-- M2: clinical operations — scheduling (chairs, working hours, appointments + history), clinical
-- records (encounters, notes, amendments, odontogram, diagnoses, procedures), treatment plans
-- (versions, items, sessions) and versioned consent templates (PRD 3.4, 4.3–4.5, 7.5, 11).
-- Domain rules are the PROPOSED defaults of docs/adr/0003-clinical-domain-rules.md (pending sign-off).
-- Prisma-generated DDL below is followed by hand-written constraints, exclusion constraints,
-- triggers, append-only grants and RLS — same conventions as 0004 (docs/M1-org-patients.md).

-- GiST equality on uuid/text so double-booking can be an EXCLUDE constraint (tstzrange overlap).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "WorkingHoursScope" AS ENUM ('BRANCH', 'DENTIST', 'CHAIR');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_CHAIR', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('SCHEDULED', 'WALK_IN', 'URGENT');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('OPEN', 'SIGNED');

-- CreateEnum
CREATE TYPE "ClinicalNoteKind" AS ENUM ('SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL');

-- CreateEnum
CREATE TYPE "Dentition" AS ENUM ('PERMANENT', 'PRIMARY');

-- CreateEnum
CREATE TYPE "ToothRecordStatus" AS ENUM ('CURRENT', 'HISTORICAL');

-- CreateEnum
CREATE TYPE "ProcedureStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "TreatmentPlanStatus" AS ENUM ('DRAFT', 'PRESENTED', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanItemStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'DEFERRED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlanItemSessionStatus" AS ENUM ('PLANNED', 'SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConsentTemplateType" AS ENUM ('TREATMENT_PLAN', 'PROCEDURE', 'RADIOGRAPH', 'CLINICAL_PHOTOGRAPHY', 'COMMUNICATION');

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "email" TEXT;

-- AlterTable
ALTER TABLE "PatientConsent" ADD COLUMN     "planVersionId" UUID,
ADD COLUMN     "signerName" TEXT,
ADD COLUMN     "signerRelationship" TEXT,
ADD COLUMN     "templateVersionId" UUID;

-- AlterTable
ALTER TABLE "PatientDocument" ADD COLUMN     "encounterId" UUID;

-- CreateTable
CREATE TABLE "Chair" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkingHours" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scope" "WorkingHoursScope" NOT NULL,
    "branchId" UUID NOT NULL,
    "userId" TEXT,
    "chairId" UUID,
    "weekday" SMALLINT NOT NULL,
    "startMinute" SMALLINT NOT NULL,
    "endMinute" SMALLINT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkingHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "dentistUserId" TEXT,
    "chairId" UUID,
    "appointmentType" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "source" "AppointmentSource" NOT NULL DEFAULT 'SCHEDULED',
    "rescheduledFromId" UUID,
    "planItemId" UUID,
    "cancelReason" TEXT,
    "outsideHoursReason" TEXT,
    "notes" TEXT,
    "checkedInAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "fromStatus" "AppointmentStatus",
    "toStatus" "AppointmentStatus" NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Encounter" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "appointmentId" UUID,
    "treatingDentistUserId" TEXT NOT NULL,
    "status" "EncounterStatus" NOT NULL DEFAULT 'OPEN',
    "openedBy" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signedAt" TIMESTAMP(3),
    "signedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalNote" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "kind" "ClinicalNoteKind" NOT NULL DEFAULT 'GENERAL',
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalNoteAmendment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "noteId" UUID,
    "body" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalNoteAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToothRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "encounterId" UUID,
    "toothCode" SMALLINT NOT NULL,
    "dentition" "Dentition" NOT NULL,
    "condition" TEXT NOT NULL,
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "status" "ToothRecordStatus" NOT NULL DEFAULT 'CURRENT',
    "recordedBy" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededBy" TEXT,

    CONSTRAINT "ToothRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Diagnosis" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "toothCode" SMALLINT,
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "diagnosedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcedureRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "encounterId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "serviceId" UUID,
    "planItemId" UUID,
    "description" TEXT,
    "toothCode" SMALLINT,
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProcedureStatus" NOT NULL DEFAULT 'COMPLETED',
    "notes" TEXT,
    "performedBy" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcedureRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentPlan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "encounterId" UUID,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "TreatmentPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "presentedAt" TIMESTAMP(3),
    "presentedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "cancelReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreatmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentPlanVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreatmentPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "phase" INTEGER NOT NULL DEFAULT 1,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "serviceId" UUID NOT NULL,
    "toothCode" SMALLINT,
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "estimatePricePaise" INTEGER NOT NULL,
    "priceSource" TEXT NOT NULL,
    "pricedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "PlanItemStatus" NOT NULL DEFAULT 'PROPOSED',
    "notes" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decisionReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanItemSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planItemId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "sessionNo" INTEGER NOT NULL,
    "appointmentId" UUID,
    "encounterId" UUID,
    "status" "PlanItemSessionStatus" NOT NULL DEFAULT 'PLANNED',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanItemSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type" "ConsentTemplateType" NOT NULL,
    "title" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentTemplateVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chair_tenantId_idx" ON "Chair"("tenantId");

-- CreateIndex
CREATE INDEX "Chair_tenantId_branchId_idx" ON "Chair"("tenantId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Chair_tenantId_id_key" ON "Chair"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Chair_tenantId_branchId_id_key" ON "Chair"("tenantId", "branchId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Chair_tenantId_branchId_code_key" ON "Chair"("tenantId", "branchId", "code");

-- CreateIndex
CREATE INDEX "WorkingHours_tenantId_idx" ON "WorkingHours"("tenantId");

-- CreateIndex
CREATE INDEX "WorkingHours_tenantId_branchId_scope_idx" ON "WorkingHours"("tenantId", "branchId", "scope");

-- CreateIndex
CREATE INDEX "WorkingHours_tenantId_userId_idx" ON "WorkingHours"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "WorkingHours_tenantId_chairId_idx" ON "WorkingHours"("tenantId", "chairId");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_idx" ON "Appointment"("tenantId");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_branchId_startsAt_idx" ON "Appointment"("tenantId", "branchId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_dentistUserId_startsAt_idx" ON "Appointment"("tenantId", "dentistUserId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_chairId_startsAt_idx" ON "Appointment"("tenantId", "chairId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_patientId_startsAt_idx" ON "Appointment"("tenantId", "patientId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_planItemId_idx" ON "Appointment"("tenantId", "planItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_id_key" ON "Appointment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_id_patientId_key" ON "Appointment"("tenantId", "id", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_rescheduledFromId_key" ON "Appointment"("tenantId", "rescheduledFromId");

-- CreateIndex
CREATE INDEX "AppointmentEvent_tenantId_idx" ON "AppointmentEvent"("tenantId");

-- CreateIndex
CREATE INDEX "AppointmentEvent_tenantId_appointmentId_at_idx" ON "AppointmentEvent"("tenantId", "appointmentId", "at");

-- CreateIndex
CREATE INDEX "Encounter_tenantId_idx" ON "Encounter"("tenantId");

-- CreateIndex
CREATE INDEX "Encounter_tenantId_patientId_openedAt_idx" ON "Encounter"("tenantId", "patientId", "openedAt");

-- CreateIndex
CREATE INDEX "Encounter_tenantId_branchId_status_idx" ON "Encounter"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "Encounter_tenantId_treatingDentistUserId_status_idx" ON "Encounter"("tenantId", "treatingDentistUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_id_key" ON "Encounter"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_id_patientId_key" ON "Encounter"("tenantId", "id", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_tenantId_appointmentId_key" ON "Encounter"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "ClinicalNote_tenantId_idx" ON "ClinicalNote"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalNote_tenantId_id_key" ON "ClinicalNote"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalNote_tenantId_encounterId_id_key" ON "ClinicalNote"("tenantId", "encounterId", "id");

-- CreateIndex
CREATE INDEX "ClinicalNoteAmendment_tenantId_idx" ON "ClinicalNoteAmendment"("tenantId");

-- CreateIndex
CREATE INDEX "ClinicalNoteAmendment_tenantId_encounterId_idx" ON "ClinicalNoteAmendment"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "ClinicalNoteAmendment_tenantId_noteId_idx" ON "ClinicalNoteAmendment"("tenantId", "noteId");

-- CreateIndex
CREATE INDEX "ToothRecord_tenantId_idx" ON "ToothRecord"("tenantId");

-- CreateIndex
CREATE INDEX "ToothRecord_tenantId_patientId_status_idx" ON "ToothRecord"("tenantId", "patientId", "status");

-- CreateIndex
CREATE INDEX "ToothRecord_tenantId_encounterId_idx" ON "ToothRecord"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "Diagnosis_tenantId_idx" ON "Diagnosis"("tenantId");

-- CreateIndex
CREATE INDEX "Diagnosis_tenantId_encounterId_idx" ON "Diagnosis"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "Diagnosis_tenantId_patientId_idx" ON "Diagnosis"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "ProcedureRecord_tenantId_idx" ON "ProcedureRecord"("tenantId");

-- CreateIndex
CREATE INDEX "ProcedureRecord_tenantId_encounterId_idx" ON "ProcedureRecord"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "ProcedureRecord_tenantId_patientId_idx" ON "ProcedureRecord"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "ProcedureRecord_tenantId_planItemId_idx" ON "ProcedureRecord"("tenantId", "planItemId");

-- CreateIndex
CREATE INDEX "TreatmentPlan_tenantId_idx" ON "TreatmentPlan"("tenantId");

-- CreateIndex
CREATE INDEX "TreatmentPlan_tenantId_patientId_idx" ON "TreatmentPlan"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "TreatmentPlan_tenantId_branchId_status_idx" ON "TreatmentPlan"("tenantId", "branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentPlan_tenantId_id_key" ON "TreatmentPlan"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentPlan_tenantId_id_patientId_key" ON "TreatmentPlan"("tenantId", "id", "patientId");

-- CreateIndex
CREATE INDEX "TreatmentPlanVersion_tenantId_idx" ON "TreatmentPlanVersion"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentPlanVersion_tenantId_id_key" ON "TreatmentPlanVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentPlanVersion_tenantId_id_patientId_key" ON "TreatmentPlanVersion"("tenantId", "id", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentPlanVersion_tenantId_planId_version_key" ON "TreatmentPlanVersion"("tenantId", "planId", "version");

-- CreateIndex
CREATE INDEX "PlanItem_tenantId_idx" ON "PlanItem"("tenantId");

-- CreateIndex
CREATE INDEX "PlanItem_tenantId_planId_idx" ON "PlanItem"("tenantId", "planId");

-- CreateIndex
CREATE INDEX "PlanItem_tenantId_serviceId_idx" ON "PlanItem"("tenantId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanItem_tenantId_id_key" ON "PlanItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlanItem_tenantId_id_patientId_key" ON "PlanItem"("tenantId", "id", "patientId");

-- CreateIndex
CREATE INDEX "PlanItemSession_tenantId_idx" ON "PlanItemSession"("tenantId");

-- CreateIndex
CREATE INDEX "PlanItemSession_tenantId_appointmentId_idx" ON "PlanItemSession"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "PlanItemSession_tenantId_encounterId_idx" ON "PlanItemSession"("tenantId", "encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanItemSession_tenantId_planItemId_sessionNo_key" ON "PlanItemSession"("tenantId", "planItemId", "sessionNo");

-- CreateIndex
CREATE INDEX "ConsentTemplate_tenantId_idx" ON "ConsentTemplate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentTemplate_tenantId_id_key" ON "ConsentTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentTemplate_tenantId_code_key" ON "ConsentTemplate"("tenantId", "code");

-- CreateIndex
CREATE INDEX "ConsentTemplateVersion_tenantId_idx" ON "ConsentTemplateVersion"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentTemplateVersion_tenantId_id_key" ON "ConsentTemplateVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentTemplateVersion_tenantId_templateId_version_key" ON "ConsentTemplateVersion"("tenantId", "templateId", "version");

-- CreateIndex
CREATE INDEX "PatientConsent_tenantId_templateVersionId_idx" ON "PatientConsent"("tenantId", "templateVersionId");

-- CreateIndex
CREATE INDEX "PatientConsent_tenantId_planVersionId_idx" ON "PatientConsent"("tenantId", "planVersionId");

-- CreateIndex
CREATE INDEX "PatientDocument_tenantId_encounterId_idx" ON "PatientDocument"("tenantId", "encounterId");

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_tenantId_templateVersionId_fkey" FOREIGN KEY ("tenantId", "templateVersionId") REFERENCES "ConsentTemplateVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_tenantId_planVersionId_patientId_fkey" FOREIGN KEY ("tenantId", "planVersionId", "patientId") REFERENCES "TreatmentPlanVersion"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chair" ADD CONSTRAINT "Chair_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_tenantId_branchId_chairId_fkey" FOREIGN KEY ("tenantId", "branchId", "chairId") REFERENCES "Chair"("tenantId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_branchId_chairId_fkey" FOREIGN KEY ("tenantId", "branchId", "chairId") REFERENCES "Chair"("tenantId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_rescheduledFromId_fkey" FOREIGN KEY ("tenantId", "rescheduledFromId") REFERENCES "Appointment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_tenantId_planItemId_patientId_fkey" FOREIGN KEY ("tenantId", "planItemId", "patientId") REFERENCES "PlanItem"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentEvent" ADD CONSTRAINT "AppointmentEvent_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_tenantId_appointmentId_patientId_fkey" FOREIGN KEY ("tenantId", "appointmentId", "patientId") REFERENCES "Appointment"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNoteAmendment" ADD CONSTRAINT "ClinicalNoteAmendment_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNoteAmendment" ADD CONSTRAINT "ClinicalNoteAmendment_tenantId_encounterId_noteId_fkey" FOREIGN KEY ("tenantId", "encounterId", "noteId") REFERENCES "ClinicalNote"("tenantId", "encounterId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToothRecord" ADD CONSTRAINT "ToothRecord_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToothRecord" ADD CONSTRAINT "ToothRecord_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_tenantId_serviceId_fkey" FOREIGN KEY ("tenantId", "serviceId") REFERENCES "Service"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_tenantId_planItemId_patientId_fkey" FOREIGN KEY ("tenantId", "planItemId", "patientId") REFERENCES "PlanItem"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPlanVersion" ADD CONSTRAINT "TreatmentPlanVersion_tenantId_planId_patientId_fkey" FOREIGN KEY ("tenantId", "planId", "patientId") REFERENCES "TreatmentPlan"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_tenantId_planId_patientId_fkey" FOREIGN KEY ("tenantId", "planId", "patientId") REFERENCES "TreatmentPlan"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_tenantId_serviceId_fkey" FOREIGN KEY ("tenantId", "serviceId") REFERENCES "Service"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanItemSession" ADD CONSTRAINT "PlanItemSession_tenantId_planItemId_patientId_fkey" FOREIGN KEY ("tenantId", "planItemId", "patientId") REFERENCES "PlanItem"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanItemSession" ADD CONSTRAINT "PlanItemSession_tenantId_appointmentId_patientId_fkey" FOREIGN KEY ("tenantId", "appointmentId", "patientId") REFERENCES "Appointment"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanItemSession" ADD CONSTRAINT "PlanItemSession_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentTemplate" ADD CONSTRAINT "ConsentTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentTemplateVersion" ADD CONSTRAINT "ConsentTemplateVersion_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "ConsentTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- FDI tooth numbering helpers (IMMUTABLE so they can back CHECK constraints). Mirrors
-- @dentalos/validation `fdi.ts`: permanent 11–18/21–28/31–38/41–48, primary 51–55/61–65/71–75/81–85.
-- Surfaces: M mesial, D distal, O occlusal, I incisal, B buccal, F facial (labial), L lingual,
-- P palatal. Anterior teeth (positions 1–3) use I/F instead of O/B; maxillary teeth (quadrants
-- 1, 2, 5, 6) use P instead of L. No duplicates.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fdi_valid_tooth(code integer) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT code IS NOT NULL AND (
    (code / 10 BETWEEN 1 AND 4 AND code % 10 BETWEEN 1 AND 8)
    OR (code / 10 BETWEEN 5 AND 8 AND code % 10 BETWEEN 1 AND 5))
$$;

CREATE OR REPLACE FUNCTION fdi_valid_surfaces(code integer, surfaces text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT surfaces IS NOT NULL
     AND surfaces <@ (
           CASE WHEN code % 10 <= 3 THEN ARRAY['M', 'D', 'I', 'F']::text[]
                ELSE ARRAY['M', 'D', 'O', 'B']::text[] END
        || CASE WHEN code / 10 IN (1, 2, 5, 6) THEN ARRAY['P']::text[] ELSE ARRAY['L']::text[] END)
     AND cardinality(surfaces) = (SELECT count(DISTINCT s) FROM unnest(surfaces) AS s)
$$;

-- ---------------------------------------------------------------------------------------------
-- Integrity constraints Prisma cannot express
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_email_lower_chk"
  CHECK ("email" IS NULL OR "email" = lower("email"));
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_signer_relationship_chk"
  CHECK ("signerRelationship" IS NULL OR "signerRelationship" IN ('SELF', 'GUARDIAN', 'REPRESENTATIVE'));
-- Template-only consent types (ADR 0003 §4) can only be captured by signing a template version;
-- a plan version is linked iff the type is TREATMENT_PLAN. Keep the list in sync with
-- @dentalos/validation TEMPLATE_ONLY_CONSENT_TYPES (the M1 free-form endpoint refuses them).
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_template_link_chk" CHECK (
      ("type" NOT IN ('TREATMENT_PLAN', 'PROCEDURE', 'RADIOGRAPH', 'COMMUNICATION')
       OR "templateVersionId" IS NOT NULL)
  AND (("type" = 'TREATMENT_PLAN') = ("planVersionId" IS NOT NULL)));

ALTER TABLE "Chair" ADD CONSTRAINT "Chair_code_upper_chk" CHECK ("code" = upper("code") AND length("code") > 0);
ALTER TABLE "Chair" ADD CONSTRAINT "Chair_name_chk" CHECK (length(btrim("name")) > 0);

ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_weekday_chk" CHECK ("weekday" BETWEEN 0 AND 6);
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_minutes_chk"
  CHECK ("startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute");
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_period_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_scope_subject_chk" CHECK (
     ("scope" = 'BRANCH' AND "userId" IS NULL AND "chairId" IS NULL)
  OR ("scope" = 'DENTIST' AND "userId" IS NOT NULL AND "chairId" IS NULL)
  OR ("scope" = 'CHAIR' AND "chairId" IS NOT NULL AND "userId" IS NULL));

ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_period_chk"
  CHECK ("endsAt" > "startsAt" AND "endsAt" - "startsAt" <= interval '12 hours');
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_type_chk" CHECK (length(btrim("appointmentType")) > 0);
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_cancel_reason_chk"
  CHECK ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) > 0);
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_checked_in_chk"
  CHECK ("status" NOT IN ('CHECKED_IN', 'IN_CHAIR') OR "checkedInAt" IS NOT NULL);
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_not_self_rescheduled_chk"
  CHECK ("rescheduledFromId" IS NULL OR "rescheduledFromId" <> "id");

-- Encounter: OPEN has no signature; SIGNED is signed by the treating dentist (ADR 0003).
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_signature_chk" CHECK (
     ("status" = 'OPEN' AND "signedAt" IS NULL AND "signedBy" IS NULL)
  OR ("status" = 'SIGNED' AND "signedAt" IS NOT NULL AND "signedBy" = "treatingDentistUserId"));
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_body_chk" CHECK (length(btrim("body")) > 0);
ALTER TABLE "ClinicalNoteAmendment" ADD CONSTRAINT "ClinicalNoteAmendment_text_chk"
  CHECK (length(btrim("body")) > 0 AND length(btrim("reason")) > 0);

ALTER TABLE "ToothRecord" ADD CONSTRAINT "ToothRecord_tooth_chk" CHECK (fdi_valid_tooth("toothCode"));
ALTER TABLE "ToothRecord" ADD CONSTRAINT "ToothRecord_dentition_chk"
  CHECK (("toothCode" < 50) = ("dentition" = 'PERMANENT'));
ALTER TABLE "ToothRecord" ADD CONSTRAINT "ToothRecord_surfaces_chk"
  CHECK (fdi_valid_surfaces("toothCode", "surfaces"));
ALTER TABLE "ToothRecord" ADD CONSTRAINT "ToothRecord_condition_chk" CHECK (length(btrim("condition")) > 0);
ALTER TABLE "ToothRecord" ADD CONSTRAINT "ToothRecord_superseded_chk"
  CHECK (("status" = 'HISTORICAL') = ("supersededAt" IS NOT NULL));
-- Optional tooth: no tooth -> no surfaces (e.g. full-mouth scaling); with a tooth -> valid FDI + surfaces.
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_tooth_chk" CHECK ("surfaces" IS NOT NULL AND (
  ("toothCode" IS NULL AND cardinality("surfaces") = 0)
  OR (fdi_valid_tooth("toothCode") AND fdi_valid_surfaces("toothCode", "surfaces"))));
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_text_chk"
  CHECK (length(btrim("code")) > 0 AND length(btrim("label")) > 0);
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_tooth_chk" CHECK ("surfaces" IS NOT NULL AND (
  ("toothCode" IS NULL AND cardinality("surfaces") = 0)
  OR (fdi_valid_tooth("toothCode") AND fdi_valid_surfaces("toothCode", "surfaces"))));
ALTER TABLE "ProcedureRecord" ADD CONSTRAINT "ProcedureRecord_what_chk"
  CHECK ("serviceId" IS NOT NULL OR length(btrim(coalesce("description", ''))) > 0);

ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_version_chk" CHECK ("currentVersion" >= 0);
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_title_chk" CHECK (length(btrim("title")) > 0);
ALTER TABLE "TreatmentPlan" ADD CONSTRAINT "TreatmentPlan_cancel_reason_chk"
  CHECK ("status" <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) > 0);
ALTER TABLE "TreatmentPlanVersion" ADD CONSTRAINT "TreatmentPlanVersion_version_chk" CHECK ("version" >= 1);
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_order_chk" CHECK ("phase" >= 1 AND "sequence" >= 1);
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_quantity_chk" CHECK ("quantity" BETWEEN 1 AND 100);
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_price_chk" CHECK ("estimatePricePaise" >= 0);
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_price_source_chk" CHECK ("priceSource" IN ('BASE', 'OVERRIDE'));
ALTER TABLE "PlanItem" ADD CONSTRAINT "PlanItem_tooth_chk" CHECK ("surfaces" IS NOT NULL AND (
  ("toothCode" IS NULL AND cardinality("surfaces") = 0)
  OR (fdi_valid_tooth("toothCode") AND fdi_valid_surfaces("toothCode", "surfaces"))));
ALTER TABLE "PlanItemSession" ADD CONSTRAINT "PlanItemSession_no_chk" CHECK ("sessionNo" >= 1);
ALTER TABLE "ConsentTemplate" ADD CONSTRAINT "ConsentTemplate_code_upper_chk"
  CHECK ("code" = upper("code") AND length("code") > 0);
ALTER TABLE "ConsentTemplate" ADD CONSTRAINT "ConsentTemplate_version_chk" CHECK ("currentVersion" >= 0);
ALTER TABLE "ConsentTemplateVersion" ADD CONSTRAINT "ConsentTemplateVersion_version_chk" CHECK ("version" >= 1);
ALTER TABLE "ConsentTemplateVersion" ADD CONSTRAINT "ConsentTemplateVersion_body_chk" CHECK (length(btrim("body")) > 0);

-- ---------------------------------------------------------------------------------------------
-- No double-booking (PRD 4.3). Half-open ranges: back-to-back 10:00–10:30 / 10:30–11:00 is fine.
-- Only ACTIVE statuses block a slot; CANCELLED / NO_SHOW / RESCHEDULED / COMPLETED rows do not.
-- Violations raise SQLSTATE 23P01 (exclusion_violation) -> API 409 { error: "slot_conflict" }.
-- Keep this status list in sync with @dentalos/validation ACTIVE_APPOINTMENT_STATUSES.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_dentist_no_overlap"
  EXCLUDE USING gist ("tenantId" WITH =, "dentistUserId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE ("dentistUserId" IS NOT NULL AND "status" IN ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_CHAIR'));
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_chair_no_overlap"
  EXCLUDE USING gist ("tenantId" WITH =, "chairId" WITH =, tstzrange("startsAt", "endsAt", '[)') WITH &&)
  WHERE ("chairId" IS NOT NULL AND "status" IN ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_CHAIR'));

-- Working hours: no overlapping sessions for the same subject on the same weekday within
-- overlapping effective periods (daterange with NULL upper = open-ended). Stronger than a partial
-- unique index on open rows: it also covers future-dated rows. A dentist is one person, so DENTIST
-- rows may not overlap even across branches.
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_branch_no_overlap"
  EXCLUDE USING gist ("tenantId" WITH =, "branchId" WITH =, "weekday" WITH =,
    int4range("startMinute", "endMinute") WITH &&, daterange("effectiveFrom", "effectiveTo") WITH &&)
  WHERE ("scope" = 'BRANCH');
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_dentist_no_overlap"
  EXCLUDE USING gist ("tenantId" WITH =, "userId" WITH =, "weekday" WITH =,
    int4range("startMinute", "endMinute") WITH &&, daterange("effectiveFrom", "effectiveTo") WITH &&)
  WHERE ("scope" = 'DENTIST');
ALTER TABLE "WorkingHours" ADD CONSTRAINT "WorkingHours_chair_no_overlap"
  EXCLUDE USING gist ("tenantId" WITH =, "chairId" WITH =, "weekday" WITH =,
    int4range("startMinute", "endMinute") WITH &&, daterange("effectiveFrom", "effectiveTo") WITH &&)
  WHERE ("scope" = 'CHAIR');

-- ---------------------------------------------------------------------------------------------
-- Staff references (dentist / treating dentist / working-hours dentist) must be members of the
-- tenant WHEN WRITTEN. Deliberately a trigger, not a FK to Membership: a FK would block removing a
-- member who has history (or force SET NULL and lose attribution) — PRD 2.5. Only checked when the
-- value is set or changed, so later status updates of rows of a removed member still work.
-- Raises P0001 'not_a_member: …' (API: 400 { error: "not_a_member" }).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col text := TG_ARGV[0];
  uid text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF uid IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND uid IS NOT DISTINCT FROM (to_jsonb(OLD) ->> col)
     AND NEW."tenantId" = OLD."tenantId" THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."tenantId" = NEW."tenantId" AND m."userId" = uid) THEN
    RAISE EXCEPTION 'not_a_member: %.% = % is not a member of the tenant', TG_TABLE_NAME, col, uid;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_member_guard_biu BEFORE INSERT OR UPDATE ON "Appointment"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('dentistUserId');
CREATE TRIGGER tenant_member_guard_biu BEFORE INSERT OR UPDATE ON "Encounter"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('treatingDentistUserId');
CREATE TRIGGER tenant_member_guard_biu BEFORE INSERT OR UPDATE ON "WorkingHours"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('userId');

-- ---------------------------------------------------------------------------------------------
-- Clinical record integrity (PRD 4.4, 7.5): signed content is never silently changed.
-- Errors are raised with SQLSTATE P0001 and a message prefixed by a stable code the API maps:
--   encounter_signed       -> 409 (write to a signed encounter / its notes, diagnoses, procedures)
--   encounter_not_signed   -> 409 (amendment of an OPEN encounter: edit the note instead)
--   tooth_record_immutable -> 409 (odontogram rows are only ever superseded)
--   plan_item_history      -> 409 (items of a presented plan are cancelled, never deleted)
--   clinical_row_moved     -> 400 (encounterId of a clinical row cannot change)
-- Status reads use FOR SHARE so a concurrent sign waits for (or is seen by) the writer.
-- ---------------------------------------------------------------------------------------------

-- An encounter is never reopened: once SIGNED the row is frozen. (DELETE is revoked below.)
CREATE OR REPLACE FUNCTION encounter_signed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'SIGNED' THEN
    RAISE EXCEPTION 'encounter_signed: encounter % is signed and cannot change', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER encounter_signed_guard_bu BEFORE UPDATE ON "Encounter"
  FOR EACH ROW EXECUTE FUNCTION encounter_signed_guard();

-- Notes, diagnoses and procedures: insert/update/delete only while their encounter is OPEN.
CREATE OR REPLACE FUNCTION clinical_content_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  enc_tenant uuid;
  enc_id uuid;
  st "EncounterStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."encounterId" IS DISTINCT FROM OLD."encounterId"
                           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId") THEN
    RAISE EXCEPTION 'clinical_row_moved: % % cannot move to another encounter', TG_TABLE_NAME, OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    enc_tenant := NEW."tenantId"; enc_id := NEW."encounterId";
  ELSE
    enc_tenant := OLD."tenantId"; enc_id := OLD."encounterId";
  END IF;
  SELECT e."status" INTO st FROM "Encounter" e
   WHERE e."tenantId" = enc_tenant AND e."id" = enc_id FOR SHARE;
  IF st = 'SIGNED' THEN
    RAISE EXCEPTION 'encounter_signed: % of signed encounter % is immutable', TG_TABLE_NAME, enc_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clinical_content_guard_biud BEFORE INSERT OR UPDATE OR DELETE ON "ClinicalNote"
  FOR EACH ROW EXECUTE FUNCTION clinical_content_guard();
CREATE TRIGGER clinical_content_guard_biud BEFORE INSERT OR UPDATE OR DELETE ON "Diagnosis"
  FOR EACH ROW EXECUTE FUNCTION clinical_content_guard();
CREATE TRIGGER clinical_content_guard_biud BEFORE INSERT OR UPDATE OR DELETE ON "ProcedureRecord"
  FOR EACH ROW EXECUTE FUNCTION clinical_content_guard();

-- Amendments are corrections of SIGNED encounters only (an OPEN encounter's note is edited).
CREATE OR REPLACE FUNCTION amendment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "EncounterStatus";
BEGIN
  SELECT e."status" INTO st FROM "Encounter" e
   WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."encounterId" FOR SHARE;
  IF st IS NOT NULL AND st <> 'SIGNED' THEN
    RAISE EXCEPTION 'encounter_not_signed: encounter % is open; edit the note instead', NEW."encounterId";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amendment_guard_bi BEFORE INSERT ON "ClinicalNoteAmendment"
  FOR EACH ROW EXECUTE FUNCTION amendment_guard();

-- Odontogram history: the only allowed UPDATE is CURRENT -> HISTORICAL (+ supersededAt/By).
-- New rows may not be attached to a signed encounter.
CREATE OR REPLACE FUNCTION tooth_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "EncounterStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."encounterId" IS NOT NULL THEN
      SELECT e."status" INTO st FROM "Encounter" e
       WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."encounterId" FOR SHARE;
      IF st = 'SIGNED' THEN
        RAISE EXCEPTION 'encounter_signed: cannot chart into signed encounter %', NEW."encounterId";
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'CURRENT' OR NEW."status" <> 'HISTORICAL'
     OR (NEW."id", NEW."tenantId", NEW."patientId", NEW."encounterId", NEW."toothCode", NEW."dentition",
         NEW."condition", NEW."surfaces", NEW."notes", NEW."recordedBy", NEW."recordedAt")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."patientId", OLD."encounterId", OLD."toothCode", OLD."dentition",
         OLD."condition", OLD."surfaces", OLD."notes", OLD."recordedBy", OLD."recordedAt") THEN
    RAISE EXCEPTION 'tooth_record_immutable: tooth record % can only be superseded', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tooth_record_guard_biu BEFORE INSERT OR UPDATE ON "ToothRecord"
  FOR EACH ROW EXECUTE FUNCTION tooth_record_guard();

-- Plan items may be deleted only from a never-presented DRAFT plan; afterwards they are CANCELLED.
CREATE OR REPLACE FUNCTION plan_item_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pl RECORD;
BEGIN
  SELECT p."status", p."currentVersion" INTO pl FROM "TreatmentPlan" p
   WHERE p."tenantId" = OLD."tenantId" AND p."id" = OLD."planId" FOR SHARE;
  IF pl."status" IS DISTINCT FROM 'DRAFT' OR pl."currentVersion" <> 0 THEN
    RAISE EXCEPTION 'plan_item_history: item % belongs to a presented plan; cancel it instead', OLD."id";
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER plan_item_delete_guard_bd BEFORE DELETE ON "PlanItem"
  FOR EACH ROW EXECUTE FUNCTION plan_item_delete_guard();

-- ---------------------------------------------------------------------------------------------
-- Row-level security: every new table is tenant-owned and fails closed (see 0002_rls).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Chair', 'WorkingHours', 'Appointment', 'AppointmentEvent',
    'Encounter', 'ClinicalNote', 'ClinicalNoteAmendment', 'ToothRecord', 'Diagnosis', 'ProcedureRecord',
    'TreatmentPlan', 'TreatmentPlanVersion', 'PlanItem', 'PlanItemSession',
    'ConsentTemplate', 'ConsentTemplateVersion'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_tenant_id()) '
                   'WITH CHECK ("tenantId" = app_tenant_id())', t);
  END LOOP;
END $$;

-- History must not be silently overwritten (PRD 2.5, 4.4, 4.5, 7.5). Grants come from 0002's
-- default privileges. Append-only for the app role (no UPDATE, no DELETE):
REVOKE UPDATE, DELETE ON "AppointmentEvent" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "ClinicalNoteAmendment" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "TreatmentPlanVersion" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "ConsentTemplateVersion" FROM dentalos_app;
-- Never hard-deleted by the app (status / deactivation / supersede instead):
REVOKE DELETE ON "Chair" FROM dentalos_app;
REVOKE DELETE ON "Appointment" FROM dentalos_app;
REVOKE DELETE ON "Encounter" FROM dentalos_app;
REVOKE DELETE ON "ToothRecord" FROM dentalos_app;
REVOKE DELETE ON "TreatmentPlan" FROM dentalos_app;
REVOKE DELETE ON "PlanItemSession" FROM dentalos_app;
REVOKE DELETE ON "ConsentTemplate" FROM dentalos_app;
