-- M1: organisation (tenant settings, branch details, staff invitations, dentist assignments),
-- service catalogue + branch price overrides, and the shared patient profile (PRD 2.4, 2.5, 4.1, 4.2).
-- Prisma-generated DDL below is followed by hand-written constraints, search indexes and RLS.

-- Trigram search / fuzzy duplicate matching; btree_gin lets (tenantId, name) share one GIN index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PatientLifecycleStage" AS ENUM ('REGISTERED', 'ACTIVE', 'IN_TREATMENT', 'FOLLOW_UP', 'RECALL', 'INACTIVE');

-- CreateEnum
CREATE TYPE "IntakeType" AS ENUM ('APPOINTMENT', 'WALK_IN', 'URGENT', 'ENQUIRY');

-- CreateEnum
CREATE TYPE "IdentityVerificationMethod" AS ENUM ('IN_PERSON_DOCUMENT', 'OTP_PHONE', 'OTP_EMAIL', 'GUARDIAN');

-- CreateEnum
CREATE TYPE "EnquirySource" AS ENUM ('WALK_IN', 'PHONE', 'WEBSITE', 'WHATSAPP', 'REFERRAL', 'SOCIAL', 'CAMPAIGN', 'OTHER');

-- CreateEnum
CREATE TYPE "EnquiryStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CommChannel" AS ENUM ('SMS', 'WHATSAPP', 'EMAIL', 'VOICE');

-- CreateEnum
CREATE TYPE "CommPurpose" AS ENUM ('TRANSACTIONAL', 'REMINDER', 'MARKETING');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('ID_PROOF', 'CONSENT_FORM', 'REFERRAL', 'LAB_REPORT', 'XRAY', 'PHOTO', 'PRESCRIPTION', 'INSURANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING_UPLOAD', 'AVAILABLE', 'DELETED');

-- CreateEnum
CREATE TYPE "DuplicateStatus" AS ENUM ('PENDING', 'DISMISSED', 'MERGED');

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'IN',
ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "workingHours" JSONB NOT NULL DEFAULT '{}';

-- Backfill codes for pre-existing branches, then enforce NOT NULL.
UPDATE "Branch" SET "code" = 'BR-' || upper(substr("id"::text, 1, 8)) WHERE "code" IS NULL;
ALTER TABLE "Branch" ALTER COLUMN "code" SET NOT NULL;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "onboardedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "StaffInvitation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "roles" "Role"[] NOT NULL,
    "orgWide" BOOLEAN NOT NULL DEFAULT false,
    "branchScope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "acceptedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DentistBranchAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DentistBranchAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCategory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "categoryId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationMin" INTEGER NOT NULL,
    "basePricePaise" INTEGER NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchPriceOverride" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "pricePaise" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "setBy" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchPriceOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "originBranchId" UUID NOT NULL,
    "mrn" TEXT,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT,
    "preferredName" TEXT,
    "dob" DATE,
    "sex" "Sex" NOT NULL DEFAULT 'UNKNOWN',
    "phone" TEXT,
    "altPhone" TEXT,
    "email" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "nameNormalized" TEXT NOT NULL,
    "phoneNormalized" TEXT,
    "emailNormalized" TEXT,
    "lifecycleStage" "PatientLifecycleStage" NOT NULL DEFAULT 'REGISTERED',
    "intakeType" "IntakeType" NOT NULL,
    "mergedIntoId" UUID,
    "mergedAt" TIMESTAMP(3),
    "identityVerifiedAt" TIMESTAMP(3),
    "identityVerifiedBy" TEXT,
    "identityVerificationMethod" "IdentityVerificationMethod",
    "identityDocumentType" TEXT,
    "identityDocumentLast4" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientEnquiry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "phoneNormalized" TEXT,
    "email" TEXT,
    "source" "EnquirySource" NOT NULL,
    "areaOfInterest" TEXT,
    "notes" TEXT,
    "status" "EnquiryStatus" NOT NULL DEFAULT 'NEW',
    "convertedPatientId" UUID,
    "convertedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientEnquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientMedicalHistory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID,
    "version" INTEGER NOT NULL,
    "medical" JSONB NOT NULL DEFAULT '{}',
    "dental" JSONB NOT NULL DEFAULT '{}',
    "medications" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "recordedBy" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientMedicalHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientAllergy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "substance" TEXT NOT NULL,
    "reaction" TEXT,
    "severity" "Severity" NOT NULL DEFAULT 'MODERATE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notedBy" TEXT NOT NULL,
    "notedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PatientAllergy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientAlert" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "details" TEXT,
    "severity" "Severity" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PatientAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientConsent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "method" TEXT,
    "documentId" UUID,
    "capturedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationPreference" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "channel" "CommChannel" NOT NULL,
    "purpose" "CommPurpose" NOT NULL DEFAULT 'TRANSACTIONAL',
    "optIn" BOOLEAN NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "category" "DocumentCategory" NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedBy" TEXT,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PatientDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientMergeRecord" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "survivorId" UUID NOT NULL,
    "mergedId" UUID NOT NULL,
    "duplicateCandidateId" UUID,
    "performedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientMergeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateCandidate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientAId" UUID NOT NULL,
    "patientBId" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "status" "DuplicateStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffInvitation_tokenHash_key" ON "StaffInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "StaffInvitation_tenantId_idx" ON "StaffInvitation"("tenantId");

-- CreateIndex
CREATE INDEX "StaffInvitation_tenantId_status_idx" ON "StaffInvitation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DentistBranchAssignment_tenantId_idx" ON "DentistBranchAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "DentistBranchAssignment_tenantId_userId_idx" ON "DentistBranchAssignment"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "DentistBranchAssignment_tenantId_branchId_idx" ON "DentistBranchAssignment"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "ServiceCategory_tenantId_idx" ON "ServiceCategory"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCategory_tenantId_id_key" ON "ServiceCategory"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCategory_tenantId_name_key" ON "ServiceCategory"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Service_tenantId_idx" ON "Service"("tenantId");

-- CreateIndex
CREATE INDEX "Service_tenantId_categoryId_idx" ON "Service"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_tenantId_id_key" ON "Service"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Service_tenantId_code_key" ON "Service"("tenantId", "code");

-- CreateIndex
CREATE INDEX "BranchPriceOverride_tenantId_idx" ON "BranchPriceOverride"("tenantId");

-- CreateIndex
CREATE INDEX "BranchPriceOverride_tenantId_branchId_idx" ON "BranchPriceOverride"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "BranchPriceOverride_tenantId_serviceId_idx" ON "BranchPriceOverride"("tenantId", "serviceId");

-- CreateIndex
CREATE INDEX "Patient_tenantId_idx" ON "Patient"("tenantId");

-- CreateIndex
CREATE INDEX "Patient_tenantId_originBranchId_idx" ON "Patient"("tenantId", "originBranchId");

-- CreateIndex
CREATE INDEX "Patient_tenantId_phoneNormalized_idx" ON "Patient"("tenantId", "phoneNormalized");

-- CreateIndex
CREATE INDEX "Patient_tenantId_emailNormalized_idx" ON "Patient"("tenantId", "emailNormalized");

-- CreateIndex
CREATE INDEX "Patient_tenantId_dob_idx" ON "Patient"("tenantId", "dob");

-- CreateIndex
CREATE INDEX "Patient_tenantId_mergedIntoId_idx" ON "Patient"("tenantId", "mergedIntoId");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_tenantId_id_key" ON "Patient"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_tenantId_mrn_key" ON "Patient"("tenantId", "mrn");

-- CreateIndex
CREATE INDEX "PatientEnquiry_tenantId_idx" ON "PatientEnquiry"("tenantId");

-- CreateIndex
CREATE INDEX "PatientEnquiry_tenantId_status_idx" ON "PatientEnquiry"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PatientEnquiry_tenantId_phoneNormalized_idx" ON "PatientEnquiry"("tenantId", "phoneNormalized");

-- CreateIndex
CREATE INDEX "PatientMedicalHistory_tenantId_idx" ON "PatientMedicalHistory"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientMedicalHistory_tenantId_patientId_version_key" ON "PatientMedicalHistory"("tenantId", "patientId", "version");

-- CreateIndex
CREATE INDEX "PatientAllergy_tenantId_idx" ON "PatientAllergy"("tenantId");

-- CreateIndex
CREATE INDEX "PatientAllergy_tenantId_patientId_idx" ON "PatientAllergy"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "PatientAlert_tenantId_idx" ON "PatientAlert"("tenantId");

-- CreateIndex
CREATE INDEX "PatientAlert_tenantId_patientId_idx" ON "PatientAlert"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "PatientConsent_tenantId_idx" ON "PatientConsent"("tenantId");

-- CreateIndex
CREATE INDEX "PatientConsent_tenantId_patientId_idx" ON "PatientConsent"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "CommunicationPreference_tenantId_idx" ON "CommunicationPreference"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationPreference_tenantId_patientId_channel_purpose_key" ON "CommunicationPreference"("tenantId", "patientId", "channel", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "PatientDocument_storageKey_key" ON "PatientDocument"("storageKey");

-- CreateIndex
CREATE INDEX "PatientDocument_tenantId_idx" ON "PatientDocument"("tenantId");

-- CreateIndex
CREATE INDEX "PatientDocument_tenantId_patientId_idx" ON "PatientDocument"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "PatientDocument_tenantId_branchId_idx" ON "PatientDocument"("tenantId", "branchId");

-- CreateIndex
CREATE INDEX "PatientMergeRecord_tenantId_idx" ON "PatientMergeRecord"("tenantId");

-- CreateIndex
CREATE INDEX "PatientMergeRecord_tenantId_survivorId_idx" ON "PatientMergeRecord"("tenantId", "survivorId");

-- CreateIndex
CREATE INDEX "PatientMergeRecord_tenantId_mergedId_idx" ON "PatientMergeRecord"("tenantId", "mergedId");

-- CreateIndex
CREATE INDEX "DuplicateCandidate_tenantId_idx" ON "DuplicateCandidate"("tenantId");

-- CreateIndex
CREATE INDEX "DuplicateCandidate_tenantId_status_idx" ON "DuplicateCandidate"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateCandidate_tenantId_patientAId_patientBId_key" ON "DuplicateCandidate"("tenantId", "patientAId", "patientBId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_tenantId_id_key" ON "Branch"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_tenantId_code_key" ON "Branch"("tenantId", "code");

-- AddForeignKey
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DentistBranchAssignment" ADD CONSTRAINT "DentistBranchAssignment_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "Membership"("tenantId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DentistBranchAssignment" ADD CONSTRAINT "DentistBranchAssignment_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCategory" ADD CONSTRAINT "ServiceCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "ServiceCategory"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPriceOverride" ADD CONSTRAINT "BranchPriceOverride_tenantId_serviceId_fkey" FOREIGN KEY ("tenantId", "serviceId") REFERENCES "Service"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchPriceOverride" ADD CONSTRAINT "BranchPriceOverride_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_tenantId_originBranchId_fkey" FOREIGN KEY ("tenantId", "originBranchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_tenantId_mergedIntoId_fkey" FOREIGN KEY ("tenantId", "mergedIntoId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientEnquiry" ADD CONSTRAINT "PatientEnquiry_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientEnquiry" ADD CONSTRAINT "PatientEnquiry_tenantId_convertedPatientId_fkey" FOREIGN KEY ("tenantId", "convertedPatientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientMedicalHistory" ADD CONSTRAINT "PatientMedicalHistory_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientMedicalHistory" ADD CONSTRAINT "PatientMedicalHistory_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAllergy" ADD CONSTRAINT "PatientAllergy_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAlert" ADD CONSTRAINT "PatientAlert_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientConsent" ADD CONSTRAINT "PatientConsent_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationPreference" ADD CONSTRAINT "CommunicationPreference_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientMergeRecord" ADD CONSTRAINT "PatientMergeRecord_tenantId_survivorId_fkey" FOREIGN KEY ("tenantId", "survivorId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientMergeRecord" ADD CONSTRAINT "PatientMergeRecord_tenantId_mergedId_fkey" FOREIGN KEY ("tenantId", "mergedId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_tenantId_patientAId_fkey" FOREIGN KEY ("tenantId", "patientAId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_tenantId_patientBId_fkey" FOREIGN KEY ("tenantId", "patientBId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Integrity constraints Prisma cannot express
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_code_upper_chk" CHECK ("code" = upper("code") AND length("code") > 0);
ALTER TABLE "Service" ADD CONSTRAINT "Service_code_upper_chk" CHECK ("code" = upper("code") AND length("code") > 0);
ALTER TABLE "Service" ADD CONSTRAINT "Service_price_chk" CHECK ("basePricePaise" >= 0);
ALTER TABLE "Service" ADD CONSTRAINT "Service_duration_chk" CHECK ("durationMin" > 0);
ALTER TABLE "BranchPriceOverride" ADD CONSTRAINT "BranchPriceOverride_price_chk" CHECK ("pricePaise" >= 0);
ALTER TABLE "BranchPriceOverride" ADD CONSTRAINT "BranchPriceOverride_period_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "DentistBranchAssignment" ADD CONSTRAINT "DentistBranchAssignment_period_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_email_lower_chk" CHECK ("email" = lower("email"));
ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_roles_chk" CHECK (cardinality("roles") > 0);
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_not_self_merged_chk" CHECK ("mergedIntoId" IS NULL OR "mergedIntoId" <> "id");
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_id_last4_chk"
  CHECK ("identityDocumentLast4" IS NULL OR "identityDocumentLast4" ~ '^[A-Za-z0-9]{1,4}$');
ALTER TABLE "PatientMedicalHistory" ADD CONSTRAINT "PatientMedicalHistory_version_chk" CHECK ("version" >= 1);
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_size_chk" CHECK ("sizeBytes" >= 0);
ALTER TABLE "PatientMergeRecord" ADD CONSTRAINT "PatientMergeRecord_distinct_chk" CHECK ("survivorId" <> "mergedId");
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_order_chk" CHECK ("patientAId" < "patientBId");
ALTER TABLE "DuplicateCandidate" ADD CONSTRAINT "DuplicateCandidate_score_chk" CHECK ("score" BETWEEN 0 AND 100);

-- One open row at a time; closed rows are history.
CREATE UNIQUE INDEX "StaffInvitation_pending_email_key" ON "StaffInvitation"("tenantId", "email")
  WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "DentistBranchAssignment_open_key" ON "DentistBranchAssignment"("tenantId", "userId", "branchId")
  WHERE "effectiveTo" IS NULL;
CREATE UNIQUE INDEX "BranchPriceOverride_open_key" ON "BranchPriceOverride"("tenantId", "serviceId", "branchId")
  WHERE "effectiveTo" IS NULL;

-- Search + duplicate detection (similarity(), %, ILIKE '%..%').
CREATE INDEX "Patient_name_trgm_idx" ON "Patient" USING gin ("tenantId", "nameNormalized" gin_trgm_ops);
CREATE INDEX "Patient_phone_trgm_idx" ON "Patient" USING gin ("tenantId", "phoneNormalized" gin_trgm_ops);
CREATE INDEX "PatientEnquiry_name_trgm_idx" ON "PatientEnquiry" USING gin ("tenantId", "name" gin_trgm_ops);
CREATE INDEX "Service_name_trgm_idx" ON "Service" USING gin ("tenantId", "name" gin_trgm_ops);

-- ---------------------------------------------------------------------------------------------
-- Row-level security: every new table is tenant-owned and fails closed (see 0002_rls).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'StaffInvitation', 'DentistBranchAssignment', 'ServiceCategory', 'Service', 'BranchPriceOverride',
    'Patient', 'PatientEnquiry', 'PatientMedicalHistory', 'PatientAllergy', 'PatientAlert',
    'PatientConsent', 'CommunicationPreference', 'PatientDocument', 'PatientMergeRecord', 'DuplicateCandidate'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_tenant_id()) '
                   'WITH CHECK ("tenantId" = app_tenant_id())', t);
  END LOOP;
END $$;

-- History must not be silently overwritten (PRD 2.5). Grants come from 0002's default privileges.
-- Versioned medical history and merge records are append-only for the app role.
REVOKE UPDATE, DELETE ON "PatientMedicalHistory" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "PatientMergeRecord" FROM dentalos_app;
-- Patients, consents and documents are never hard-deleted by the app (tombstone / status instead).
REVOKE DELETE ON "Patient" FROM dentalos_app;
REVOKE DELETE ON "PatientConsent" FROM dentalos_app;
REVOKE DELETE ON "PatientDocument" FROM dentalos_app;
