# M1 — Organisation & patients status

Scope (PRD 4.1, 4.2, 2.4, 2.5): organisations, branches, staff, service catalogue/pricing, patient profile,
intake, duplicate detection and documents. Permission matrix: `docs/permissions.md` (generated).

## Done (foundation)
- Migration `0004_m1_org_patients`: Tenant settings/onboarding; Branch code/address/phone/timezone/workingHours;
  `StaffInvitation`, `DentistBranchAssignment`, `ServiceCategory`, `Service`, `BranchPriceOverride`, `Patient`,
  `PatientEnquiry`, `PatientMedicalHistory`, `PatientAllergy`, `PatientAlert`, `PatientConsent`,
  `CommunicationPreference`, `PatientDocument`, `PatientMergeRecord`, `DuplicateCandidate`.
  All tenant-owned with FORCE RLS + `tenant_isolation`; the M0 meta-test covers them. `pg_trgm` + `btree_gin`
  trigram indexes on patient name/phone, enquiry name and service name.
- `@dentalos/validation` (zod 4): `common.ts` (normalisers, phone/email/paise/pagination), `org.ts`, `catalog.ts`,
  `patients.ts`, `documents.ts`. Enum lists are checked against Prisma in `apps/api/src/m1-wiring.test.ts`.
- Permissions: added `medical:read` / `medical:write` (health data narrower than `patient:read`; ACCOUNTANT has
  neither, OWNER read-only). `patient:merge` also covers duplicate review.
- API: stub `OrgModule`, `CatalogModule`, `PatientsModule`, `DocumentsModule` registered in `AppModule`;
  shared helpers `common/zod.pipe.ts` (`ZodPipe`) and `common/principal.ts` (`CurrentPrincipal`, `assertCan`, `branchWhere`).

## Not done
- [ ] Org: tenant settings/onboarding, branch CRUD + (de)activation, invitations (create/revoke/accept), membership edits, dentist assign/transfer.
- [ ] Catalog: categories, services, branch price overrides (audited), effective-price lookup.
- [ ] Patients: create/update/search, enquiry → patient conversion, identity verification, medical history versions,
      allergies/alerts, consent + communication preferences, duplicate check, candidate review, controlled merge.
- [ ] Documents: presigned upload → confirm → list → download → soft delete.
- [ ] Staff-web screens for the above; OpenAPI generation.

## Worker ownership map (disjoint directories — no shared-file edits)
| Worker | Owns | Must not edit |
|---|---|---|
| Foundation (done) | `packages/db/prisma/**`, `packages/validation/src/**`, `packages/contracts/**`, `apps/api/src/app.module.ts`, `apps/api/src/common/**` | — |
| Org + catalog | `apps/api/src/org/**`, `apps/api/src/catalog/**` | schema, migrations, app.module, validation, contracts |
| Patients | `apps/api/src/patients/**` | same |
| Documents | `apps/api/src/documents/**` | same |

Need a schema/DTO/permission change? Ask the foundation owner. Put local-only DTO tweaks in your own directory.

## Conventions workers must follow
- **Tenant context**: every query via `withTenant(prisma, p.tenantId, tx => ..., { actorId: p.userId })` (inject `@Inject(PRISMA)`).
  No network I/O (S3, email) inside the transaction.
- **Principal**: `@CurrentPrincipal() p: Principal` (from `../common/principal`). Route capability: `@Can("perm")`; resource scope:
  `assertCan(p, perm, { branchId })`; list filtering on branch-owned tables: `...branchWhere(p)` (or `branchWhere(p, "originBranchId")`).
  Patients are tenant-shared (`patient:*` is tenant scope); documents/consents are branch-scoped.
- **Validation**: `@Body(new ZodPipe(schema))`, `@Query(new ZodPipe(query))`. Types: `z.infer` exports, e.g. `CreatePatientRequest`.
- **Composite FKs**: child rows reference `(tenantId, parentId)`; always pass both `tenantId` and the id (unchecked create input).
- **Normalised columns**: write `Patient.nameNormalized/phoneNormalized/emailNormalized` and `PatientEnquiry.phoneNormalized` only via
  `normalizeName` / `normalizePhoneIN` / `normalizeEmail`. Codes (`Branch.code`, `Service.code`) are upper-case (DB CHECK); invitation email lower-case.
- **Effective dating** (`DentistBranchAssignment`, `BranchPriceOverride`): close the open row (`effectiveTo`) then insert; partial unique
  indexes allow one open row per (user, branch) / (service, branch). Never update past rows. Assignment dates are `DATE`.
- **Append-only / no hard delete (DB-enforced for `dentalos_app`)**: `PatientMedicalHistory` and `PatientMergeRecord` (no UPDATE/DELETE);
  `Patient`, `PatientConsent`, `PatientDocument` (no DELETE — use status / tombstone). Allergies/alerts are resolved, not deleted.
- **Merge**: never automatic. Re-point mutable child rows to the survivor, set `mergedIntoId/mergedAt` on the merged patient, write a
  `PatientMergeRecord` with a snapshot. Medical history stays on the merged id (append-only): read survivor history including
  patients whose `mergedIntoId = survivor`. `DuplicateCandidate` pairs are stored with `patientAId < patientBId`.
- **Invitations**: store `sha256(token)` only; link carries `tenantId` + raw token. One PENDING invite per (tenant, email).
- **Documents**: `StorageService.presignUpload/presignDownload` (tenant-prefixed keys); create the row `PENDING_UPLOAD`, flip to `AVAILABLE` on confirm.
- **Audit**: `AuditService.record(p, { action, resource, resourceId, branchId, outcome })` for every write and sensitive read
  (price override, merge, document download, identity verification). Ids only — never names, phones or clinical text.
- **Money**: integer paise everywhere.
