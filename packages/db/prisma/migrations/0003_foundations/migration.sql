CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Membership: multiple roles per user + explicit org-wide flag (replaces "empty scope = org-wide").
ALTER TABLE "Membership"
  ADD COLUMN "roles" "Role"[] NOT NULL DEFAULT ARRAY[]::"Role"[],
  ADD COLUMN "orgWide" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Membership"
   SET "roles" = ARRAY["role"], "orgWide" = ("role" = 'OWNER' AND cardinality("branchScope") = 0);
ALTER TABLE "Membership" DROP COLUMN "role";
ALTER TABLE "Membership" ALTER COLUMN "roles" DROP DEFAULT;

-- AuditEvent: per-tenant hash chain (tamper evidence, PRD 7.5).
ALTER TABLE "AuditEvent"
  ADD COLUMN "chainPos" BIGINT,
  ADD COLUMN "prevHash" TEXT,
  ADD COLUMN "hash" TEXT;
CREATE UNIQUE INDEX "AuditEvent_tenantId_chainPos_key" ON "AuditEvent"("tenantId", "chainPos");

CREATE OR REPLACE FUNCTION audit_row_hash(prev TEXT, r "AuditEvent") RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(concat_ws('|',
    coalesce(prev, ''), r."chainPos", r."id", r."tenantId", coalesce(r."branchId"::text, ''),
    r."actorId", r."action", r."resource", coalesce(r."resourceId", ''), r."outcome", r."source",
    extract(epoch FROM r."createdAt")::text), 'sha256'), 'hex')
$$;

-- Serialised per tenant by an advisory lock held to commit, so chain order == commit order.
CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."tenantId"::text, 42));
  SELECT "chainPos", "hash" INTO head FROM "AuditEvent"
   WHERE "tenantId" = NEW."tenantId" AND "chainPos" IS NOT NULL
   ORDER BY "chainPos" DESC LIMIT 1;
  NEW."chainPos" := coalesce(head."chainPos", 0) + 1;
  NEW."prevHash" := head."hash";
  NEW."hash" := audit_row_hash(head."hash", NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chain_bi BEFORE INSERT ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_chain();

-- Returns NULL when the tenant's chain is intact, else the first broken chainPos.
CREATE OR REPLACE FUNCTION verify_audit_chain(t uuid) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE r "AuditEvent"; prev TEXT := NULL; pos BIGINT := 1;
BEGIN
  FOR r IN SELECT * FROM "AuditEvent" WHERE "tenantId" = t AND "chainPos" IS NOT NULL ORDER BY "chainPos" LOOP
    IF r."chainPos" <> pos OR r."prevHash" IS DISTINCT FROM prev
       OR r."hash" IS DISTINCT FROM audit_row_hash(prev, r) THEN
      RETURN r."chainPos";
    END IF;
    prev := r."hash"; pos := pos + 1;
  END LOOP;
  RETURN NULL;
END $$;
