-- M1: persist the reasons that the API already requires/accepts for state changes (PRD 2.5: who changed
-- what, when and WHY). Nullable text columns only — no rewrite, no backfill.
--
-- Privileges: every table touched here keeps table-level UPDATE for dentalos_app (0004 only revoked
-- UPDATE on PatientMedicalHistory / PatientMergeRecord, and DELETE on Patient / PatientConsent /
-- PatientDocument). Table-level grants cover newly added columns, and there are no triggers on these
-- tables, so no grant changes are needed. RLS policies are per-row and unaffected.

-- Closing an override (superseded by a new one, or cleared back to the central price).
ALTER TABLE "BranchPriceOverride" ADD COLUMN "endedReason" TEXT,
ADD COLUMN "endedBy" TEXT;

-- Soft delete (status DELETED). "deletedBy" already exists since 0004.
ALTER TABLE "PatientDocument" ADD COLUMN "deletedReason" TEXT;

-- Dismissal / merge review of a duplicate pair.
ALTER TABLE "DuplicateCandidate" ADD COLUMN "reviewReason" TEXT;

-- Consent withdrawal.
ALTER TABLE "PatientConsent" ADD COLUMN "withdrawalReason" TEXT;

-- Allergies and alerts are resolved, never deleted.
ALTER TABLE "PatientAllergy" ADD COLUMN "resolutionReason" TEXT;
ALTER TABLE "PatientAlert" ADD COLUMN "resolutionReason" TEXT;
