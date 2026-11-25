-- M4: patient portal identity (accounts, OTPs, sessions, consent e-signatures), AI (settings, usage, activity log,
-- drafts) and analytics snapshots (PRD 3.5, 4.9, 4.10, 5, 7.3, 9.2). Domain rules are the PROPOSED defaults of
-- docs/adr/0005-portal-analytics-ai-rules.md (pending product sign-off).
-- Prisma-generated DDL below is followed by hand-written constraints, triggers, append-only / column-level grants and
-- RLS — same conventions as 0004/0006/0008 (docs/M1-org-patients.md, docs/M2-clinical.md, docs/M3-business-ops.md).
--
-- Trigger errors are raised with SQLSTATE P0001 and a message prefixed by a stable code
-- (apps/api/src/common/db-errors.ts `m4GuardError` maps them): portal_account_state, portal_identity_unverified,
-- portal_patient_merged, portal_account_inactive, portal_session_revoked, portal_session_link_mismatch,
-- portal_consent_invalid, otp_state, otp_expired, otp_locked, ai_draft_state, ai_draft_expired, ai_note_invalid.

-- CreateEnum
CREATE TYPE "PortalAccountStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PortalOtpPurpose" AS ENUM ('LOGIN', 'ACTIVATE', 'STEP_UP', 'CONTACT_VERIFY');

-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AiDraftKind" AS ENUM ('PATIENT_HISTORY_SUMMARY', 'ENCOUNTER_SUMMARY', 'CLINICAL_NOTE', 'VOICE_NOTE', 'PLAN_EXPLANATION');

-- AlterTable
ALTER TABLE "ClinicalNote" ADD COLUMN     "aiAssisted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiDraftId" UUID;

-- AlterTable
ALTER TABLE "PatientDocument" ADD COLUMN     "portalVisible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "portalVisibleAt" TIMESTAMPTZ(3),
ADD COLUMN     "portalVisibleBy" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "portalBookable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PatientPortalAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "status" "PortalAccountStatus" NOT NULL DEFAULT 'INVITED',
    "loginPhone" TEXT,
    "loginEmail" TEXT,
    "invitedBy" TEXT NOT NULL,
    "invitedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "suspendedAt" TIMESTAMPTZ(3),
    "suspendedBy" TEXT,
    "suspendReason" TEXT,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientPortalAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalOtp" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID,
    "purpose" "PortalOtpPurpose" NOT NULL,
    "channel" "CommChannel" NOT NULL,
    "destinationHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "ipHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "rotatedFromId" UUID,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgentHash" TEXT,
    "ipHash" TEXT,
    "stepUpAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,

    CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalConsentSignature" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "typedName" TEXT NOT NULL,
    "bodySha256" TEXT NOT NULL,
    "otpVerifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "signedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,
    "userAgentHash" TEXT,

    CONSTRAINT "PortalConsentSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSetting" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allowedRoles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "monthlyQuota" INTEGER,
    "retainContent" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "capability" TEXT NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiActivityLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "branchId" UUID,
    "patientId" UUID,
    "capability" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "draftId" UUID,
    "approval" TEXT,
    "outcome" TEXT NOT NULL,
    "errorCode" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "deidentified" BOOLEAN NOT NULL DEFAULT false,
    "content" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "AiDraftKind" NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "patientId" UUID,
    "branchId" UUID NOT NULL,
    "encounterId" UUID,
    "planVersionId" UUID,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedBy" TEXT,
    "editedAt" TIMESTAMPTZ(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewNote" TEXT,
    "resultingRecordType" TEXT,
    "resultingRecordId" UUID,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "metrics" JSONB NOT NULL,
    "aiSummary" TEXT,
    "aiSummaryMeta" JSONB,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientPortalAccount_tenantId_idx" ON "PatientPortalAccount"("tenantId");

-- CreateIndex
CREATE INDEX "PatientPortalAccount_tenantId_status_idx" ON "PatientPortalAccount"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PatientPortalAccount_tenantId_loginPhone_idx" ON "PatientPortalAccount"("tenantId", "loginPhone");

-- CreateIndex
CREATE INDEX "PatientPortalAccount_tenantId_loginEmail_idx" ON "PatientPortalAccount"("tenantId", "loginEmail");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPortalAccount_tenantId_id_key" ON "PatientPortalAccount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPortalAccount_tenantId_id_patientId_key" ON "PatientPortalAccount"("tenantId", "id", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientPortalAccount_tenantId_patientId_key" ON "PatientPortalAccount"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "PortalOtp_tenantId_idx" ON "PortalOtp"("tenantId");

-- CreateIndex
CREATE INDEX "PortalOtp_tenantId_destinationHash_createdAt_idx" ON "PortalOtp"("tenantId", "destinationHash", "createdAt");

-- CreateIndex
CREATE INDEX "PortalOtp_tenantId_ipHash_createdAt_idx" ON "PortalOtp"("tenantId", "ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "PortalOtp_tenantId_accountId_purpose_createdAt_idx" ON "PortalOtp"("tenantId", "accountId", "purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOtp_tenantId_id_key" ON "PortalOtp"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSession_refreshTokenHash_key" ON "PortalSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "PortalSession_tenantId_idx" ON "PortalSession"("tenantId");

-- CreateIndex
CREATE INDEX "PortalSession_tenantId_accountId_revokedAt_idx" ON "PortalSession"("tenantId", "accountId", "revokedAt");

-- CreateIndex
CREATE INDEX "PortalSession_tenantId_familyId_idx" ON "PortalSession"("tenantId", "familyId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSession_tenantId_id_key" ON "PortalSession"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSession_tenantId_rotatedFromId_key" ON "PortalSession"("tenantId", "rotatedFromId");

-- CreateIndex
CREATE INDEX "PortalConsentSignature_tenantId_idx" ON "PortalConsentSignature"("tenantId");

-- CreateIndex
CREATE INDEX "PortalConsentSignature_tenantId_patientId_idx" ON "PortalConsentSignature"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "PortalConsentSignature_tenantId_accountId_idx" ON "PortalConsentSignature"("tenantId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalConsentSignature_tenantId_id_key" ON "PortalConsentSignature"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalConsentSignature_tenantId_consentId_key" ON "PortalConsentSignature"("tenantId", "consentId");

-- CreateIndex
CREATE INDEX "AiSetting_tenantId_idx" ON "AiSetting"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AiSetting_tenantId_id_key" ON "AiSetting"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiSetting_tenantId_capability_key" ON "AiSetting"("tenantId", "capability");

-- CreateIndex
CREATE INDEX "AiUsage_tenantId_idx" ON "AiUsage"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_tenantId_id_key" ON "AiUsage"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_tenantId_month_capability_key" ON "AiUsage"("tenantId", "month", "capability");

-- CreateIndex
CREATE INDEX "AiActivityLog_tenantId_idx" ON "AiActivityLog"("tenantId");

-- CreateIndex
CREATE INDEX "AiActivityLog_tenantId_createdAt_idx" ON "AiActivityLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AiActivityLog_tenantId_capability_createdAt_idx" ON "AiActivityLog"("tenantId", "capability", "createdAt");

-- CreateIndex
CREATE INDEX "AiActivityLog_tenantId_actorId_createdAt_idx" ON "AiActivityLog"("tenantId", "actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiActivityLog_tenantId_id_key" ON "AiActivityLog"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_idx" ON "AiDraft"("tenantId");

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_status_createdAt_idx" ON "AiDraft"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_branchId_status_idx" ON "AiDraft"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_patientId_kind_idx" ON "AiDraft"("tenantId", "patientId", "kind");

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_encounterId_idx" ON "AiDraft"("tenantId", "encounterId");

-- CreateIndex
CREATE INDEX "AiDraft_tenantId_planVersionId_idx" ON "AiDraft"("tenantId", "planVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AiDraft_tenantId_id_key" ON "AiDraft"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_tenantId_idx" ON "AnalyticsSnapshot"("tenantId");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_tenantId_day_idx" ON "AnalyticsSnapshot"("tenantId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSnapshot_tenantId_id_key" ON "AnalyticsSnapshot"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSnapshot_tenantId_branchId_day_key" ON "AnalyticsSnapshot"("tenantId", "branchId", "day");

-- CreateIndex
CREATE INDEX "ClinicalNote_tenantId_aiDraftId_idx" ON "ClinicalNote"("tenantId", "aiDraftId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientConsent_tenantId_id_patientId_key" ON "PatientConsent"("tenantId", "id", "patientId");

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_tenantId_aiDraftId_fkey" FOREIGN KEY ("tenantId", "aiDraftId") REFERENCES "AiDraft"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalOtp" ADD CONSTRAINT "PortalOtp_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "PatientPortalAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_tenantId_accountId_patientId_fkey" FOREIGN KEY ("tenantId", "accountId", "patientId") REFERENCES "PatientPortalAccount"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_tenantId_rotatedFromId_fkey" FOREIGN KEY ("tenantId", "rotatedFromId") REFERENCES "PortalSession"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalConsentSignature" ADD CONSTRAINT "PortalConsentSignature_tenantId_accountId_patientId_fkey" FOREIGN KEY ("tenantId", "accountId", "patientId") REFERENCES "PatientPortalAccount"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalConsentSignature" ADD CONSTRAINT "PortalConsentSignature_tenantId_consentId_patientId_fkey" FOREIGN KEY ("tenantId", "consentId", "patientId") REFERENCES "PatientConsent"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalConsentSignature" ADD CONSTRAINT "PortalConsentSignature_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActivityLog" ADD CONSTRAINT "AiActivityLog_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActivityLog" ADD CONSTRAINT "AiActivityLog_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActivityLog" ADD CONSTRAINT "AiActivityLog_tenantId_draftId_fkey" FOREIGN KEY ("tenantId", "draftId") REFERENCES "AiDraft"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_tenantId_planVersionId_patientId_fkey" FOREIGN KEY ("tenantId", "planVersionId", "patientId") REFERENCES "TreatmentPlanVersion"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Staff references: must be a CURRENT member when written (0007 tenant_member_guard).
-- AiActivityLog.actorId is deliberately NOT guarded ("system" jobs; removed members keep their history).
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER tenant_member_guard_invited_biu BEFORE INSERT OR UPDATE ON "PatientPortalAccount"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('invitedBy');
CREATE TRIGGER tenant_member_guard_suspended_biu BEFORE INSERT OR UPDATE ON "PatientPortalAccount"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('suspendedBy');
CREATE TRIGGER tenant_member_guard_portal_biu BEFORE INSERT OR UPDATE ON "PatientDocument"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('portalVisibleBy');
CREATE TRIGGER tenant_member_guard_biu BEFORE INSERT OR UPDATE ON "AiSetting"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('updatedBy');
CREATE TRIGGER tenant_member_guard_created_biu BEFORE INSERT OR UPDATE ON "AiDraft"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('createdBy');
CREATE TRIGGER tenant_member_guard_edited_biu BEFORE INSERT OR UPDATE ON "AiDraft"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('editedBy');
CREATE TRIGGER tenant_member_guard_reviewed_biu BEFORE INSERT OR UPDATE ON "AiDraft"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('reviewedBy');

-- ---------------------------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------------------------
-- Portal account: at least one login destination, normalised formats, status <-> timestamps.
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_login_chk"
  CHECK ("loginPhone" IS NOT NULL OR "loginEmail" IS NOT NULL);
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_phone_chk"
  CHECK ("loginPhone" IS NULL OR "loginPhone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_email_chk"
  CHECK ("loginEmail" IS NULL OR ("loginEmail" = lower("loginEmail") AND "loginEmail" ~ '^[^@\s]+@[^@\s]+$'));
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_status_chk"
  CHECK (
       ("status" = 'INVITED'   AND "activatedAt" IS NULL     AND "suspendedAt" IS NULL AND "suspendedBy" IS NULL AND "suspendReason" IS NULL)
    OR ("status" = 'ACTIVE'    AND "activatedAt" IS NOT NULL AND "suspendedAt" IS NULL AND "suspendedBy" IS NULL AND "suspendReason" IS NULL)
    OR ("status" = 'SUSPENDED' AND "suspendedAt" IS NOT NULL AND "suspendedBy" IS NOT NULL
        AND "suspendReason" IS NOT NULL AND char_length(btrim("suspendReason")) >= 3)
  );

-- OTP: hash-only storage, bounded lifetime and attempts, step-up codes bound to an account and a subject.
ALTER TABLE "PortalOtp" ADD CONSTRAINT "PortalOtp_hash_chk"
  CHECK ("destinationHash" ~ '^[0-9a-f]{64}$' AND "codeHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PortalOtp" ADD CONSTRAINT "PortalOtp_attempts_chk"
  CHECK ("maxAttempts" BETWEEN 1 AND 10 AND "attempts" BETWEEN 0 AND "maxAttempts");
ALTER TABLE "PortalOtp" ADD CONSTRAINT "PortalOtp_expiry_chk"
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '1 hour');
ALTER TABLE "PortalOtp" ADD CONSTRAINT "PortalOtp_account_chk"
  CHECK ("purpose" NOT IN ('STEP_UP', 'CONTACT_VERIFY') OR "accountId" IS NOT NULL);
ALTER TABLE "PortalOtp" ADD CONSTRAINT "PortalOtp_subject_chk"
  CHECK (("subjectType" IS NULL) = ("subjectId" IS NULL));
ALTER TABLE "PortalOtp" ADD CONSTRAINT "PortalOtp_consumed_chk"
  CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt");

-- Session: hash-only refresh token, bounded lifetime, revoked <=> reason, never its own successor.
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_hash_chk"
  CHECK ("refreshTokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_expiry_chk"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_revoked_chk"
  CHECK (("revokedAt" IS NULL) = ("revokedReason" IS NULL));
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_rotation_chk"
  CHECK ("rotatedFromId" IS NULL OR "rotatedFromId" <> "id");

-- E-signature evidence: a real typed name, the exact text hash, and an OTP step-up within 15 minutes.
ALTER TABLE "PortalConsentSignature" ADD CONSTRAINT "PortalConsentSignature_name_chk"
  CHECK (char_length(btrim("typedName")) BETWEEN 2 AND 200);
ALTER TABLE "PortalConsentSignature" ADD CONSTRAINT "PortalConsentSignature_hash_chk"
  CHECK ("bodySha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PortalConsentSignature" ADD CONSTRAINT "PortalConsentSignature_stepup_chk"
  CHECK ("otpVerifiedAt" <= "signedAt" AND "signedAt" - "otpVerifiedAt" <= interval '15 minutes');

-- Documents: a portal-visible document records who flagged it and when; ID proofs are never shown.
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_portal_chk"
  CHECK (NOT "portalVisible"
         OR ("portalVisibleBy" IS NOT NULL AND "portalVisibleAt" IS NOT NULL AND "category" <> 'ID_PROOF'));

-- Clinical notes: the AI flag and the draft link travel together.
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_ai_chk"
  CHECK ("aiAssisted" = ("aiDraftId" IS NOT NULL));

-- AI settings / usage / activity.
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_capability_chk"
  CHECK ("capability" ~ '^[a-z][a-z0-9_]{2,40}$');
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_quota_chk"
  CHECK ("monthlyQuota" IS NULL OR "monthlyQuota" >= 0);
ALTER TABLE "AiSetting" ADD CONSTRAINT "AiSetting_roles_chk"
  CHECK (NOT ('PATIENT' = ANY ("allowedRoles")));
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_counts_chk"
  CHECK ("requestCount" >= 0 AND "promptTokens" >= 0 AND "completionTokens" >= 0);
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_month_chk"
  CHECK (EXTRACT(day FROM "month") = 1);
ALTER TABLE "AiActivityLog" ADD CONSTRAINT "AiActivityLog_scope_chk"
  CHECK ("scope" IN ('ORG', 'BRANCH', 'PATIENT'));
ALTER TABLE "AiActivityLog" ADD CONSTRAINT "AiActivityLog_outcome_chk"
  CHECK ("outcome" IN ('success', 'refused', 'error', 'quota_exceeded', 'disabled', 'denied'));
ALTER TABLE "AiActivityLog" ADD CONSTRAINT "AiActivityLog_approval_chk"
  CHECK ("approval" IS NULL OR "approval" IN ('APPROVED', 'REJECTED'));
ALTER TABLE "AiActivityLog" ADD CONSTRAINT "AiActivityLog_tokens_chk"
  CHECK ("promptTokens" >= 0 AND "completionTokens" >= 0 AND ("latencyMs" IS NULL OR "latencyMs" >= 0));

-- AI drafts: provenance label keys, review fields per status, subject links per kind, the written note on approval.
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_metadata_chk"
  CHECK (jsonb_typeof("metadata") = 'object'
         AND "metadata" ? 'provider' AND "metadata" ? 'model' AND "metadata" ? 'promptVersion');
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_expiry_chk"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_review_chk"
  CHECK (
       ("status" IN ('APPROVED', 'REJECTED') AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL)
    OR ("status" IN ('DRAFT', 'EXPIRED')     AND "reviewedBy" IS NULL     AND "reviewedAt" IS NULL)
  );
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_result_chk"
  CHECK (("resultingRecordId" IS NULL) = ("resultingRecordType" IS NULL)
         AND ("resultingRecordId" IS NULL OR "status" = 'APPROVED'));
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_kind_link_chk"
  CHECK (
       ("kind" = 'PATIENT_HISTORY_SUMMARY' AND "patientId" IS NOT NULL)
    OR ("kind" IN ('ENCOUNTER_SUMMARY', 'CLINICAL_NOTE', 'VOICE_NOTE')
        AND "patientId" IS NOT NULL AND "encounterId" IS NOT NULL)
    OR ("kind" = 'PLAN_EXPLANATION' AND "patientId" IS NOT NULL AND "planVersionId" IS NOT NULL)
  );
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_note_approved_chk"
  CHECK (NOT ("kind" IN ('CLINICAL_NOTE', 'VOICE_NOTE') AND "status" = 'APPROVED')
         OR ("resultingRecordId" IS NOT NULL AND "resultingRecordType" = 'ClinicalNote'));

ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_ai_chk"
  CHECK ("aiSummary" IS NULL OR "aiSummaryMeta" IS NOT NULL);

-- ---------------------------------------------------------------------------------------------
-- Portal account (ADR 0005 §1.4-§1.6): identity must be VERIFIED by staff and the patient must not be a merged
-- tombstone before an account exists / becomes ACTIVE; identity columns are frozen; status machine
--   INVITED -> ACTIVE | SUSPENDED,  ACTIVE -> SUSPENDED,  SUSPENDED -> ACTIVE | INVITED (only if never activated).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION portal_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  verified timestamptz;
  merged uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'INVITED' THEN
      RAISE EXCEPTION 'portal_account_state: an account is created INVITED';
    END IF;
  ELSE
    IF (NEW."tenantId", NEW."patientId", NEW."invitedBy", NEW."invitedAt")
       IS DISTINCT FROM (OLD."tenantId", OLD."patientId", OLD."invitedBy", OLD."invitedAt") THEN
      RAISE EXCEPTION 'portal_account_state: identity of account % cannot change', OLD."id";
    END IF;
    IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;
    IF NOT ((OLD."status" = 'INVITED'   AND NEW."status" IN ('ACTIVE', 'SUSPENDED'))
         OR (OLD."status" = 'ACTIVE'    AND NEW."status" = 'SUSPENDED')
         OR (OLD."status" = 'SUSPENDED' AND NEW."status" = 'ACTIVE'  AND OLD."activatedAt" IS NOT NULL)
         OR (OLD."status" = 'SUSPENDED' AND NEW."status" = 'INVITED' AND OLD."activatedAt" IS NULL)) THEN
      RAISE EXCEPTION 'portal_account_state: % -> % is not allowed for account %', OLD."status", NEW."status", OLD."id";
    END IF;
    IF NEW."status" = 'SUSPENDED' THEN RETURN NEW; END IF;
  END IF;
  SELECT p."identityVerifiedAt", p."mergedIntoId" INTO verified, merged FROM "Patient" p
   WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."patientId";
  IF verified IS NULL THEN
    RAISE EXCEPTION 'portal_identity_unverified: patient % has no staff-verified identity', NEW."patientId";
  END IF;
  IF merged IS NOT NULL THEN
    RAISE EXCEPTION 'portal_patient_merged: patient % was merged into another record', NEW."patientId";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_account_guard_biu BEFORE INSERT OR UPDATE ON "PatientPortalAccount"
  FOR EACH ROW EXECUTE FUNCTION portal_account_guard();

-- Suspension ends every open session of the account at once, whatever code path suspended it.
CREATE OR REPLACE FUNCTION portal_account_suspend() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "PortalSession"
     SET "revokedAt" = now(), "revokedReason" = 'account_suspended'
   WHERE "tenantId" = NEW."tenantId" AND "accountId" = NEW."id" AND "revokedAt" IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_account_suspend_au AFTER UPDATE OF "status" ON "PatientPortalAccount"
  FOR EACH ROW WHEN (NEW."status" = 'SUSPENDED' AND OLD."status" <> 'SUSPENDED')
  EXECUTE FUNCTION portal_account_suspend();

-- ---------------------------------------------------------------------------------------------
-- OTP (ADR 0005 §1.2): created with attempts = 0 and unconsumed; only attempts (never down) and consumedAt (once,
-- before expiry, below the attempt cap) may change.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION portal_otp_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."attempts" <> 0 OR NEW."consumedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'otp_state: a code is created unused with 0 attempts';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."accountId", NEW."purpose", NEW."channel", NEW."destinationHash", NEW."codeHash",
      NEW."subjectType", NEW."subjectId", NEW."maxAttempts", NEW."expiresAt", NEW."ipHash", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."accountId", OLD."purpose", OLD."channel", OLD."destinationHash", OLD."codeHash",
      OLD."subjectType", OLD."subjectId", OLD."maxAttempts", OLD."expiresAt", OLD."ipHash", OLD."createdAt") THEN
    RAISE EXCEPTION 'otp_state: code % is immutable apart from attempts / consumedAt', OLD."id";
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'otp_state: attempts of code % cannot decrease', OLD."id";
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'otp_state: code % was already used', OLD."id";
  END IF;
  IF NEW."consumedAt" IS NOT NULL THEN
    IF now() > OLD."expiresAt" THEN
      RAISE EXCEPTION 'otp_expired: code % has expired', OLD."id";
    END IF;
    IF OLD."attempts" >= OLD."maxAttempts" THEN
      RAISE EXCEPTION 'otp_locked: code % has no attempts left', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_otp_guard_biu BEFORE INSERT OR UPDATE ON "PortalOtp"
  FOR EACH ROW EXECUTE FUNCTION portal_otp_guard();

-- ---------------------------------------------------------------------------------------------
-- Session (ADR 0005 §1.3): only ACTIVE accounts get sessions; a rotation stays in the account's family; a revoked
-- session is final; step-up time never goes backwards. `PortalSession_tenantId_rotatedFromId_key` lets a refresh
-- token be exchanged exactly once (a replayed token violates it).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION portal_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acct "PortalAccountStatus";
  prev RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT a."status" INTO acct FROM "PatientPortalAccount" a
     WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."accountId" FOR SHARE;
    IF acct IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'portal_account_inactive: account % cannot open sessions', NEW."accountId";
    END IF;
    IF NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'portal_session_revoked: a session is created open';
    END IF;
    IF NEW."rotatedFromId" IS NOT NULL THEN
      SELECT s."accountId", s."familyId" INTO prev FROM "PortalSession" s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."rotatedFromId";
      IF NOT FOUND OR prev."accountId" <> NEW."accountId" OR prev."familyId" <> NEW."familyId" THEN
        RAISE EXCEPTION 'portal_session_link_mismatch: rotation must stay in the same account and family';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'portal_session_revoked: session % is revoked and final', OLD."id";
  END IF;
  IF NEW."stepUpAt" IS NOT NULL AND OLD."stepUpAt" IS NOT NULL AND NEW."stepUpAt" < OLD."stepUpAt" THEN
    RAISE EXCEPTION 'portal_session_link_mismatch: step-up time of session % cannot go backwards', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_session_guard_biu BEFORE INSERT OR UPDATE ON "PortalSession"
  FOR EACH ROW EXECUTE FUNCTION portal_session_guard();

-- ---------------------------------------------------------------------------------------------
-- Portal e-signature (ADR 0005 §3.4): ACTIVE account, a still-open session of that account, and a DIGITAL GRANTED
-- consent of the same patient (the composite FK proves the patient).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION portal_signature_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acct "PortalAccountStatus";
  sess RECORD;
  cons RECORD;
BEGIN
  SELECT a."status" INTO acct FROM "PatientPortalAccount" a
   WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."accountId";
  IF acct IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'portal_account_inactive: account % cannot sign', NEW."accountId";
  END IF;
  SELECT s."accountId", s."revokedAt" INTO sess FROM "PortalSession" s
   WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId";
  IF NOT FOUND OR sess."accountId" <> NEW."accountId" OR sess."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'portal_session_revoked: the signing session is not open for account %', NEW."accountId";
  END IF;
  SELECT c."method", c."status" INTO cons FROM "PatientConsent" c
   WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."consentId";
  IF NOT FOUND OR cons."method" IS DISTINCT FROM 'DIGITAL' OR cons."status" <> 'GRANTED' THEN
    RAISE EXCEPTION 'portal_consent_invalid: consent % must be a GRANTED DIGITAL consent', NEW."consentId";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_signature_guard_bi BEFORE INSERT ON "PortalConsentSignature"
  FOR EACH ROW EXECUTE FUNCTION portal_signature_guard();

-- ---------------------------------------------------------------------------------------------
-- AI-assisted clinical notes (ADR 0005 §5.3): a note may only reference a still-pending CLINICAL_NOTE / VOICE_NOTE
-- draft of ITS encounter, as one of the four SOAP kinds, and the link never changes. (A signed encounter already
-- refuses the insert: clinical_content_guard of 0006.)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION clinical_note_ai_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."aiAssisted" IS DISTINCT FROM OLD."aiAssisted" OR NEW."aiDraftId" IS DISTINCT FROM OLD."aiDraftId" THEN
      RAISE EXCEPTION 'ai_note_invalid: the AI link of note % cannot change', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."aiDraftId" IS NULL THEN RETURN NEW; END IF;
  SELECT x."status", x."kind", x."encounterId" INTO d FROM "AiDraft" x
   WHERE x."tenantId" = NEW."tenantId" AND x."id" = NEW."aiDraftId" FOR SHARE;
  IF NOT FOUND OR d."status" <> 'DRAFT' OR d."kind" NOT IN ('CLINICAL_NOTE', 'VOICE_NOTE')
     OR d."encounterId" IS DISTINCT FROM NEW."encounterId"
     OR NEW."kind" NOT IN ('SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN') THEN
    RAISE EXCEPTION 'ai_note_invalid: note does not match a pending clinical-note draft of this encounter';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clinical_note_ai_guard_biu BEFORE INSERT OR UPDATE ON "ClinicalNote"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_ai_guard();

-- ---------------------------------------------------------------------------------------------
-- AI draft status machine (ADR 0005 §5.2): created DRAFT; DRAFT -> APPROVED | REJECTED | EXPIRED exactly once;
-- the row is then frozen. Identity / provenance columns never change. Leaving DRAFT does not change content (edits are
-- separate updates while DRAFT). Approval of a CLINICAL_NOTE / VOICE_NOTE draft needs the ClinicalNote rows the
-- reviewer wrote for it (author = reviewer) and `resultingRecordId` must be one of them; an expired draft cannot be
-- approved.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ai_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ai_draft_state: a draft is created in DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."kind", NEW."subjectType", NEW."subjectId", NEW."patientId", NEW."branchId",
      NEW."encounterId", NEW."planVersionId", NEW."metadata", NEW."createdBy", NEW."createdAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."kind", OLD."subjectType", OLD."subjectId", OLD."patientId", OLD."branchId",
      OLD."encounterId", OLD."planVersionId", OLD."metadata", OLD."createdBy", OLD."createdAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'ai_draft_state: identity and provenance of draft % cannot change', OLD."id";
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'ai_draft_state: % draft % is final', OLD."status", OLD."id";
  END IF;
  IF NEW."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."editedBy" IS DISTINCT FROM OLD."editedBy" OR NEW."editedAt" IS DISTINCT FROM OLD."editedAt" THEN
    RAISE EXCEPTION 'ai_draft_state: content of draft % cannot change while it leaves DRAFT', OLD."id";
  END IF;
  IF NEW."status" = 'APPROVED' THEN
    IF now() > OLD."expiresAt" THEN
      RAISE EXCEPTION 'ai_draft_expired: draft % expired and cannot be approved', OLD."id";
    END IF;
    IF OLD."kind" IN ('CLINICAL_NOTE', 'VOICE_NOTE') THEN
      IF NEW."resultingRecordId" IS NULL OR NOT EXISTS (
           SELECT 1 FROM "ClinicalNote" n
            WHERE n."tenantId" = OLD."tenantId" AND n."id" = NEW."resultingRecordId"
              AND n."aiDraftId" = OLD."id" AND n."aiAssisted" AND n."authorId" = NEW."reviewedBy") THEN
        RAISE EXCEPTION 'ai_draft_state: approving draft % needs the clinical note written by the approving dentist', OLD."id";
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_draft_guard_biu BEFORE INSERT OR UPDATE ON "AiDraft"
  FOR EACH ROW EXECUTE FUNCTION ai_draft_guard();

-- ---------------------------------------------------------------------------------------------
-- Notification outbox (0008 guard, one deliberate exception): a PORTAL_OTP message carries the one-time code in
-- `variables.code` so the worker can render it. Once the message is FINAL (not QUEUED) the code is removed from the row:
-- `variables` may then change ONLY to itself minus the `code` key. Everything else stays frozen exactly as in 0008, so the
-- credential is not left at rest in the outbox (ADR 0005 §1.2; job `portal.scrub-otp-message`).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notification_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('QUEUED', 'SKIPPED_NO_CONSENT', 'OPTED_OUT') THEN
      RAISE EXCEPTION 'notification_state: a message is created QUEUED, SKIPPED_NO_CONSENT or OPTED_OUT';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."branchId", NEW."patientId", NEW."channel", NEW."purpose", NEW."templateCode",
      NEW."templateVersionId", NEW."toAddress", NEW."idempotencyKey", NEW."source",
      NEW."refType", NEW."refId", NEW."actorId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."branchId", OLD."patientId", OLD."channel", OLD."purpose", OLD."templateCode",
      OLD."templateVersionId", OLD."toAddress", OLD."idempotencyKey", OLD."source",
      OLD."refType", OLD."refId", OLD."actorId", OLD."createdAt") THEN
    RAISE EXCEPTION 'notification_state: identity and content of message % cannot change', OLD."id";
  END IF;
  IF NEW."variables" IS DISTINCT FROM OLD."variables" THEN
    IF NOT (OLD."templateCode" = 'PORTAL_OTP' AND NEW."status" <> 'QUEUED'
            AND NEW."variables" IS NOT DISTINCT FROM (OLD."variables" - 'code')) THEN
      RAISE EXCEPTION 'notification_state: identity and content of message % cannot change', OLD."id";
    END IF;
  END IF;
  IF NEW."status" <> OLD."status" AND OLD."status" <> 'QUEUED' THEN
    RAISE EXCEPTION 'notification_state: % message % is final', OLD."status", OLD."id";
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'notification_state: attempts of message % cannot decrease', OLD."id";
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security: every new table is tenant-owned and fails closed (see 0002_rls).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'PatientPortalAccount', 'PortalOtp', 'PortalSession', 'PortalConsentSignature',
    'AiSetting', 'AiUsage', 'AiActivityLog', 'AiDraft', 'AnalyticsSnapshot'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_tenant_id()) '
                   'WITH CHECK ("tenantId" = app_tenant_id())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Grants (defaults from 0002 give the app role full DML on new tables). History must not be silently overwritten.
-- ---------------------------------------------------------------------------------------------
-- Append-only: AI activity log, portal e-signature evidence.
REVOKE UPDATE, DELETE ON "AiActivityLog" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "PortalConsentSignature" FROM dentalos_app;
-- OTP: only attempts / consumedAt move; rows are removed by the retention job running as the schema owner.
REVOKE UPDATE, DELETE ON "PortalOtp" FROM dentalos_app;
GRANT UPDATE ("attempts", "consumedAt") ON "PortalOtp" TO dentalos_app;
-- Session: usage, step-up and revocation only (the token hash, account and family never change).
REVOKE UPDATE, DELETE ON "PortalSession" FROM dentalos_app;
GRANT UPDATE ("lastUsedAt", "stepUpAt", "revokedAt", "revokedReason") ON "PortalSession" TO dentalos_app;
-- Account: never deleted (suspend instead); identity columns (tenant, patient, inviter) are not updatable.
REVOKE DELETE ON "PatientPortalAccount" FROM dentalos_app;
REVOKE UPDATE ON "PatientPortalAccount" FROM dentalos_app;
GRANT UPDATE ("status", "loginPhone", "loginEmail", "activatedAt", "suspendedAt", "suspendedBy", "suspendReason",
              "lastLoginAt", "updatedAt")
  ON "PatientPortalAccount" TO dentalos_app;
-- Draft: only content edits while DRAFT and the review outcome; never deleted.
REVOKE DELETE ON "AiDraft" FROM dentalos_app;
REVOKE UPDATE ON "AiDraft" FROM dentalos_app;
GRANT UPDATE ("content", "status", "editedBy", "editedAt", "reviewedBy", "reviewedAt", "reviewNote",
              "resultingRecordType", "resultingRecordId", "updatedAt")
  ON "AiDraft" TO dentalos_app;
REVOKE DELETE ON "AiSetting" FROM dentalos_app;
REVOKE DELETE ON "AiUsage" FROM dentalos_app;
REVOKE DELETE ON "AnalyticsSnapshot" FROM dentalos_app;
