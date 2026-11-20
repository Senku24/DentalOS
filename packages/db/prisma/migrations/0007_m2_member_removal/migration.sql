-- M2 Wave 3: explicit member removal (M1/M2 carry-over). Until now DELETE /staff/:id "soft-removed" a
-- member by clearing roles + scope; the row has to survive (DentistBranchAssignment RESTRICT FK, and
-- appointments / encounters / audit attribute work to the user id — PRD 2.5). This records WHEN and
-- by WHOM a member was removed, and lets the auth guard refuse a removed member on every route
-- (including those without a permission check: GET /me, GET /events).
--
-- Privileges: Membership keeps table-level SELECT/INSERT/UPDATE for dentalos_app (0001/0002); grants
-- cover new columns and RLS policies are per-row, so no grant or policy changes are needed.

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "removedAt" TIMESTAMPTZ(3),
ADD COLUMN     "removedBy" TEXT;

-- Rows removed before this migration (no roles) are marked removed, attributed to the migration.
UPDATE "Membership"
   SET "removedAt" = now(), "removedBy" = 'migration:0007_m2_member_removal'
 WHERE cardinality("roles") = 0 AND "removedAt" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Integrity constraints Prisma cannot express
-- ---------------------------------------------------------------------------------------------
-- removedAt and removedBy are set (and cleared, when a new invitation restores the member) together.
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_removed_pair_chk"
  CHECK (("removedAt" IS NULL) = ("removedBy" IS NULL));
-- A removed member holds no access: no roles, not org-wide, no branch scope.
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_removed_no_access_chk"
  CHECK ("removedAt" IS NULL
         OR (cardinality("roles") = 0 AND "orgWide" = false AND cardinality("branchScope") = 0));

-- ---------------------------------------------------------------------------------------------
-- Staff references (0006 tenant_member_guard) must point at a CURRENT member when written: a removed
-- member can no longer be booked, set as treating dentist or given working hours. Rows already
-- referencing them stay valid (the guard only runs when the value is set or changed).
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
  IF NOT EXISTS (SELECT 1 FROM "Membership" m
                  WHERE m."tenantId" = NEW."tenantId" AND m."userId" = uid AND m."removedAt" IS NULL) THEN
    RAISE EXCEPTION 'not_a_member: %.% = % is not a member of the tenant', TG_TABLE_NAME, col, uid;
  END IF;
  RETURN NEW;
END $$;
