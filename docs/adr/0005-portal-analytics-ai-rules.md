# ADR 0005 — Patient portal, analytics and AI rules (M4 "Complete V1")

Status: **Proposed** (2026-11-25). **Every rule below is a proposed default — needs product sign-off.**
PRD §12.3 leaves the AI/speech providers, AI allowance volumes and the exact assistant actions open; §12.2 leaves consent and
retention rules open; §6.8 leaves every external provider unselected; §4.9 lists dashboards without defining a single metric;
§4.10 lists portal features without an identity model. M4 therefore implements these as documented defaults and as configuration
knobs where cheap. Each section carries its own status line so sign-off can happen piecemeal. A rule marked **DB** needs a migration
to change; the rest are service-level and change in `packages/validation` or `apps/api`. Laboratory management is **not V1**
(PRD §4.11) and is not built.

Source of truth in code:
- DTOs, pure helpers (OTP, booking rules, periods, metric formulas, prompt builders, de-identifier, stub provider, access/quota
  evaluators): `packages/validation/src/{portal,analytics,ai}.ts`
- DB enforcement: `packages/db/prisma/migrations/0009_m4_portal_analytics_ai/migration.sql` (constraints, triggers, column grants, RLS)
- DB error → API error mapping: `apps/api/src/common/db-errors.ts` (`m4GuardError`)
- Portal auth plumbing: `apps/api/src/auth/{portal-token,portal.guard,portal-metadata,patient-principal,portal-audit}.ts`
- Permissions: `packages/contracts/src/permissions.ts` → `docs/permissions.md` (generated)

Cross-cutting conventions (all M1–M3 conventions apply unchanged — `docs/M1-org-patients.md`, `docs/M2-clinical.md`,
`docs/M3-business-ops.md`, ADR 0003/0004): composite `(tenantId, id[, patientId[, branchId]])` FKs, FORCE RLS + `tenant_isolation` on
every table, append-only grants, ids-only audit, integer paise, idempotency keys, user ids are IdP subjects. The staff `Principal`
model is untouched: **a portal user is never a `Membership`**.

---

## 1. Portal identity and authentication

Status: **proposed — needs product sign-off.**

### 1.1 A separate principal
- A portal login is a `PatientPortalAccount`: exactly one patient of exactly one tenant. The server-built identity is
  `PatientPrincipal { tenantId, patientId, patientIds, accountPatientId, accountId, sessionId, actorId = "patient:<patientId>", stepUpAt }`
  (`auth/patient-principal.ts`). It is resolved by `PortalGuard` from the verified token **and the live session row**, never from client input.
- `PatientPrincipal` has no roles and no staff permission. For logging/tracing/audit compatibility the guard also sets
  `req.principal = { userId: "patient:<id>", tenantId, roles: [], orgWide: false, branchScope: [] }`; `can()` is therefore false for
  every staff permission, so a portal session can never act as staff even if a handler misuses a staff service.
- Role `PATIENT` stays in the `Role` enum (PRD 2.3) but is never stored on a `Membership` and has no permissions.

### 1.2 Login by one-time code (OTP)
| Rule | Default |
|---|---|
| Destination | the patient's mobile (E.164) or e-mail, normalised by the M1 normalisers (`normalizeLoginDestination`) |
| Code | **6 digits**, uniform CSPRNG (rejection sampling, no modulo bias) |
| TTL | **10 minutes** (DB CHECK: never > 1 hour) |
| Attempts | **5** per code (DB CHECK 1–10; `attempts` only counts up; locked at the cap) |
| Storage | **hash only**: `codeHash = HMAC-SHA256(PORTAL_OTP_PEPPER, "otp:<otpId>:<code>")`, `destinationHash = HMAC(pepper, "dest:<normalised>")`, `ipHash = HMAC(pepper, "client:<ip>")`. DB CHECK: 64-char hex only, so a plain code cannot be stored. The pepper means a leaked table alone cannot be brute-forced offline (10⁶ space). |
| Single use | `consumedAt` set once (trigger `portal_otp_guard`: also refuses an expired code or one at its attempt cap) |
| Delivery | through the **notifications outbox**: purpose `TRANSACTIONAL` (no marketing consent needed), system template `PORTAL_OTP` (placeholders `clinicName`, `code`, `validityMinutes`), channel SMS (phone) / EMAIL (e-mail) / WHATSAPP on request. Console provider in dev: read the code in the worker log. |
| Not left at rest | the outbox row must carry `variables.code` until sent. Once the message is final the job `portal.scrub-otp-message` removes the key; migration 0009 amends `notification_outbox_guard` to allow exactly "variables minus `code`" on a final `PORTAL_OTP` row, nothing else (**DB**). Listings hide `PORTAL_OTP`. |
| Throttles | counted from `PortalOtp` rows (works across API instances): per destination **3 / 15 min and 10 / 24 h**, per IP **20 / h**, **60 s** resend cooldown (`evaluateOtpRateLimit`). A throttled request answers 429 `otp_rate_limited` with `Retry-After`. |
| No enumeration | `POST /portal/auth/otp` answers identically whether or not an account matches (masked destination, random `challengeId` for a non-match, similar latency); nothing is sent for a non-match. |
| Default templates | `PORTAL_DEFAULT_TEMPLATE_BODIES` (SMS / WhatsApp / e-mail bodies for `PORTAL_OTP` and `PORTAL_INVITE`); enabling the portal seeds them for the tenant (idempotent). A tenant may edit them as new versions like any template. |

Purposes (`PortalOtpPurpose`): `LOGIN` and `ACTIVATE` (first login of an `INVITED` account — same flow, activation is the side effect),
`STEP_UP` (sensitive action, §3.4, bound to `subjectType/subjectId`), `CONTACT_VERIFY` (new phone/e-mail, §3.2). `STEP_UP` and
`CONTACT_VERIFY` need an account (DB CHECK).

### 1.3 Tokens and sessions
- **Access token**: JWT HS256, **15 minutes**. Claims: `iss = dentalos-portal-api`, `aud = dentalos-portal`, `typ = portal_access`,
  `tid`, `pid`, `aid`, `sid`. Signed with `PORTAL_JWT_SECRET` (in development derived from `DEV_JWT_SECRET` with an HMAC label).
  Production note: self-issued portal tokens are the V1 default; a **Cognito patient pool** (no MFA requirement, `mfaEnforcedByPool: false`
  already exists in the verifier config for exactly this) can replace `PortalTokenService` without touching callers.
- **Staff ↔ portal separation** — three independent barriers, plus the DB:
  1. *key*: portal key ≠ staff key (`createPortalSecrets` refuses `PORTAL_JWT_SECRET === DEV_JWT_SECRET`; production requires explicit secrets);
  2. *claims*: the portal verifier requires `iss`/`aud`/`typ`; the staff `DevTokenVerifier` rejects any token with that audience or type;
  3. *algorithm*: HS256 pinned for portal, RS256 pinned for Cognito staff tokens;
  4. *routing*: the global staff `AuthGuard` **skips** `@PortalAuth()` routes and the global `PortalGuard` acts **only** on them, so a portal token on a
     staff route is 401 and a staff token on a portal route is 401 (probe result in `docs/M4-portal-analytics-ai.md`).
- **Refresh token**: opaque `<tenantId>.<43 url-safe chars>` (256-bit secret; the tenant prefix opens the RLS context on the unauthenticated refresh
  call). Only `SHA-256` is stored (`PortalSession.refreshTokenHash`). Lifetime **30 days sliding**, hard cap **90 days** per family.
- **Rotation**: refresh inserts a successor `PortalSession` (same `familyId`, `rotatedFromId = old`) and revokes the old row. The unique key
  `(tenantId, rotatedFromId)` lets a refresh token be exchanged **exactly once**; presenting a revoked token revokes the whole family
  (`revokedReason = "reuse_detected"`). A revoked session is final (trigger).
- **Revocation**: logout revokes the session (`allDevices` all of the account's); **suspending an account revokes all its open sessions
  inside the database** (trigger `portal_account_suspend`), whatever code path suspended it; reactivation does not resurrect old sessions.
  `PortalGuard` checks the session row on every request, so revocation is immediate despite the stateless access token (cost: one indexed read).
- Sessions are created only for `ACTIVE` accounts (trigger). `PortalGuard` also checks `Tenant.settings.portal.enabled` (the master switch is effective immediately).
- Cookies: portal tokens live in an `HttpOnly` cookie owned by the Next BFF, never in JS (see `docs/M4-portal-analytics-ai.md`, patient-portal conventions).

### 1.4 Linking login destinations to patients
- One account = one patient. `UNIQUE (tenantId, patientId)`. **Guardian / family access is out of scope for V1** (PRD 7.7 parental handling is an open
  question, §10). Minors (< 18) get an account only like anyone else; the portal shows a minor notice and `minor: true` is returned; a guardian can
  use the minor's own phone/e-mail only if the clinic registered it for them.
- A destination is **not unique**: a parent's phone may be on several patient records. After a verified code, if several `ACTIVE`/`INVITED` accounts of
  the tenant match, the API answers `CHOOSE_PATIENT` with a 5-minute signed `selectionToken` + options (`accountId`, first name + last initial, minor flag)
  and the person picks one (`POST /portal/auth/select`). The token binds the verified OTP id and the exact candidate set, so a picked account must be one
  that code proved. A single match signs in directly.
- **Merged patients resolve to the survivor**: the account row stays on the patient it was created for; `PortalGuard` follows `mergedIntoId` to the current
  survivor (`patientId`, owner of new writes) and computes the lineage (`patientIds`, for reads of append-only history that stays on merged ids —
  the M1/M2 merge rule). If the survivor already has its own account, staff suspend the duplicate (open question O6).

### 1.5 Invite flow (staff creates, patient completes)
1. Staff with `portal:manage` calls `POST /portal-admin/accounts { patientId, loginPhone?, loginEmail? }`. Destinations default to the patient's own phone/e-mail.
2. The DB insists (trigger `portal_account_guard`, **DB**): the patient exists in the tenant, `identityVerifiedAt IS NOT NULL` (staff verified the identity,
   §1.6) and `mergedIntoId IS NULL`; the account is created `INVITED`; the inviter must be a current member.
3. The `PORTAL_INVITE` message (TRANSACTIONAL) goes through the outbox with the portal link (`PORTAL_PUBLIC_URL`, tenant in the URL).
4. The patient requests an OTP to the invited destination and verifies it: `INVITED → ACTIVE` (`activatedAt`), first session opens. No password, no token in the link.
5. Staff may `suspend` (reason ≥ 3 chars, sessions revoked) and `reactivate`. Status machine (trigger): `INVITED → ACTIVE | SUSPENDED`, `ACTIVE → SUSPENDED`,
   `SUSPENDED → ACTIVE` (was activated) or `→ INVITED` (never activated). Accounts are never deleted.
6. Changing the login destination later is the patient's own OTP-verified flow (§3.2) or staff re-invite with a new destination.

### 1.6 Identity must be verified by staff first
`Patient.identityVerifiedAt` (M1: `IN_PERSON_DOCUMENT | OTP_PHONE | OTP_EMAIL | GUARDIAN`) is the gate. An unverified patient cannot be invited and an account
cannot become `ACTIVE` without it (both **DB**). Rationale: an OTP proves control of a phone number, not that the number belongs to *that patient record* —
the clinic must have matched them in person (or by the verified method) before health data becomes reachable.

---

## 2. Scoping rules for every portal endpoint

Status: **proposed — needs product sign-off.**

- Tenant: from the token (`PatientPrincipal.tenantId`) → `withTenant(...)` (RLS). The only client-supplied tenant is the **unauthenticated** login start
  (`tenantId` of the clinic in the portal URL, or `PORTAL_TENANT_ID`); it grants nothing by itself (the code goes only to a registered destination).
  A vanity slug needs a tenant-less lookup (SECURITY DEFINER function) — open question O1.
- Patient: from the principal. **No portal request or response DTO has a `patientId`** (asserted in the helpers' probe). Reads of patient-owned history use
  `patientIds` (lineage) with `IN`; writes use `patientId`. Where a client passes an id (appointment, invoice, document, plan item) the handler loads it
  **with the patient predicate in the same query** and answers 404 otherwise (RLS hides other tenants, the predicate hides other patients).
- Branch: the portal has no branch scope; branches are those the tenant offers (`portal.bookableBranchIds`, default all active). Data is shown with its branch.
- Every state-changing portal call writes an `AuditEvent` with `source = "portal"` (§3.6) and takes an `idempotencyKey` where it creates something
  (`RequestDedupe` scope `portal.*`, `createdBy = "patient:<id>"`).
- Never trust a client success signal for money (§3.5) or a client-computed hash for consent (§3.4: the server recomputes the text hash).

---

## 3. What the portal shows and does

Status: **proposed — needs product sign-off.**

### 3.1 Read allow-list
| Area | Shown | Never shown |
|---|---|---|
| Profile | name fields, preferred name, DOB, sex, phone, alt phone, e-mail, address, MRN (read-only), communication preferences, `minor` | `identityDocument*`, `identityVerification*`, `createdBy`, lifecycle stage, merge ids, duplicate flags, staff notes, medical history / alerts / allergies (V1: not in the portal) |
| Appointments | own appointments (upcoming/past): type, time, branch (name, phone, address), service name, status, whether it can be rescheduled / cancelled and why not | notes, chair, outside-hours reasons, internal events, staff names beyond a display name, other patients |
| Plans & estimates | plans in states `PRESENTED …` (never `DRAFT`), items (service name, tooth label, quantity, frozen estimate), totals, GST estimate, the dentist-approved explanation (§5.5), consent still required | item/internal notes, price source, decision actors, `DRAFT` and `CANCELLED` plans |
| Invoices / payments / receipts | `ISSUED`, `PARTIALLY_PAID`, `PAID` invoices (never `DRAFT`; `VOID` hidden), lines, GST, payments with receipt numbers, online-payable flag | discount reasons, commission data, ledger entries, other patients' allocations |
| Documents | only `status = AVAILABLE` **and** `portalVisible = true` (staff flagged, never `ID_PROOF`; DB CHECK) | everything else — including every document by default; no public object-storage URL, ever |
| Consents | pending template versions for their plan, signed consents | consent templates not applicable to them |
| Notifications | their outbox rows, titled by `PORTAL_NOTIFICATION_TITLES` | `PORTAL_OTP`, `TEST_MESSAGE`, addresses of others, template variables |

### 3.2 Profile edits
- Free edits (allow-list `PORTAL_EDITABLE_PROFILE_FIELDS`): preferred name, alt phone, address fields, REMINDER / MARKETING opt-ins.
  `updatePortalProfileRequest` is a strict object — any other key is a 400. Name, DOB, sex change through the clinic (identity).
- **Phone / e-mail change** (`login` and contact): OTP sent to the **new** destination (`CONTACT_VERIFY`) plus a fresh step-up on the old session; on success the
  `Patient` contact and the account's login destination change together and an audit event is written. TRANSACTIONAL preferences cannot be switched off.
- The patient row is written through the shared patient write path (normalisers, `nameNormalized` / `phoneNormalized` upkeep); a merged tombstone is never written.

### 3.3 Booking, rescheduling, cancelling
Clinic rules (`Tenant.settings.portal`, all optional, `resolvePortalSettings` defaults; evaluators `evaluatePortalBooking` / `evaluatePortalChange`):
| Knob | Default | Meaning |
|---|---|---|
| `enabled` | **false** | master switch (invites, login, booking, everything) |
| `minNoticeHours` | 24 | a new booking must start ≥ N h from now; reschedule / cancel of an existing visit needs ≥ N h before its start |
| `maxAdvanceDays` | 90 | furthest booking |
| `maxReschedules` | 2 | length of the `rescheduledFromId` chain; at the limit the patient can cancel and rebook |
| `maxActiveBookings` | 3 | future open appointments one patient may hold (abuse cap) |
| `bookableAppointmentTypes` | CONSULTATION, CHECKUP, FOLLOW_UP | types offered; EMERGENCY / TREATMENT are staff-booked |
| `defaultDurationMin` | 30 | when no service is chosen |
| `bookableBranchIds` | all active | branches offered |
| `allowPatientCancel` | true | |
| `stepUpWindowMinutes` | 10 (≤ 15) | step-up validity |
| `requirePlanConsent` | true | an ACCEPTED plan decision needs a signed consent |
- A **service** is bookable only if staff set `Service.portalBookable` (**DB** column, default false).
- Free slots come from the **existing availability engine** (`GET /availability` logic: branch/dentist working hours, chairs, existing appointments, branch
  `slotMinutes`) — the portal adds no scheduling logic. A booking is created through the existing scheduling constraints (dentist and chair exclusion
  constraints → `slot_conflict` → `slot_unavailable`; **no dentist double-booking**), `source = SCHEDULED`, `createdBy = "patient:<id>"`, outside-hours bookings are
  impossible (no `schedule:manage`). The service picks a free dentist/chair (a patient dentist preference is open question O4).
- Rescheduling uses the existing reschedule path (old → `RESCHEDULED`, new linked row). Only `BOOKED` / `CONFIRMED` appointments can be changed
  (`PORTAL_CHANGEABLE_STATUSES`). Confirmation messages use the existing `APPT_CONFIRMATION` / `APPT_CHANGED` jobs.
- Violations answer 409 with the stable code from `PORTAL_VIOLATION_ERROR` (`booking_too_soon`, `reschedule_limit_reached`, …) plus `canReschedule` / `changeBlockedReason` on reads for the UI hint.

### 3.4 Plan decisions, consent and e-signature
- A patient may **accept / decline / defer** items of the plan's **current version** only (`PROPOSED`, `DEFERRED` items: `PORTAL_DECIDABLE_ITEM_STATUSES`);
  a stale `planVersion` answers `plan_version_stale`. Decisions go through the existing plan decision path (`decidedBy = "patient:<id>"`), so the plan status
  derivation, snapshots and notifications stay as in ADR 0003.
- **Step-up**: signing a consent or accepting plan items needs a fresh OTP **in the same session**: `POST /portal/auth/step-up` (OTP to the login
  destination, purpose `STEP_UP`, bound to the subject) then `/step-up/verify` sets `PortalSession.stepUpAt`. `@PortalStepUp()` enforces it (403
  `step_up_required`); window 10 min by default; **DB**: a signature row whose OTP is older than 15 min is refused.
- **E-signature** = typed full name (≥ 2 chars) + explicit "I agree" + the SHA-256 of the exact consent text shown. The server recomputes the hash of the
  current template version body (`portalConsentTextHash`) and refuses a mismatch (`consent_text_changed`). It then writes a `PatientConsent`
  (`method = DIGITAL`, `signerName = typedName`, `signerRelationship = SELF`, template + plan version links; the portal path does not need the staff path's
  `signatureDocumentId`) **and** a `PortalConsentSignature` evidence row in the same transaction (append-only: account, session, consent, typed name,
  text hash, `otpVerifiedAt`, `signedAt`, ip hash, user-agent hash). One signature per consent. Triggers refuse a non-ACTIVE account, a revoked session and a
  non-DIGITAL / non-GRANTED consent.
- Declining or deferring never needs a signature. A guardian signing for a minor is out of scope (O3).
- Consent and plan acceptance remain revocable only through the clinic (existing withdrawal path).

### 3.5 Online payments
- Invoice list, detail, payment history and **receipts** (`PAYMENT_RECEIPT` data) are read-only views of M3 data (only the patient's own).
- **Pay**: `POST /portal/payments/checkout { invoiceIds, amountPaise?, idempotencyKey }` goes through the existing gateway checkout (provider from
  `Tenant.settings.billing.gatewayProvider`; `STUB` in V1). Invoices must belong to the principal's patient and be payable; the amount is ≤ the sum of the
  balances (**no advance payments from the portal**; the staff path keeps them). The payment is `PENDING` until the **signed gateway webhook** confirms it
  (ADR 0004 §5); the browser's return URL only shows "processing". `returnUrl` must be https on an origin from config. `onlinePaymentsEnabled` is false when the
  provider is `MANUAL`.
- Receipts, allocation and ledger postings are the M3 code paths; the portal never writes money tables directly.

### 3.6 Audit
Decision: **portal actions are written to the same `AuditEvent` table** (hash-chained, ADR 0002) with `source = "portal"` and
`actorId = "patient:<patientId>"` (`portal:anonymous` before login). One timeline per patient/tenant, no second table to forget, same tamper evidence.
Ids only. Events: `portal.otp.request` / `portal.otp.verify` (outcome success|denied, resource `account`), `portal.login`, `portal.logout`, `portal.refresh.reuse`,
`portal.profile.update`, `portal.contact.change`, `portal.appointment.book|reschedule|cancel`, `portal.plan.decide`, `portal.consent.sign`, `portal.payment.checkout`,
`portal.document.download`, `portal.stepup`. Staff-side: `portal.account.invite|suspend|reactivate`, `portal.document.flag`, `portal.settings.update` (source `api`).
The unauthenticated routes write denied events too (rate-limited, never with the destination or code).

### 3.7 Staff-side administration
- `portal:manage` (tenant scope; OWNER, MANAGER, RECEPTIONIST): invite, suspend, reactivate, list accounts, flag a document `portalVisible` (also needs
  `document:write` at the document's branch; ID proofs refused by the DB). `portal:admin` (org; OWNER, MANAGER if orgWide): `Tenant.settings.portal`,
  `Service.portalBookable` bulk flags, default templates.
- Lists show masked destinations (`maskDestination`) and counts, never codes or token hashes.

---

## 4. Analytics

Status: **proposed — needs product sign-off.** (PRD §4.9: no custom report builder / KPI engine in V1.)

### 4.1 Principles
- Every figure is a **SQL aggregation inside `withTenant`** (RLS) intersected with the caller's branch scope; there is no cross-tenant query and no
  application-side summing of fetched rows. Branch-scoped callers only ever aggregate their branches (`branchWhere`).
- Money is integer paise; **rates are integer basis points** (`rateBp`, half up; `null` when the denominator is 0). No floats in stored or returned numbers.
- Reads use the analytic tables as they are (no new fact tables); the `AnalyticsSnapshot` is the only stored derivative (§4.5).

### 4.2 Metric definitions
All "in period" filters use the **local day range in the relevant time zone** (§4.3), half-open `[start, end)` in UTC.
| Metric | Definition |
|---|---|
| Total patients | `Patient` rows with `mergedIntoId IS NULL` and `createdAt < end` (merged tombstones excluded: one person, one count) |
| New patients | same, `createdAt` in period |
| Appointments | `Appointment` with `startsAt` in period, by status (all `AppointmentStatus`). `RESCHEDULED` rows are counted by status but excluded from rates (a successor row replaces them) |
| Completed visits | appointments with status `COMPLETED` in period |
| **Billed** | Σ `Invoice.totalPaise` of invoices in `ISSUED`, `PARTIALLY_PAID`, `PAID` with `issuedAt` in period (GST included; DRAFT and VOID never count) |
| Tax | Σ `Invoice.taxPaise` of those invoices |
| **Revenue** (headline) | **billed − tax** (excluding GST). Credit / debit notes are **not netted in**: shown as separate `creditNotesPaise` / `debitNotesPaise` (Σ `InvoiceAdjustment.amountPaise` by `createdAt`, tax-inclusive) so corrections stay visible (PRD 2.5) |
| **Collections** | Σ `Payment.amountPaise` with status `RECORDED` and `receivedAt` in period **minus** Σ `Refund.amountPaise` with status `PROCESSED` and `processedAt` in period. Includes unallocated advance (it is cash received) |
| Outstanding | Σ `Invoice.balancePaise` of `ISSUED` / `PARTIALLY_PAID` invoices **as of now** (not period-bound), with ageing by days past `dueDate` (`issuedAt` if none): `CURRENT`, 1–30, 31–60, 61–90, 90+ |
| Resolved appointments | start time already passed, excluding `RESCHEDULED` |
| **Cancellation rate** | `CANCELLED / resolved` |
| **No-show rate** | `NO_SHOW / (resolved − CANCELLED)` |
| Completion rate | `COMPLETED / (resolved − CANCELLED)` |
| Dentist performance (per dentist) | scheduled, completed visits (`Appointment.dentistUserId`), distinct patients seen, no-shows, cancellations, **billed = Σ `InvoiceLine.totalPaise`** of non-void issued invoices in period attributed to `InvoiceLine.dentistUserId` (the **originating** dentist, PRD 2.5; never rewritten after a transfer), average per visit |
| Waiting patients (branch, live) | today's appointments in `CHECKED_IN` (not yet `IN_CHAIR`), with minutes since `checkedInAt` |
| Dentist availability (branch, live, today) | working minutes (dentist's own `WorkingHours`, else the branch's, for today's weekday) vs booked minutes (appointments in `ACTIVE_APPOINTMENT_STATUSES`), free minutes, utilisation (`utilisationBp`, capped at 100%), next free moment, in chair now |
| Daily collections (branch) | collections of the branch-local day, by `Payment.method` |
| Cross-branch comparison | one row per branch the viewer may see: appointments, completed, new patients, cancellation / no-show rates, billed, collected, outstanding |

### 4.3 Periods and grains
- Presets: `today`, `yesterday`, `last_7_days`, `last_30_days` (default), `this_week` (Monday start), `this_month`, `last_month`, `this_quarter` (calendar),
  `this_fy` (1 April → today, same Indian FY rule as invoice numbering), `custom` (`from`/`to` inclusive local dates, ≤ 366 days). `resolvePeriod` returns the
  local dates and the exact UTC `[start, end)`.
- **Time zone**: a branch dashboard uses `Branch.timezone`; an org dashboard / org trends use `Tenant.settings.defaultTimeZone` (default `Asia/Kolkata`) for
  all branches (a cross-zone org is an edge case, open question O8). Day boundaries use the same `zonedToUtc` as scheduling.
- Grains for trends: `day`, `week` (Monday), `month`; default by length (`defaultGrain`); ≤ 400 buckets. Empty buckets are returned as zero (`enumerateBuckets`).
- **Comparison**: `previousPeriod` = the equal-length period immediately before; deltas in absolute and basis points (`trendDelta`, `percentBp = null` when the previous value is 0).

### 4.4 Branch vs organisation scope
- Org dashboard / comparison / org trends: `analytics:org` (`org` scope: requires an org-wide membership). Branch dashboard / snapshots / branch trends:
  `analytics:branch` at that branch. A branch-scoped caller asking for the org dashboard gets 403; asking for a branch outside their scope gets 403.
- `GET /analytics/org?branchIds=` may narrow the set; the service always intersects it with what the caller may see.

### 4.5 Daily snapshot (stored)
- Job `analytics.daily-snapshot` per branch shortly after its local midnight (cron fan-out `analytics.snapshot-sweep`): computes the **previous local day's** metrics
  (`branchDailyMetrics`, all money fields stored) into `AnalyticsSnapshot` (unique per branch and day; recomputing updates the row), then — if the
  `daily_branch_summary` capability is enabled and within quota — queues `ai.daily-summary`, which writes the narrative (`aiSummary` + `aiSummaryMeta`, labelled).
  The narrative is generated **from the numbers only** (§5.8).
- Reads mask money fields (`null`) for callers without `finance:report`; the AI narrative of a snapshot is only returned to callers who may see the money it mentions
  (a narrative quoting amounts is hidden from callers without `finance:report`).

### 4.6 Permission mapping
| Surface | Needs |
|---|---|
| Org dashboard, branch comparison, org trends | `analytics:org` (OWNER, ACCOUNTANT) |
| Branch dashboard, branch trends, snapshots | `analytics:branch` at the branch (OWNER, MANAGER, ACCOUNTANT) |
| A dentist's own numbers | `analytics:self` (DENTIST; org-wide holders see anyone) |
| **Any money figure** | additionally `finance:report` at the branch (OWNER, MANAGER, ACCOUNTANT). Without it the money fields are `null` and `financeVisible: false` — never an error, never a silently wrong number |
| Receptionists | no analytics in V1 (their operational view is the front-desk board); `analytics:branch` is not granted (open question O9) |
| Patients | none |

### 4.7 Caching
- In-memory per API instance, **per tenant + query + scope** (`analyticsCacheKey` includes tenant, query id, the caller's branch scope or "org", whether money is
  visible and the normalised params, so one caller's answer is never served to another with a different scope). TTL: **30 s** for live views (today, waiting, availability),
  **5 min** for period aggregates, **1 h** for snapshot reads (`ANALYTICS_CACHE_TTL_SECONDS`); ≤ 500 entries per tenant (`ANALYTICS_CACHE_MAX_ENTRIES`), oldest evicted.
  Responses carry `generatedAt` and `cached`. No cache is shared across instances (staleness ≤ TTL is accepted); `?fresh=1` is **not** offered in V1 (cost control).

### 4.8 Query discipline
Every dashboard query is a small number of grouped aggregations per entity (appointments by status/hour/dentist, invoices by status, payments by method), never N+1; indexes
already exist for `(tenantId, branchId, startsAt)`, `(tenantId, dentistUserId, startsAt)`, invoice and payment dates. A1 reports `EXPLAIN` notes for any query over 100 ms on the demo data.

---

## 5. AI

Status: **proposed — needs product sign-off.** Nothing is autonomous: every model output is a draft or an answer that a human reviews; the model never writes a record.

### 5.1 Capabilities and the gate order
The 7 approved capabilities (PRD 5.2) with their DB-independent rules (`AI_CAPABILITY_CATALOGUE`):
| Capability | Produces | Data class | Needs | Dentist approval |
|---|---|---|---|---|
| `patient_history_summary` | draft `PATIENT_HISTORY_SUMMARY` | clinical_text | `ai:use` + patient/medical/clinical read | no (staff-eyes only, ephemeral) |
| `encounter_summary` | draft `ENCOUNTER_SUMMARY` | clinical_text | `ai:use` + `clinical:read` | no |
| `clinical_note_draft` | draft `CLINICAL_NOTE` | clinical_text | `ai:clinical` + `clinical:write` | **yes** |
| `voice_note_draft` (EN/HI) | draft `VOICE_NOTE` | clinical_text | `ai:clinical` + `clinical:write`, consent | **yes** |
| `plan_explanation` | draft `PLAN_EXPLANATION` | structured | `ai:use` + `plan:read` | **yes** before the patient sees it |
| `nl_analytics` | answer (no draft) | aggregate | `ai:use` + the query's analytics permission | n/a (read-only) |
| `daily_branch_summary` | text on `AnalyticsSnapshot` | aggregate | job; read needs analytics | n/a (numbers-only) |

**Order of every call** (a refusal at any step logs an `AiActivityLog` row with the outcome and stops; nothing is sent to a provider before step 6):
1. resolve `AiConfig` from env (`resolveAiConfig`; **disabled by default**) → `disabled`
2. data-residency policy (`aiDataPolicy`, §5.9) → `region_not_compliant`
3. `AiSetting` row for the capability (no row = off) → `capability_disabled`
4. caller's role ∈ `allowedRoles` (never `PATIENT`) → `role_not_allowed`
5. caller's permissions on the capability **and on the underlying data at its branch** (the retrieval uses the caller's own scope; AI never widens it) → `permission_missing`
6. monthly quota (`AiUsage`) → `quota_exceeded`; then the minimised prompt is built, the provider called, output validated (`parseDraftContent` / JSON shape), the draft stored.
`evaluateAiAccess` is the pure form of steps 1–5.

### 5.2 Drafts and their status machine (**DB**)
- Output is stored as an `AiDraft` row: `kind`, subject, `patientId`, `branchId`, optional `encounterId` / `planVersionId` (composite FKs bind them to the patient),
  `content` (per-kind shape, `aiDraftContent` schemas), `metadata` with **`provider`, `model`, `promptVersion`** (DB CHECK) + `deidentified`, `createdBy`, `expiresAt`
  (**14 days**, `AI_DRAFT_TTL_DAYS`).
- Status: `DRAFT → APPROVED | REJECTED | EXPIRED`, exactly once (trigger `ai_draft_guard`); afterwards **everything is frozen**. Identity and provenance
  (kind, subject, patient, branch, links, metadata, creator, `createdAt`, `expiresAt`) never change, even in DRAFT; only `content`/`editedBy`/`editedAt` change while
  DRAFT; the content cannot change in the same update that leaves DRAFT, and an expired draft cannot be approved. Column grants allow nothing else; no deletes.
- **Visibly labelled**: every API response carries `metadata.{provider, model, promptVersion}`, `label = "AI-generated draft — review before use"` (or
  "AI-assisted, reviewed and approved by a dentist" once approved) and `contentHash`; UIs must render the label next to the text everywhere it appears.
- Edits: `PATCH /ai/drafts/:id` (creator or anyone with the same permissions at the branch) replaces top-level content keys; the result must still satisfy the kind's schema.
- Approve / reject: `POST /ai/drafts/:id/approve { contentHash, attestation: true }` — the hash of what the reviewer saw (409 `ai_content_changed` if it moved) and an explicit
  attestation. Reject needs a reason. Expiry is a daily sweep (`ai.draft-expiry-sweep`, logged `expire`).

### 5.3 Clinical drafts become records only through a dentist
- Approving a `CLINICAL_NOTE` / `VOICE_NOTE` draft needs `ai:clinical` **and** `clinical:write` at the encounter's branch (DENTIST), an **OPEN** encounter and the
  approver's own identity. In one transaction the service writes one `ClinicalNote` per non-empty SOAP section (`soapNotesFromDraft`: SUBJECTIVE, OBJECTIVE,
  ASSESSMENT, PLAN) through the existing clinical note path — `authorId` = the **approving dentist** (not the draft creator, not "AI") — with `aiAssisted = true`
  and `aiDraftId` set, then moves the draft to `APPROVED` with `resultingRecordType = "ClinicalNote"` and `resultingRecordId` = the first note.
- What the database guarantees (**DB**): an AI-flagged note must reference a **pending** note-kind draft of **its own encounter** as a SOAP kind; `aiAssisted` and
  `aiDraftId` travel together and never change; approval is refused unless a note by the approver exists for the draft; a **signed encounter refuses the note**
  (M2 trigger `clinical_content_guard`) — approved drafts never touch signed records, corrections go through the audited amendment workflow (PRD 5.4).
- `metadata`-style evidence for the record: the `aiAssisted` flag on each note row plus the immutable draft (provider, model, promptVersion, created/edited/reviewed by and at).
  (The task text's "aiAssisted flag in metadata" is implemented as real columns on `ClinicalNote`, queryable and constrained; the notes carry no free-form metadata column.)
- Clinical decision support is limited to summarising and drafting; prompts forbid diagnosis, prescribing and treatment decisions, and the content schemas have no
  such fields (PRD 5.4: no autonomous diagnosis, no image interpretation in V1).

### 5.4 Roles and permissions
`ai:use` (OWNER, MANAGER, DENTIST) is the baseline; `ai:clinical` (DENTIST only — owners are administrators, not clinicians) gates clinical-record drafts; `ai:admin` (OWNER, org scope)
manages settings, quotas and reads the activity log. On top of permissions, `AiSetting.allowedRoles` decides per capability which roles may use it (defaults in `AI_CAPABILITY_CATALOGUE.defaultRoles`:
clinical capabilities → DENTIST; `nl_analytics` → OWNER, MANAGER, ACCOUNTANT; `daily_branch_summary` → OWNER, MANAGER).

### 5.5 Patient-facing plan explanations
`plan_explanation` is built from **structured** facts only (service names, tooth numbers, quantities, frozen estimates; no patient attributes, no free text). English or Hindi.
It stays a DRAFT until a dentist (`plan:read` + `ai:use`, plus being a DENTIST role per `allowedRoles`) approves; only an **APPROVED** draft for the plan's **current version**
is returned to the portal (`explanation`, labelled AI-assisted) and may be used in a message. A new plan version makes the old explanation unreleased (version-bound FK), so a patient never
sees an explanation of a plan that has since changed. Rejected / expired drafts are never shown.

### 5.6 Voice (English / Hindi)
- Dictation audio (`AI_AUDIO_MIME_TYPES`, ≤ **10 MB**, ≤ 10 min) is received as multipart, **held in memory for the one provider call and discarded** — never written to disk, object
  storage, queues or logs; no raw audio persistence by default (PRD 5.5; any retention would need an approved purpose and policy).
- **Consent flag required**: the request must carry `consentConfirmed = true` **and** the patient must hold a GRANTED `AI_TRANSCRIPTION` consent (M1 consent type) — otherwise 409 `ai_consent_required`.
- Pipeline: transcribe (`AiProvider.transcribe`, `en` | `hi` | `auto`) → prompt builder with the transcript as `clinicianText` → SOAP draft. The transcript **text** is kept inside the draft's `content.transcript`
  for the dentist's comparison (it is clinical content under the draft rules), not the audio. The same approval rules as §5.3 apply.

### 5.7 Natural-language analytics
- The model never sees data and cannot run SQL. It receives the question and the **fixed catalogue** (`ANALYTICS_CATALOGUE`: 11 parameterised queries) and returns `{ queryId, params }` or `{ refuse }`.
- The output is **re-validated by the server** (`resolveNlAnalyticsPlan`): unknown `queryId` → refused; `params` parsed by a **strict** schema and reduced to the parameters that query reads (no filters can be smuggled);
  org-scope queries need an org-wide caller; financial queries need `finance:report`; a `branchId` outside the caller's scope is refused; a single-branch caller gets their branch filled in.
  The chosen query then runs through the **same analytics service and permission scope as the user** (§4), so an answer can never contain more than the dashboard would show them.
- Response: `{ question, resolved:{queryId,title,params}, refusal, data (the analytics response), label, logId }`. No free-text narrative is generated from data in V1 (nothing to hallucinate).

### 5.8 Daily branch summary
Generated by the nightly job from the **numbers** of the snapshot only (`buildDailySummaryPrompt`: counts, rupee amounts, rates; the model is told to quote, not compute). Stored on the snapshot with its label
(`aiSummaryMeta`). It is not a clinical or patient-facing artefact and needs no approval; it is read-only to `analytics:branch` holders (money-bearing text additionally needs `finance:report`).
Regeneration (`POST /ai/daily-summary/regenerate`) counts against the quota.

### 5.9 Provider abstraction, residency and the stub
- `AiProvider { name, model, regionCompliant, chat(), transcribe() }` (`ai.ts`): business code depends only on this. Implementations: **`stub`** (deterministic, offline, `[Stub]`-marked, valid draft shapes —
  `createStubAiProvider`) and **`openai-compatible`** (an adapter over a chat-completions + audio-transcription style HTTP API; built in `apps/api/src/ai`, 60 s timeout, never logs prompts/responses, https only except localhost).
- Selection by env: `AI_PROVIDER` (`stub` | `openai-compatible`; unset = **disabled**), `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_STT_MODEL`, `AI_REGION_COMPLIANT=true` (`resolveAiConfig`). A misconfigured provider resolves to
  disabled with a `problem` string shown to admins (never a secret).
- **India data-residency rule (PRD 5.6, 7.1)** (`aiDataPolicy`, decided before any prompt is built): no provider → refuse; the stub (no network) and any provider flagged `AI_REGION_COMPLIANT=true`
  → allowed; any other provider → only `aggregate` and `structured` capabilities (`nl_analytics`, `daily_branch_summary`, `plan_explanation`), whose prompts contain no patient data or free text; the four free-text
  `clinical_text` capabilities are **refused** (`ai_region_not_compliant`) rather than relying on best-effort de-identification. The flag is an assertion by the operator that region and contractual no-training / retention
  terms were validated (PRD 12.3); it is never inferred from the base URL.
- **Minimisation** (`build*Prompt`): explicit allow-lists per capability (extra properties on a Prisma row are ignored by construction); no names, phone numbers, e-mail, addresses, MRN or government ids; DOB becomes an **age band**;
  free text is length-capped and scrubbed (`deidentifyText`: e-mail, phone, Aadhaar / PAN shapes, and every known patient name token). `AiDraft.metadata.deidentified` and `AiActivityLog.deidentified` record that the prompt was minimised.
  The submitted prompts are not stored (§5.11). Patient data is never used for training: provider contracts must say so (PRD 5.6) and the adapter sends no training opt-in headers.

### 5.10 Settings, quotas and usage
- `AiSetting` (per tenant × capability; **no row = disabled**): `enabled`, `allowedRoles`, `monthlyQuota` (NULL = catalogue default; 0 = none), `retainContent`. Changed by `ai:admin` (`PATCH /ai/settings/:capability`, no defaults).
  Org-level enable/disable and role-based access are PRD 5.7 requirements; both live here.
- `AiUsage` (tenant × month × capability): `requestCount`, token counts, upserted with increments **inside the call's transaction**; month = first day of the month in the tenant's default time zone. A call that reaches the
  provider counts even if its output is later rejected; calls refused before the provider (disabled, role, region) do not. Quota default per capability in `AI_CAPABILITY_CATALOGUE` (commercial configuration, PRD 12.3 / 8.4: 150–1000 requests per month each).
- `GET /ai/usage` shows the month's usage and remaining quota (`ai:admin`); `GET /ai/capabilities` shows the caller what is available and why not.

### 5.11 AI activity log (**DB**, append-only)
Every AI call, approval, rejection, expiry and refusal writes one `AiActivityLog` row: actor (IdP subject or `system`), tenant, **scope** (`ORG | BRANCH | PATIENT`) with branch / patient ids, capability, provider, model, action, draft id,
approval (`APPROVED | REJECTED`), outcome (`success | refused | error | quota_exceeded | disabled | denied`), error code, token counts, latency, `deidentified`. **No prompt or response content** is stored unless the tenant switches
`AiSetting.retainContent` on for that capability (then `content`; default and recommended: off). UPDATE/DELETE are revoked from the app role. Readable by `ai:admin` (`GET /ai/activity`).

### 5.12 Assistant actions: read / draft only in V1
The central assistant (PRD 5.3) in V1 **retrieves, summarises and drafts**. Any mutation it suggests (book, cancel, send a message, change a record) is returned as an `aiProposal` — `{ executed: false, type, summary, confirmEndpoint:{method,path}, body }` —
that the UI displays; **only the user's explicit confirm** calls the normal endpoint with the user's own credentials, permissions, validation and audit. There is no code path where the assistant executes a mutation or sends a communication, and no
unreviewed clinical content is ever sent to a patient (PRD 5.3, 5.9). Which concrete actions may get a proposal flow is an open product decision (O12).

---

## 6. Provider integrations (PRD 6.8) — interfaces and env knobs

Status: **proposed — needs product sign-off.** V1 ships working **stubs behind stable interfaces**; no real provider contracts. A provider must pass security, privacy, residency, contractual, operational and cost evaluation before
production patient data is shared with it (PRD 6.8).
| Integration | Interface (where) | V1 implementation | Env knobs | Real provider later |
|---|---|---|---|---|
| Payment gateway | `Payment.gateway` + `createGatewayCheckoutRequest` / `gatewayWebhookPayload`, HMAC webhook `x-dentalos-signature` (ADR 0004 §5; `packages/validation/src/billing.ts`) | `STUB` checkout + signed webhook | `Tenant.settings.billing.gatewayProvider` (`MANUAL` \| `STUB`), `WEBHOOK_SECRET_STUB[_<TENANT>]` | add a `GatewayProvider` value + adapter |
| Messaging (WhatsApp / SMS / e-mail) | notification provider in the worker (`apps/worker/src/handlers/notifications/provider.ts`), outbox, delivery webhook | `CONSOLE` sender (logs the rendered message; the dev way to read OTPs) | `NOTIFY_PROVIDER`, per-channel tenant settings, `WEBHOOK_SECRET_*` | provider adapters + approved WhatsApp templates |
| AI inference | `AiProvider` (§5.9) | `stub`, `openai-compatible` | `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_REGION_COMPLIANT` | model / routing selected after residency validation |
| Speech-to-text | `AiProvider.transcribe` | stub transcript; `openai-compatible` audio endpoint | `AI_STT_MODEL` (default `AI_MODEL`) | a residency-compliant STT |
| Object storage | `StorageService` (S3 API, presigned URLs) | SeaweedFS in dev, S3 Mumbai in prod | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `AWS_REGION` | unchanged (S3-compatible) |
| Identity (staff) | `TokenVerifier` (Cognito / dev HS256) | Cognito + dev | `COGNITO_*`, `DEV_JWT_SECRET` | managed IdP of choice |
| Identity (patients) | `PortalTokenService` | self-issued HS256 + OTP | `PORTAL_JWT_SECRET`, `PORTAL_OTP_PEPPER` | Cognito patient pool |

Portal presentation env: `PORTAL_API_URL`, `PORTAL_TENANT_ID`, `PORTAL_PUBLIC_URL` (see `docs/M4-portal-analytics-ai.md`).

---

## 7. Configuration knobs (summary)

| Knob | Where | Default |
|---|---|---|
| `portal.*` (enabled, minNoticeHours, maxAdvanceDays, maxReschedules, maxActiveBookings, bookableAppointmentTypes, defaultDurationMin, bookableBranchIds, allowPatientCancel, stepUpWindowMinutes, requirePlanConsent) | `Tenant.settings.portal` | see §3.3 (portal **off**) |
| `Service.portalBookable` | column (**DB**) | false |
| `PatientDocument.portalVisible` (+ by / at) | columns (**DB**) | false |
| OTP length / TTL / attempts / throttles, token and session lifetimes | constants in `portal.ts` | §1.2, §1.3 |
| `AiSetting` per capability | table (**DB**) | no row = off |
| AI provider selection | env | disabled |
| Analytics TTLs / max cache entries | constants in `analytics.ts` | 30 s / 5 min / 1 h; 500 |
| Draft expiry | `AI_DRAFT_TTL_DAYS` | 14 |

## 8. Error codes
`PORTAL_ERROR_CODES` (`otp_invalid`, `otp_expired`, `otp_locked`, `otp_rate_limited`, `portal_disabled`, `portal_account_inactive`, `session_revoked`, `step_up_required`, booking / reschedule / change codes, `slot_unavailable`,
`consent_text_changed`, `plan_version_stale`, `document_not_available`, `payment_not_allowed`), `AI_ERROR_CODES` (`ai_disabled`, `ai_capability_disabled`, `ai_role_denied`, `ai_quota_exceeded`, `ai_region_not_compliant`,
`ai_provider_error`, `ai_consent_required`, `ai_audio_invalid`, `ai_draft_*`, `ai_encounter_signed`, `ai_content_changed`, `ai_refused`) and the trigger codes of `m4GuardError`. Validation failures stay `validation_failed`.

## 9. Audit
Portal events: §3.6. AI: staff actions on drafts and settings use `AuditService` (`ai.draft.approve|reject|edit`, `ai.setting.update`) **in addition to** the AI activity log (the log is the AI-specific
record; the audit trail is the platform-wide one). Analytics reads are not audited individually (aggregates); snapshot regeneration is.

## 10. Open questions
- **O1** Tenant resolution for the public portal: tenant id in the URL / env (V1) vs a vanity slug or custom domain per clinic (needs a tenant-less lookup function).
- **O2** OTP channel strategy and cost: SMS vs WhatsApp default, DLT registration for Indian SMS templates, e-mail as fallback, who pays.
- **O3** Guardian / family access and minors' consent (PRD 7.7): one account per patient in V1; do parents get a delegated view, from what age does a teenager see their own record?
- **O4** Patient dentist preference at booking and "my dentist" availability; whether first-time patients may book at all (V1: any verified patient).
- **O5** Which documents categories may ever be portal-visible by default (V1: none; staff flag individually; ID proofs never) and whether X-rays need a dentist's flag.
- **O6** Duplicate accounts after a merge (survivor already has an account): automatic merge of accounts or staff suspend (V1).
- **O7** Portal payment scope: partial payments, advances, saved cards, refunds to source, payment reminders from the portal; the real gateway choice (PRD 12.3).
- **O8** Org analytics in several time zones (V1: tenant default zone).
- **O9** Whether receptionists see operational analytics (waiting patients, day schedule) and finance summaries.
- **O10** Revenue definition: GST-exclusive billed (V1), vs net of credit notes, vs cash basis; dentist performance attribution when work is transferred (V1: originating dentist).
- **O11** AI: provider and model selection, region proof (PRD 12.3), included monthly quotas and overage packs, whether any decision-support beyond summarising / drafting is wanted (none approved), retention of prompts for quality review (V1: off).
- **O12** Which assistant actions may ever get a confirm-to-execute proposal flow (V1: none are created).
- **O13** Retention schedule for OTP rows, sessions, AI drafts, activity log, snapshots, consent evidence (PRD 7.7): V1 keeps OTP/session rows 30 days after expiry (sweep job) and everything else indefinitely; needs counsel.
- **O14** Hindi quality review of the system prompts, templates and portal copy by a clinician / native reviewer before pilot.
- **O15** Whether the portal needs an in-app inbox beyond the notification list (messaging with the clinic is not in PRD V1).
