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

## Done (API)
- [x] Org: tenant settings/onboarding, branch CRUD + (de)activation, invitations (create/revoke/resend/accept), membership edits, dentist assign/transfer/end.
- [x] Catalog: categories, services, branch price overrides (effective-dated, audited, closing reason stored), effective-price lookup + price list.
- [x] Patients: create/update/search, enquiry → patient conversion, identity verification, lifecycle transitions, medical history versions,
      allergies/alerts (resolution reason stored), consent (withdrawal reason stored) + communication preferences, duplicate check,
      candidate review (dismissal reason stored), controlled merge with preview + per-field choices.
- [x] Documents: presigned upload → confirm (`StorageService.head`) → list → download URL → soft delete (reason stored).
- [x] Integration pass: migration `0005_m1_reasons`; PATCH schemas no longer inject zod defaults; local DTOs promoted to
      `@dentalos/validation`; `@Authenticated()` guard mode; `StorageService.head` + exported URL TTLs; `withBranchScope` helper.
- [x] Staff web (`apps/staff-web`, 15 routes, permission-gated nav): `/admin/{organisation,branches,staff,dentists,catalogue,pricing}`,
      `/patients` (server-driven search/filter/paging), `/patients/new` (intake types, live duplicate panel, 409 `possible_duplicates`
      → acknowledge), `/patients/[id]` (header alerts/allergies; Overview, Medical, Consents & communication, Documents, Activity tabs;
      merged banner on 409 `patient_merged`), `/enquiries`, `/patients/duplicates` (queue, compare, dismiss, merge wizard with
      per-field choices and 401 `reauth_required` prompt). Typed client in `lib/api/` (all paths in `routes.ts`), mock mode with
      synthetic fixtures when `NEXT_PUBLIC_API_URL` is unset. New UI components: Tabs, choice controls, display helpers (axe-tested).
      Remaining: real session (Cognito BFF) replacing the dev principal; `staffMemberResponse` lacks name/email (UI falls back to a
      fixture directory); optional fields can't be cleared to empty (schemas don't accept null); Playwright e2e against a live API.

### Endpoint summary
All routes require a bearer token with MFA and `X-Tenant-Id` (membership resolved server-side) unless noted.
Errors are `{ error: "<code>", ... }`; validation errors are 400 `validation_failed` with `issues[]`.

**Org** (`org/`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / PATCH | `/org` | `org:read` / `org:manage` | tenant name, settings, onboarding status |
| GET | `/org/onboarding` | `org:read` | step checklist |
| GET / POST | `/branches` | `branch:read` / `branch:manage` | list filtered to branch scope; `?active=` |
| GET / PATCH | `/branches/:id` | `branch:read` / `branch:manage` | PATCH only touches sent keys |
| POST | `/branches/:id/activate`, `/branches/:id/deactivate` | `branch:manage` | |
| GET | `/staff`, `/staff/:id` | `staff:read` | `?role=&branchId=` |
| PATCH | `/staff/:id` | `staff:manage` | full replacement of roles/orgWide/branchScope |
| GET / POST | `/invitations` | `staff:manage` | create returns raw `token` + `acceptPath` once |
| POST | `/invitations/:id/revoke`, `/invitations/:id/resend` | `staff:manage` | resend rotates the token |
| POST | `/invitations/accept` | `@Authenticated()` (no membership, no `X-Tenant-Id`) | token's verified email must equal the invite email → else 403 `email_mismatch`; 404 unknown token; 410 `invitation_{expired,revoked,accepted}`; 409 `already_member` |
| GET / POST | `/dentist-assignments` | `staff:read` / `staff:manage` | `?status=current` judged in each branch's time zone |
| POST | `/dentist-assignments/transfer`, `/dentist-assignments/:id/end` | `staff:manage` | effective-dated; no past dates |

**Catalog** (`catalog/`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST | `/catalog/categories` | `catalog:read` / `catalog:manage` | |
| GET / PATCH / DELETE | `/catalog/categories/:id` | `catalog:read` / `catalog:manage` | |
| GET / POST | `/catalog/services` | `catalog:read` / `catalog:manage` | `?q=&categoryId=&active=&branchId=` (adds `effectivePricePaise`) |
| GET / PATCH / DELETE | `/catalog/services/:id` | `catalog:read` / `catalog:manage` | |
| POST | `/catalog/services/:id/activate`, `/deactivate` | `catalog:manage` | |
| GET | `/catalog/price-list?branchId=` | `catalog:read` | services + effective price |
| GET | `/catalog/services/:id/price?branchId=` | `catalog:read` | `{ source: BASE\|OVERRIDE }` |
| GET / PUT | `/catalog/services/:id/overrides` | `catalog:read` / `price:override` (branch) | PUT closes the open row (`endedReason = "superseded: <new reason>"`) and inserts |
| POST | `/catalog/services/:id/overrides/clear` | `price:override` (branch) | stores `endedReason`/`endedBy` |

**Patients** (`patients/`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/patients` | `patient:write` | 409 `possible_duplicates` (see below) unless `acknowledgeDuplicates` or URGENT |
| GET | `/patients` | `patient:read` | `?q=&phone=&email=&dob=&originBranchId=&lifecycleStage=&intakeType=&includeMerged=` |
| POST | `/patients/duplicate-check` | `patient:read` | read-only; `failOnMatch: true` → 409 `possible_duplicates` |
| GET / PATCH | `/patients/:id` | `patient:read` / `patient:write` | PATCH only touches sent keys |
| POST | `/patients/:id/lifecycle` | `patient:write` | `{ stage }`; 409 `invalid_lifecycle_transition` with `from`, `to`, `allowed` |
| POST | `/patients/:id/identity-verification` | `patient:write` | audited; last 4 chars of an id document only |
| GET | `/patients/:id/merges` | `patient:read` | merge records |
| GET / POST | `/patients/:id/medical-history` | `medical:read` / `medical:write` | append-only versions (incl. merged lineage) |
| GET / POST | `/patients/:id/allergies`, `/alerts` | `medical:read` / `medical:write` | `?includeResolved=true` |
| POST | `/patients/:id/allergies/:allergyId/resolve`, `/alerts/:alertId/resolve` | `medical:write` | `{ reason? }` → `resolutionReason` |
| GET / POST | `/patients/:id/consents` | `consent:manage` | response includes `branchId` |
| POST | `/patients/:id/consents/:consentId/withdraw` | `consent:manage` | `{ reason? }` → `withdrawalReason` |
| GET / PUT | `/patients/:id/communication-preferences` | `patient:read` / `patient:write` | |
| POST / GET | `/enquiries` | `patient:write` / `patient:read` | |
| GET / PATCH | `/enquiries/:id` | `patient:read` / `patient:write` | |
| POST | `/enquiries/:id/convert` | `patient:write` | `{ existingPatientId }` or new-patient fields (`intakeType` defaults ENQUIRY) |
| GET | `/duplicate-candidates` | `patient:merge` | `?status=PENDING\|DISMISSED\|MERGED` |
| POST | `/duplicate-candidates/:id/dismiss` | `patient:merge` | `{ reason }` → `reviewReason` |
| GET | `/patient-merges/preview?survivorId=&mergedId=` | `patient:merge` | field conflicts + blockers |
| POST | `/patient-merges` | `patient:merge` + **step-up** | see Merge below |

**Documents** (`documents/`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/documents/uploads` | `document:write` (branch) | presigned POST (300 s); row `PENDING_UPLOAD`; 409 `patient_merged` |
| POST | `/documents/:id/confirm` | `document:write` | HEADs the object: 409 `upload_not_found` / `upload_mismatch` / `document_deleted` |
| GET | `/documents?patientId=` | `document:read` | AVAILABLE only, branch-scoped |
| GET | `/documents/:id` | `document:read` | out-of-scope → 404 |
| GET | `/documents/:id/download-url` | `document:read` | presigned GET (60 s), audited |
| POST | `/documents/:id/delete` | `document:write` | soft delete; `{ reason }` → `deletedReason` |

### Duplicate matching (`apps/api/src/patients/duplicate-scoring.ts`)
Inputs are normalised (`normalizeName` / `normalizePhoneIN` / `normalizeEmail`); candidates are narrowed with pg_trgm and
scored by summing points, clamped to 0–100:

| Rule | Points |
|---|---|
| `PHONE_EXACT` — same E.164 phone | +45 |
| `EMAIL_EXACT` — same lower-cased email | +35 |
| `NAME_EXACT` — identical normalised full name | +35 |
| `NAME_SIMILAR` — trigram similarity ≥ 0.6 (≥ 0.45 → +12); not added with NAME_EXACT | +20 |
| `DOB_EXACT` — same date of birth | +25 |
| DOB mismatch — both known and different (families share phones) | −25 |

Thresholds: **≥ 40 "possible"** (returned by the duplicate check); **≥ 60 "likely"** (persisted to the
`DuplicateCandidate` review queue and triggers the create-time 409). Merging is never automatic.

### Lifecycle transitions (`apps/api/src/patients/lifecycle.ts`)
| From | Allowed to |
|---|---|
| REGISTERED | ACTIVE, IN_TREATMENT, INACTIVE |
| ACTIVE | IN_TREATMENT, FOLLOW_UP, RECALL, INACTIVE |
| IN_TREATMENT | FOLLOW_UP, ACTIVE, INACTIVE |
| FOLLOW_UP | RECALL, IN_TREATMENT, ACTIVE, INACTIVE |
| RECALL | ACTIVE, IN_TREATMENT, INACTIVE |
| INACTIVE | ACTIVE |

A same-stage move is a no-op. Nothing returns to REGISTERED. Applies to `POST /patients/:id/lifecycle` and `lifecycleStage` on PATCH.

### Merge
`POST /patient-merges` `{ survivorId, mergedId, duplicateCandidateId?, reason (≥5), fieldChoices? }` requires a **step-up**:
an interactive sign-in no older than 900 s, otherwise 401 `{ error: "reauth_required", maxAgeSeconds: 900 }` (client must
re-authenticate and retry). `fieldChoices` maps `MERGEABLE_FIELDS` to `"survivor" | "merged"` (default survivor). Other
409s: `already_merged`, `survivor_already_merged` (both carry `survivorId`), `already_reviewed`; 400
`duplicate_candidate_mismatch`. The reviewed candidate gets `status MERGED` and `reviewReason = reason`.

### 409 contracts the UI must handle
- `possible_duplicates`: `{ error: "possible_duplicates", matches: [{ patient: PatientSummary, score, reasons[] }] }` —
  from `POST /patients` (likely matches only; resubmit with `acknowledgeDuplicates: true`) and from
  `POST /patients/duplicate-check` with `failOnMatch: true`.
- `patient_merged`: `{ error: "patient_merged", message, mergedIntoId, survivorId }` — any write to a merged (tombstone)
  patient; redirect to `survivorId` (end of the merge chain). Document upload for a merged patient returns
  `{ error: "patient_merged" }` only.

## Not done
- [ ] Invitation e-mail delivery (the raw token/`acceptPath` is returned to the inviter; no sender yet). With Cognito, the
      access token must carry `email` + `email_verified` (pre-token-generation trigger V2), otherwise accept answers
      403 `email_mismatch`.
- [ ] Removing members (no DELETE /staff/:id; only role/scope edits).
- [ ] `sha256` sent on document confirm is stored but not verified server-side (would need a streamed GET + hash).
- [ ] OpenAPI generation.
- [ ] Reason columns are persisted but not yet exposed in API responses (allergy/alert/consent/candidate/override/document).

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
  Update (PATCH) schemas must not carry `.default()`s (zod 4 `.partial()` keeps them): redeclare defaulted fields as `.optional()`;
  `packages/validation/src/validation.test.ts` asserts `parse({})` is `{}` for every update schema.
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
- **Documents**: `StorageService.presignUpload/presignDownload/head` (tenant-prefixed keys; TTLs `UPLOAD_TTL_SECONDS`/`DOWNLOAD_TTL_SECONDS`);
  create the row `PENDING_UPLOAD`, flip to `AVAILABLE` on confirm.
- **Audit**: `AuditService.record(p, { action, resource, resourceId, branchId, outcome })` for every write and sensitive read
  (price override, merge, document download, identity verification). Ids only — never names, phones or clinical text.
- **Money**: integer paise everywhere.
