# ADR 0003 — Clinical domain rules (scheduling, encounters, plans, consent)

Status: **Proposed** (2026-11-19). **Every rule below is a proposed default — needs product sign-off.**
PRD §12.2 forbids silently inventing the appointment state machine, clinical sign-off/amendment rules or consent types,
so M2 implements these as documented, testable defaults and as configuration knobs where cheap. Each section carries
its own status line so sign-off can happen piecemeal. Changing a rule marked **DB** needs a migration; the rest are
service-level and change in `packages/validation` (tables) or `apps/api`.

Source of truth in code:
- Transition tables + helpers: `packages/validation/src/{scheduling,plans,state-machine}.ts`
- FDI catalogue: `packages/validation/src/fdi.ts` (mirrored by SQL `fdi_valid_tooth()` / `fdi_valid_surfaces()`)
- DB enforcement: `packages/db/prisma/migrations/0006_m2_clinical/migration.sql`

---

## 1. Appointments

Status: **proposed — needs product sign-off.**

### 1.1 States
`BOOKED → CONFIRMED → CHECKED_IN → IN_CHAIR → COMPLETED`, plus terminal `CANCELLED`, `NO_SHOW`, `RESCHEDULED`.

| From \ To | CONFIRMED | CHECKED_IN | IN_CHAIR | COMPLETED | CANCELLED | NO_SHOW | RESCHEDULED |
|---|---|---|---|---|---|---|---|
| **BOOKED** | ✔ | ✔ (unconfirmed arrival) | | | ✔ reason | ✔ after grace | ✔ reason |
| **CONFIRMED** | | ✔ | | | ✔ reason | ✔ after grace | ✔ reason |
| **CHECKED_IN** | | | ✔ | | ✔ reason (left unseen) | | |
| **IN_CHAIR** | | | | ✔ | | | |
| COMPLETED / CANCELLED / NO_SHOW / RESCHEDULED | terminal | | | | | | |

Rules:
- **Cancel** requires a reason (**DB** CHECK `Appointment_cancel_reason_chk`; API: `cancelAppointmentRequest.reason` ≥ 3 chars).
- **No-show** only once `startsAt + noShowGraceMinutes` has passed (default **15 min**, per branch; `isNoShowEligible`).
  Not automatic in M2 (no background job); front desk marks it. An auto-no-show job is a later option.
- **Reschedule never edits times in place**: the old row becomes `RESCHEDULED` and a new `BOOKED` row is inserted with
  `rescheduledFromId` → old (**DB** unique: at most one successor). Both rows are kept. The old row must be marked
  first in the same transaction, otherwise the exclusion constraint sees two active rows.
- **Check-in** sets `checkedInAt` (**DB** CHECK: required in `CHECKED_IN`/`IN_CHAIR`). Queue order: `URGENT` first, then
  `checkedInAt`.
- Nothing returns to `BOOKED` and there is no "undo check-in" (open question below).
- Every status change writes an append-only `AppointmentEvent` (`fromStatus`, `toStatus`, `actorId`, `reason`, `at`);
  creation writes `fromStatus = NULL`.

### 1.2 Who may move an appointment (any one permission, checked against the appointment's branch)
| Into | Permission(s) |
|---|---|
| BOOKED (create), CONFIRMED, CANCELLED, RESCHEDULED | `appointment:write` |
| CHECKED_IN, NO_SHOW | `appointment:checkin` |
| IN_CHAIR, COMPLETED | `appointment:checkin` or `clinical:write` (a dentist opening/closing the encounter) |

### 1.3 Conflicts and working hours
- **No double-booking** of a dentist or a chair among *active* statuses (`BOOKED`, `CONFIRMED`, `CHECKED_IN`,
  `IN_CHAIR`): **DB** `btree_gist` exclusion constraints on `tstzrange(startsAt, endsAt, '[)')` per
  `(tenantId, dentistUserId)` and per `(tenantId, chairId)`. Half-open: back-to-back slots are fine. Cancelled, no-show,
  rescheduled and completed rows never block. Violation → SQLSTATE 23P01 → **409 `slot_conflict`** `{ resource }`.
- **Walk-in / urgent** visits obey the same rule. When the dentist or chair is busy they are booked **unassigned**
  (no dentist and/or no chair) and assigned when a chair frees up. Overbooking is not supported.
- **Unassigned dentist** is allowed (PRD 4.3) unless the branch knob `allowUnassignedDentist = false`.
- A chair must belong to the appointment's branch (**DB** composite FK).
- **Outside working hours**: a booking outside the effective hours of the branch (and, when set, the dentist and the
  chair) needs **`schedule:manage` and `outsideHoursReason`**; otherwise **409 `outside_working_hours`**. Stored on the
  row. Knob `allowOutsideHoursBooking = false` forbids it for everyone.
- Working hours are effective-dated weekly sessions in branch local time (`weekday` 0 = Sunday, minutes after midnight,
  `[start, end)`). Several sessions per day are allowed; overlapping sessions for the same subject are rejected
  (**DB** exclusion constraints; a dentist's sessions may not overlap even across branches). When a branch has no
  `BRANCH` rows yet, `Branch.workingHours` (M1 JSON) is the fallback.
- Times are stored as `timestamptz`; branch time zone (`Branch.timezone`) converts local hours (`zonedToUtc`).
- Appointment length: 5 min – 12 h (**DB** CHECK ≤ 12 h).

### 1.4 Configuration knobs (`Branch.settings.scheduling`, zod `schedulingSettings`)
| Knob | Default | Meaning |
|---|---|---|
| `noShowGraceMinutes` | 15 | Minutes after start before NO_SHOW is allowed (0–240) |
| `slotMinutes` | 15 | Calendar grid / availability step |
| `allowUnassignedDentist` | true | Booking without a dentist |
| `allowOutsideHoursBooking` | true | Outside-hours booking with `schedule:manage` + reason |

---

## 2. Encounters, notes and amendments

Status: **proposed — needs product sign-off.**

| From \ To | SIGNED |
|---|---|
| **OPEN** | ✔ treating dentist only, `clinical:sign` |
| **SIGNED** | terminal — never reopened |

Rules:
- An encounter is opened from an appointment (same patient — **DB** composite FK; one encounter per appointment —
  **DB** unique) or as a walk-in. It records branch, treating dentist (defaults to the opener), `openedBy/At`.
- While **OPEN**: notes, diagnoses, procedures and odontogram entries may be added/edited; notes/diagnoses/procedures
  may be deleted (drafts). The treating dentist may be handed over (audited).
- **Sign**: only the treating dentist (`signedBy = treatingDentistUserId`, **DB** CHECK) holding `clinical:sign` on the
  encounter's branch, with an explicit attestation (`signEncounterRequest.attest = true`). Step-up re-auth for signing
  is **off** by default (open question).
- **Signed content is immutable** (**DB** triggers): the encounter row cannot change; its notes, diagnoses and
  procedures cannot be inserted, updated or deleted (`encounter_signed`); no odontogram row can be charted into it.
- **Corrections** are append-only `ClinicalNoteAmendment` rows (`clinical:amend`) with a mandatory reason, attributed and
  audited; either for one note or for the encounter as a whole (`noteId` null — e.g. a wrong diagnosis). Amendments are
  only allowed on **SIGNED** encounters (**DB** `encounter_not_signed`); they are never edited or deleted (**DB** grants).
  Who may amend: any holder of `clinical:amend` on the branch (proposed: not restricted to the original author).
- **Never reopened.** Further treatment = a new encounter.
- Note kinds: `SUBJECTIVE`, `OBJECTIVE`, `ASSESSMENT`, `PLAN`, `GENERAL` (SOAP). Templates are out of scope (PRD 12.2).
- Every clinical read and write is audited (ids only, PRD 7.5).

### 2.1 Odontogram (FDI)
- FDI two-digit codes: permanent 11–18, 21–28, 31–38, 41–48; primary 51–55, 61–65, 71–75, 81–85 (**DB** CHECK).
  `dentition` must match the code.
- **Surfaces** (decided here): `M` mesial, `D` distal, `O` occlusal, `I` incisal, `B` buccal, `F` facial/labial,
  `L` lingual, `P` palatal. Anterior teeth (positions 1–3) use `I`/`F` instead of `O`/`B`; maxillary teeth
  (quadrants 1, 2, 5, 6) use `P` instead of `L`. Every tooth therefore has exactly five valid surfaces (**DB** CHECK
  `fdi_valid_surfaces`, no duplicates). Empty surfaces = whole-tooth condition.
- Condition catalogue (`TOOTH_CONDITIONS`, text column so it can grow): SOUND, CARIES, FILLED, CROWN, VENEER, SEALANT,
  FRACTURED, ROOT_CANAL_TREATED, PERIAPICAL_LESION, MOBILITY, BRIDGE_ABUTMENT, BRIDGE_PONTIC, IMPLANT, MISSING,
  EXTRACTED, UNERUPTED, IMPACTED, OTHER. Whole-tooth conditions take no surfaces.
- **History is preserved**: a change inserts a new `CURRENT` row and marks the old one `HISTORICAL`
  (`supersededAt/By`) — the only UPDATE the DB allows; rows are never deleted. The snapshot is the set of `CURRENT` rows;
  "as of" views use `recordedAt`/`supersededAt`.
- Merged patients: clinical rows stay on the original patient id (they are never re-pointed); reads use the merge lineage.

---

## 3. Treatment plans

Status: **proposed — needs product sign-off.**

### 3.1 Plan items
| From \ To | PROPOSED | ACCEPTED | REJECTED | DEFERRED | SCHEDULED | IN_PROGRESS | COMPLETED | CANCELLED |
|---|---|---|---|---|---|---|---|---|
| **PROPOSED** | | ✔ | ✔ reason | ✔ reason | | | | ✔ reason |
| **DEFERRED** | ✔ re-propose | ✔ | ✔ reason | | | | | ✔ reason |
| **REJECTED** | ✔ re-propose | | | | | | | |
| **ACCEPTED** | | | | ✔ reason | ✔ | ✔ (same-day) | | ✔ reason |
| **SCHEDULED** | | ✔ (appointment cancelled) | | | | ✔ | | ✔ reason |
| **IN_PROGRESS** | | | | | | | ✔ | ✔ reason |
| COMPLETED / CANCELLED | terminal | | | | | | | |

- Patient decisions (ACCEPTED / REJECTED / DEFERRED) need `plan:approve`; SCHEDULED needs `plan:write` or
  `appointment:write`, and so does the undo SCHEDULED -> ACCEPTED (appointment cancelled; the only
  ACCEPTED move outside the decision flow, see `planItemTransitionPermissions(from, to)`); IN_PROGRESS/COMPLETED `plan:write` or `clinical:write`; PROPOSED/CANCELLED `plan:write`.
- `CANCELLED` = withdrawn by the clinician (not a patient decision).
- **Estimates freeze** the branch's effective catalogue price (paise, via `apps/api/src/catalog/pricing.ts`) when the
  item is proposed: `estimatePricePaise`, `priceSource` (BASE/OVERRIDE), `pricedAt`. Later catalogue or override changes
  never alter it. Re-proposal (REJECTED/DEFERRED → PROPOSED) and an explicit `reprice` re-freeze the current price.
  Line total = unit estimate × quantity (`planTotals`).
- Multiple sessions per item (`PlanItemSession`, numbered, optionally linked to an appointment and an encounter);
  sessions are cancelled, never deleted.
- Items of a presented plan are never deleted (**DB** trigger `plan_item_history`); only items of a never-presented
  DRAFT can be.

### 3.2 Plans
| From \ To | PRESENTED | ACCEPTED | PARTIALLY_ACCEPTED | REJECTED | COMPLETED | CANCELLED |
|---|---|---|---|---|---|---|
| **DRAFT** | ✔ (version 1) | | | | | ✔ reason |
| **PRESENTED** | | ✔ | ✔ | ✔ | | ✔ reason |
| **ACCEPTED** | ✔ (last accepted item deferred) | | ✔ | | ✔ | ✔ reason |
| **PARTIALLY_ACCEPTED** | ✔ (last accepted item deferred) | ✔ | | ✔ | ✔ | ✔ reason |
| **REJECTED** | ✔ re-present (new version) | | | | | ✔ reason |
| COMPLETED / CANCELLED | terminal | | | | | |

- After presentation the plan status follows its items (`derivePlanStatus`).
- **Versioning**: presenting takes version 1; **every change after presentation** (item added/edited/re-priced,
  decision, status change, plan header edit) appends a `TreatmentPlanVersion` snapshot (plan + all items + totals) in the
  same transaction and bumps `currentVersion`. Versions are append-only (**DB** grants); diffs via `diffPlanSnapshots`.
- **Approve** records the patient's approval (`approvedAt/By`, `plan:approve`) of a decided plan
  (ACCEPTED / PARTIALLY_ACCEPTED). Knob `requirePlanConsentForApproval` (default **true**): a GRANTED `TREATMENT_PLAN`
  consent signed against the plan's **current** version is required.
- Multiple plans per patient; a plan belongs to a branch (prices) and optionally an encounter. Plans are cancelled with
  a reason (**DB** CHECK), never deleted.

---

## 4. Consent

Status: **proposed — needs product sign-off.**

- **Types** (template-backed): `TREATMENT_PLAN`, `PROCEDURE` (procedure-specific, e.g. RCT, extraction),
  `RADIOGRAPH`, `CLINICAL_PHOTOGRAPHY`, `COMMUNICATION`. The M1 free-form catalogue (`CONSENT_TYPES`) is extended with
  these; M1 types stay valid.
- **Templates** (`ConsentTemplate`: code, type, title, active) hold their text in **append-only versions**
  (`ConsentTemplateVersion`, version 1, 2, …). Publishing new text adds a version; old signed consents keep pointing at
  the version the patient saw. Templates are deactivated, never deleted. Managing templates needs the new
  **`consent:template`** permission (org scope; OWNER by default).
- **Signing** (`consent:manage` on the branch) creates a `PatientConsent` that references the exact
  `templateVersionId` and — for `TREATMENT_PLAN` — the `planVersionId` the patient approved. `type`/`version` mirror the
  template so M1 consent lists keep working.
- **Capture** = in-person signature image uploaded first as a `PatientDocument` (category `CONSENT_FORM`), referenced as
  `documentId`; method `DIGITAL` (tablet) or `PAPER` (scanned). OTP capture is later.
- **Signer**: `SELF`, `GUARDIAN` or `REPRESENTATIVE` (+ `signerName` when not self) — needed for minors.
- Withdrawal keeps the M1 flow (status WITHDRAWN + reason); consents are never deleted.

---

## 5. Permissions (proposed changes)
- New `consent:template` (org): OWNER. Capturing consent stays `consent:manage`.
- RECEPTIONIST gains `plan:read` (quote estimates, book plan items, collect plan consent). No clinical read.
- Unchanged: DENTIST signs/amends/approves plans and does not book (`appointment:write` stays front desk);
  MANAGER has `schedule:manage` but no clinical write; ACCOUNTANT has no clinical, plan or appointment access.
- See generated `docs/permissions.md`.

## 6. Open questions for product sign-off
1. Undo check-in (CHECKED_IN → BOOKED) and IN_CHAIR → CHECKED_IN ("back to the waiting room")?
2. Automatic NO_SHOW after the grace period (background job) vs manual only?
3. Can a supervising dentist sign for another (co-sign)? Today only the treating dentist (DB CHECK).
4. Step-up re-authentication for signing encounters and approving plans?
5. Should amendments be restricted to the original author / treating dentist?
6. Should walk-ins be allowed to overbook a busy dentist (today: book unassigned instead)?
7. Diagnosis coding system (ICD-10 vs internal) and condition catalogue ownership.
8. Consent text approval workflow (who signs off a template version) and retention.

## Addendum — Wave 1 implementation decisions (proposed, needs sign-off)

Scheduling
- Walk-ins must start within 30 min of now (else 400) and skip the working-hours rule. Visits that are CHECKED_IN or
  IN_CHAIR (or inside the walk-in window) may be re-assigned a dentist/chair without the hours check; otherwise PATCH
  applies the hours rule to the new dentist/chair (409 `outside_working_hours`).
- Check-in only on the visit's branch-local day (or within the walk-in window across midnight): future day → 409
  `check_in_too_early {eligibleFrom}`, past day → 409 `check_in_too_late {startsAt}`.
- Working hours already in force today can only be replaced from tomorrow (409 `working_hours_in_force`).
- Concurrent bookings that deadlock (40P01/40001) are retried; the loser gets 409 `slot_conflict`.

Clinical
- The treating dentist needs `clinical:sign` for the encounter's branch from Membership scope (or org-wide). A
  `DentistBranchAssignment` alone does not grant clinical access (open question: should assignments extend scope?).
- Odontogram: rows charted in an encounter are branch-scoped for writes; encounter-less rows are patient-level; reads
  are patient-level with redaction.
- ProcedureRecord: IN_PROGRESS → COMPLETED | ABANDONED. A procedure may link to an ACCEPTED, SCHEDULED or IN_PROGRESS
  plan item of an open plan the caller can `plan:read`; otherwise 400 `invalid_plan_item`.

Plans
- PlanItemSession status is server-derived. Item COMPLETED is refused while any session is SCHEDULED (409
  `item_has_scheduled_sessions`) and cancels remaining PLANNED sessions.
- SCHEDULED → ACCEPTED undo and ACCEPTED → DEFERRED are refused while the item is still booked (409
  `item_still_scheduled`).
- One plan item per appointment (409 `appointment_linked_elsewhere`); the binding is cleared when the last open session
  releases the appointment (plans may write `Appointment.planItemId = null`).
