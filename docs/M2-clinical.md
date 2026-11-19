# M2 — Clinical operations status

Scope (PRD 3.4, 4.3–4.5, 7.5, 11): chairs, working hours, appointments, check-in, odontogram, encounters, clinical
records, treatment plans and consent; plus M1 carry-overs (staff-web sign-in, OpenAPI, removing members, staff
name/email, stored reasons, Cognito email claim). Domain rules: **`docs/adr/0003-clinical-domain-rules.md` — proposed
defaults, pending product sign-off.** Permission matrix: `docs/permissions.md` (generated).

## Done (foundation, Phase 0)
- [x] ADR 0003: appointment / encounter / plan-item / plan state tables, consent types, FDI surfaces, knobs, open questions.
- [x] Migration `0006_m2_clinical`: `Chair`, `WorkingHours`, `Appointment`, `AppointmentEvent`, `Encounter`,
      `ClinicalNote`, `ClinicalNoteAmendment`, `ToothRecord`, `Diagnosis`, `ProcedureRecord`, `TreatmentPlan`,
      `TreatmentPlanVersion`, `PlanItem`, `PlanItemSession`, `ConsentTemplate`, `ConsentTemplateVersion`; extended
      `PatientConsent` (templateVersionId, planVersionId, signerName, signerRelationship), `PatientDocument.encounterId`,
      `Membership.displayName/email`, `Branch.settings`. All tenant-owned, FORCE RLS + `tenant_isolation`, composite FKs.
      `btree_gist` exclusion constraints (dentist/chair double-booking, overlapping working hours), FDI CHECKs, signed-
      encounter triggers, append-only grants. No Prisma drift (`migrate diff` from migrations → schema is empty).
- [x] `@dentalos/validation`: `fdi.ts`, `state-machine.ts`, `scheduling.ts`, `clinical.ts`, `plans.ts` (DTOs + pure
      helpers, tested in `m2.test.ts`); additive optional fields on M1 responses (staff name/email, stored reasons,
      document `encounterId`); `CONSENT_TYPES` extended; `tenantSettings.clinical`.
- [x] Permissions: new `consent:template` (org, OWNER); RECEPTIONIST + `plan:read`.
- [x] API: stub `SchedulingModule`, `ClinicalModule`, `PlansModule` registered in `AppModule`;
      `apps/api/src/common/db-errors.ts` (`slotConflict`, `workingHoursOverlap`, `clinicalGuardError`, `isUniqueViolation`);
      `m2-wiring.test.ts` (enum parity, permission names, active-status ↔ exclusion constraint parity, error mapping).
- [x] Root devDeps `@playwright/test`, `@axe-core/playwright` (browsers not downloaded; `bunx playwright install chromium`
      when Wave 3 needs them). No date library: `zonedToUtc` / `utcToZoned` / `minutesToHHMM` (Intl) in `scheduling.ts`.

## Not done
- [ ] Wave 1 — S1 scheduling API, C1 clinical API, P1 plans & consent API.
- [ ] Wave 2 — U1 front desk UI, U2 clinical workspace UI, X1 carry-overs.
- [ ] Wave 3 — integration, OpenAPI ↔ `routes.ts` contract test, Playwright e2e + axe in CI.
- [ ] ADR 0003 product sign-off (all sections; see its "Open questions").

## Ownership map
Frozen after Phase 0 (changes go through the commander / integration agent): `packages/db/**`, `packages/validation/**`,
`packages/contracts/**`, `apps/api/src/{app.module.ts,common/**}`, `package.json`, `bun.lock`, `docs/**`.
Workers never commit, never `git stash`, and write tests only inside their own directory (fresh random tenants; never
truncate shared tables).

| Wave | Worker | Owns |
|---|---|---|
| 1 | **S1 Scheduling** | `apps/api/src/scheduling/**` |
| 1 | **C1 Clinical** | `apps/api/src/clinical/**` |
| 1 | **P1 Plans & consent** | `apps/api/src/plans/**` |
| 2 | **U1 Front desk** | `apps/staff-web/app/{appointments,front-desk,admin/chairs,admin/hours}/**`, `apps/staff-web/lib/api/scheduling*` |
| 2 | **U2 Clinical workspace** | `apps/staff-web/app/clinical/**`, `apps/staff-web/lib/api/clinical*`, new `packages/ui/src/odontogram*` |
| 2 | **X1 Carry-overs** | `apps/staff-web/{middleware.ts,app/api/auth/**,app/(auth)/**,lib/session.ts}`, `apps/api/src/org/**`, `apps/api/scripts/openapi*`, `infra/terraform/cognito*` |

U1/U2 must not edit `lib/session.ts`, `nav.ts` or `lib/api/routes.ts`; send route/nav additions to the commander.
Cross-module rule for Wave 1: no imports between `scheduling/`, `clinical/`, `plans/` (link by id / FK only). Shared
reads (patients, pricing) import from M1 modules' pure helpers (`patients/patient-common.ts`, `catalog/pricing.ts`).

## Suggested routes (Wave 1 may refine; report the final list)
| Area | Routes | DTOs (`@dentalos/validation`) | Permission |
|---|---|---|---|
| Chairs | `GET/POST /chairs`, `PATCH /chairs/:id` | `listChairsQuery`, `createChairRequest`, `updateChairRequest`, `chairResponse` | `appointment:read` / `schedule:manage` |
| Hours | `GET /working-hours`, `PUT /working-hours` | `listWorkingHoursQuery`, `setWorkingHoursRequest`, `workingHoursResponse` | `appointment:read` / `schedule:manage` |
| Knobs | `GET/PATCH /scheduling/settings?branchId=` | `updateSchedulingSettingsRequest`, `schedulingSettingsResponse` | `appointment:read` / `schedule:manage` |
| Availability | `GET /availability` | `availabilityQuery`, `availabilityResponse` | `appointment:read` |
| Appointments | `GET/POST /appointments`, `GET/PATCH /appointments/:id`, `POST /appointments/walk-in`, `POST /appointments/:id/{reschedule,cancel,status}`, `GET /appointments/:id/events` | `listAppointmentsQuery`, `bookAppointmentRequest`, `createWalkInRequest`, `updateAppointmentRequest`, `rescheduleAppointmentRequest`, `cancelAppointmentRequest`, `appointmentTransitionRequest`, `appointmentResponse`, `appointmentDetailResponse`, `appointmentEventResponse` | ADR 0003 §1.2 |
| Queue | `GET /front-desk/queue?branchId=&date=`; SSE via existing `/events` | `checkInQueueQuery`, `checkInQueueResponse`, `schedulingEventData` | `appointment:read` |
| Encounters | `GET/POST /encounters`, `GET/PATCH /encounters/:id`, `POST /encounters/:id/sign` | `listEncountersQuery`, `openEncounterRequest`, `updateEncounterRequest`, `signEncounterRequest`, `encounterResponse`, `encounterDetailResponse` | `clinical:read` / `clinical:write` / `clinical:sign` |
| Notes | `POST /encounters/:id/notes`, `PATCH/DELETE /encounters/:id/notes/:noteId`, `POST /encounters/:id/amendments` | `createNoteRequest`, `updateNoteRequest`, `createAmendmentRequest`, `noteResponse`, `amendmentResponse` | `clinical:write` / `clinical:amend` |
| Diagnoses / procedures | `POST/PATCH/DELETE /encounters/:id/{diagnoses,procedures}[/:id]` | `create/updateDiagnosisRequest`, `create/updateProcedureRequest`, `diagnosisResponse`, `procedureResponse` | `clinical:write` |
| Odontogram | `GET /patients/:id/odontogram`, `POST /patients/:id/odontogram`, `POST /patients/:id/odontogram/supersede` | `odontogramQuery`, `odontogramResponse`, `chartTeethRequest`, `supersedeToothRecordsRequest` | `clinical:read` / `clinical:write` |
| Attachments | `GET/POST /encounters/:id/documents` | `attachEncounterDocumentRequest`, `encounterDocumentsResponse` | `clinical:read`+`document:read` / `clinical:write` |
| Context | `GET /patients/:id/clinical-context?branchId=` | `clinicalContextResponse` | `clinical:read` + `medical:read` |
| Plans | `GET/POST /plans`, `GET/PATCH /plans/:id`, `POST /plans/:id/{present,approve,cancel,decisions}` | `listPlansQuery`, `createPlanRequest`, `updatePlanRequest`, `presentPlanRequest`, `approvePlanRequest`, `cancelPlanRequest`, `decidePlanItemsRequest`, `treatmentPlanResponse`, `treatmentPlanSummary` | `plan:read` / `plan:write` / `plan:approve` |
| Items | `POST /plans/:id/items`, `PATCH/DELETE /plan-items/:id`, `POST /plan-items/:id/status` | `addPlanItemRequest`, `updatePlanItemRequest`, `planItemTransitionRequest`, `planItemResponse` | ADR 0003 §3.1 |
| Sessions | `GET/POST /plan-items/:id/sessions`, `PATCH /plan-item-sessions/:id` | `create/updatePlanItemSessionRequest`, `planItemSessionResponse` | `plan:write` |
| Versions | `GET /plans/:id/versions[/:version]`, `GET /plans/:id/versions/:a/diff/:b` | `planVersionResponse`, `planDiff` | `plan:read` |
| Consent templates | `GET/POST /consent-templates`, `GET/PATCH /consent-templates/:id`, `GET/POST /consent-templates/:id/versions` | `listConsentTemplatesQuery`, `create/updateConsentTemplateRequest`, `publishConsentTemplateVersionRequest`, `consentTemplateResponse`, `consentTemplateVersionResponse` | `consent:manage` (read) / `consent:template` |
| Sign consent | `POST /patients/:id/consents/sign` | `signConsentRequest`, `signedConsentResponse` | `consent:manage` (branch) |

## Conventions (M2 additions)
All M1 conventions apply unchanged — see `docs/M1-org-patients.md` § "Conventions workers must follow" (withTenant +
actorId, `@Can`/`assertCan`/`branchWhere`/`withBranchScope`, ZodPipe, composite FKs with both `tenantId` and the id,
effective dating, append-only, ids-only audit, integer paise, no network I/O inside transactions). New in M2:

- **User ids are IdP subjects, not FKs** (`dentistUserId`, `treatingDentistUserId`, `authorId`, `actorId`, …), so history
  survives member removal (PRD 2.5). Validate at write time: the user is a member of the tenant with the right role
  (DENTIST for dentist/treating fields) and, for branch work, a current `DentistBranchAssignment` to that branch.
- **Double-booking**: rely on the exclusion constraints, not only a pre-check (races). Catch with
  `slotConflict(e)` from `apps/api/src/common/db-errors.ts` → **409 `{ error: "slot_conflict", resource: "dentist" | "chair" }`**
  (`slotConflictError`). SQLSTATE `23P01`; Prisma surfaces it as `PrismaClientUnknownRequestError` (no `.code`), the
  helper reads the message. Overlapping working hours → `workingHoursOverlap(e)` → 409 `working_hours_overlap`.
  Active statuses = `ACTIVE_APPOINTMENT_STATUSES` (parity with the DB is tested).
- **Reschedule**: in one transaction, set old → `RESCHEDULED` (+ event) **then** insert the new row with
  `rescheduledFromId`. Never update `startsAt/endsAt` of an existing row.
- **Every appointment status change writes an `AppointmentEvent`** in the same transaction (creation: `fromStatus = null`).
- **State machines**: check with `canTransitionAppointment` / `canTransitionPlanItem` / `canTransitionPlan`; on failure
  answer **409 `{ error: "invalid_transition", from, to, allowed }`** (`invalidTransitionError`). Same-state = 409 too.
  Required reasons: `APPOINTMENT_REASON_REQUIRED`, `PLAN_ITEM_REASON_REQUIRED`. Permissions per target state:
  `APPOINTMENT_TRANSITION_PERMISSIONS`, `PLAN_ITEM_TRANSITION_PERMISSIONS` (any one, against the resource's branch).
- **Outside working hours** → 409 `{ error: "outside_working_hours" }` unless `schedule:manage` + `outsideHoursReason`
  (and the branch knob allows it). Local time ↔ UTC with `zonedToUtc` / `utcToZoned` and `Branch.timezone`.
- **Branch knobs**: `resolveSchedulingSettings(branch.settings)`; tenant knobs: `resolveClinicalSettings(tenant.settings)`.
  Write `Branch.settings` only as `{ ...existing, scheduling }` validated by `branchSettings`.
- **Signed-encounter trigger**: notes/diagnoses/procedures of a SIGNED encounter cannot be inserted/updated/deleted, the
  encounter row cannot change, amendments need SIGNED, tooth records only CURRENT → HISTORICAL. Check in the service first
  (clear 409), and also map `clinicalGuardError(e)`: `encounter_signed` / `encounter_not_signed` /
  `tooth_record_immutable` / `plan_item_history` → **409 `{ error: <code> }`**; `clinical_row_moved` → 400.
- **Sign**: `signedBy` must equal `treatingDentistUserId` (DB CHECK) — 403 `not_treating_dentist` before hitting it.
- **Append-only tables (app role has no UPDATE/DELETE)**: `AppointmentEvent`, `ClinicalNoteAmendment`,
  `TreatmentPlanVersion`, `ConsentTemplateVersion` (plus M1 `AuditEvent`, `PatientMedicalHistory`, `PatientMergeRecord`).
  **No DELETE**: `Chair`, `Appointment`, `Encounter`, `ToothRecord`, `TreatmentPlan`, `PlanItemSession`,
  `ConsentTemplate` (plus M1 `Patient`, `PatientConsent`, `PatientDocument`). `PlanItem` delete only in a never-presented
  DRAFT (trigger).
- **FDI**: validate with `toothCode` / `toothSurfaces` / `toothSurfacesRefinement` (DTOs already do); helpers
  `isValidTooth`, `dentitionOf`, `quadrant`, `validSurfaces`, `toothName` (a11y labels). Set `ToothRecord.dentition`
  with `dentitionOf(toothCode)` (DB CHECK requires the match). Odontogram change = insert new CURRENT row + mark the
  superseded one HISTORICAL (`supersededAt/By`) in one transaction.
- **Plan versions**: after presentation, every mutation appends a snapshot (`planSnapshot`, with `planTotals`) and
  increments `currentVersion` in the same transaction; a P2002 on `(tenantId, planId, version)` means a concurrent
  edit → retry or 409. Estimates come from `catalog/pricing.ts` (`overridesFor` + `effectivePrice`) at the plan's branch.
- **Merged patients**: M2 rows are never re-pointed by a merge. Writes to a merged patient → 409 `patient_merged`
  (M1 contract); clinical reads (context, odontogram, encounters, plans) include `lineageIds()` from
  `patients/patient-common.ts`.
- **Realtime**: publish `EventBus` events with `tenantId`, `branchId`, a `SCHEDULING_EVENT_TYPES` type and
  `schedulingEventData` (ids/status only).
- **Audit**: every clinical read and write (encounter, notes, odontogram, plan, consent) — ids only, never note text.
