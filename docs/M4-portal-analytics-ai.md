# M4 — Complete V1: status and conventions

Scope (PRD 3.5, 4.9, 4.10, 5, 6.8, 7.3, 9.2): the **patient portal** (own login, own data, booking, plans, invoices, documents, consents, online payment),
**analytics and dashboards**, the seven approved **AI capabilities** and the **provider integration** seams. Laboratory management is **not V1** (PRD 4.11) and is not built.
Domain rules: **`docs/adr/0005-portal-analytics-ai-rules.md` — proposed defaults, pending product sign-off.** Permission matrix: `docs/permissions.md` (generated).

> **No automated tests exist in this project right now** (deliberately removed). Do not write test files, scripts or test dependencies. The quality gate is
> `bun run lint`, `bun run typecheck`, `bun run build`; behaviour is verified with ad-hoc probes (psql, `bun`, curl against a locally started API) that are deleted
> afterwards. Local run setup: `docs/LOCAL-SETUP.md` (root `.env`; never print or commit secrets).
>
> **Database for local verification**: Postgres on `localhost:5433` (superuser `postgres/postgres`, app role `dentalos_app/dentalos_app`, database `dentalos`, migrations 0001–0009 applied).
> In the foundation run Docker Desktop was not running, so the database was a throwaway **Homebrew PostgreSQL 16 cluster** on the same port (see "Verification notes"); `bun run db:up` is the
> normal way and will conflict with that cluster on port 5433 until it is stopped.

## Done (foundation, Phase 0)
- [x] ADR 0005: portal identity (OTP, tokens, sessions, linking, invite, identity verification), scoping rules, portal read/write rules, analytics metric definitions / periods / permissions /
      caching, AI rules (gate order, drafts, clinical approval, plan explanations, voice, NL analytics, daily summary, provider abstraction + residency, settings / quotas / log, proposals),
      provider integration table and env knobs, error codes, audit list, 15 open questions.
- [x] Migration `0009_m4_portal_analytics_ai` (9 tables, 4 enums, 3 altered tables, hand-written constraints / triggers / grants / RLS — see "Database" below). No Prisma drift.
      RLS verified: every table has FORCE RLS + exactly one `tenant_isolation` policy.
- [x] `@dentalos/validation`: `portal.ts`, `analytics.ts`, `ai.ts` (DTOs, state helpers, pure evaluators, prompt builders, stub provider, queue names); `tenantSettings` gained `portal`;
      `SYSTEM_TEMPLATES` gained `PORTAL_OTP` and `PORTAL_INVITE`. All PATCH/update schemas have no zod defaults (`parse({})` is `{}`).
- [x] Permissions: new `analytics:self`, `ai:clinical`, `portal:manage`, `portal:admin` (existing `analytics:branch|org`, `ai:use|admin` kept); matrix in ADR §3.7 / §4.6 / §5.4.
- [x] API auth plumbing (`apps/api/src/auth`): `PatientPrincipal`, `@PortalAuth()` + `@PortalStepUp()`, global `PortalGuard`, `PortalTokenService` / `PortalSecrets`, `@CurrentPatient()`,
      `PortalAuditService`; staff `AuthGuard` skips `@PortalAuth()` routes; `DevTokenVerifier` refuses portal tokens. `common/db-errors.ts` gained `m4GuardError`.
- [x] Stub modules registered in `AppModule`: `PortalModule`, `PortalAdminModule`, `AnalyticsModule`, `AiModule`. Worker registry pre-wired with no-op `registerPortalHandlers`,
      `registerAnalyticsHandlers`, `registerAiHandlers` (folders `handlers/{portal,analytics,ai}/`), so Wave 1 never edits `handlers/index.ts`.
- [x] `.env.example` documents the new env (all commented): `PORTAL_JWT_SECRET`, `PORTAL_OTP_PEPPER`, `PORTAL_API_URL`, `PORTAL_TENANT_ID`, `PORTAL_PUBLIC_URL`, `AI_*`.

## Not done (Wave 1 and 2)
- [ ] Wave 1 P1 — portal endpoints, portal admin endpoints, OTP delivery + scrub / retention handlers, default template seeding.
- [ ] Wave 1 A1 — analytics endpoints, cache, snapshot job.
- [ ] Wave 1 I1 — AI endpoints, `openai-compatible` adapter, draft approval, quota / usage / log, AI job handlers.
- [ ] Wave 2 U1 — patient portal app; U2 — staff analytics UI; U3 — staff AI + portal-admin UI.
- [ ] Dev seed: demo portal account, AI settings (demo role logins exist from M3); `apps/api/scripts/seed-dev.ts` is owned by the last Wave 1 integrator (P1 adds a portal account; I1 adds `AiSetting` rows).
- [ ] M5 items: pen-test of the portal, provider contracts, real gateway / WhatsApp / AI provider, retention schedule (ADR open questions).

## Ownership map

Shared files are edited **only by the foundation agent** (this run) — Wave 1 / 2 report needed changes instead of editing them:
`packages/db/prisma/schema.prisma`, migrations, `packages/validation`, `packages/contracts`, `apps/api/src/{app.module.ts,common/**,auth/**}`, package.json files, `bun.lock`, `docs/**`
(the owner of a module may add a short status section to this doc only if the orchestrator says so).
Also do **not** edit M1–M3 modules (`apps/api/src/{org,catalog,patients,documents,scheduling,clinical,plans,billing,commissions,inventory,notifications}`): reuse their **exports** (pure helpers,
services that are already exported) or repeat their checks inside `withTenant`; report any change you need. Stateless providers may be added to your own module's `providers`
(e.g. `NotificationEnqueueService` needs only the global `JobQueueService`, so P1 lists it in `PortalModule` / `PortalAdminModule` instead of editing the notifications module).

### Wave 1 (API + worker; three agents in parallel, disjoint folders)
| Agent | Owns | Reads / reuses |
|---|---|---|
| **P1 portal** | `apps/api/src/portal/**`, `apps/api/src/portal-admin/**`, `apps/worker/src/handlers/portal/**` | `auth/*` portal plumbing, `validation/portal.ts`, scheduling availability + booking rules, plans / consent, billing gateway, documents storage, notifications enqueue, patients normalisers + merge lineage |
| **A1 analytics** | `apps/api/src/analytics/**`, `apps/worker/src/handlers/analytics/**` | `validation/analytics.ts`; exports `AnalyticsService` (incl. `runCatalogueQuery(principal, queryId, params)`) from `AnalyticsModule` for I1 |
| **I1 ai** | `apps/api/src/ai/**`, `apps/worker/src/handlers/ai/**` | `validation/ai.ts`, `AnalyticsModule` (import it), clinical / plans / patients read paths, `ClinicalNote` writes only through the approval transaction |

Hand-offs without shared code: A1's snapshot job enqueues `AI_QUEUES.DAILY_SUMMARY` by **queue name** via `JobQueueService` (payload `aiDailySummaryJob`); I1's handler writes `aiSummary` + `aiSummaryMeta` on the snapshot row.
P1's `PORTAL_QUEUES.SCRUB_OTP_MESSAGE` is enqueued by P1's own OTP service after the outbox row is created.

### Wave 2 (UI; three agents in parallel, disjoint folders)
| Agent | Owns |
|---|---|
| **U1 patient portal** | `apps/patient-portal/**` (the whole app; see "Patient portal conventions") |
| **U2 staff analytics** | `apps/staff-web/app/{reports,analytics}/**`, `apps/staff-web/lib/api/analytics*`, dashboard widgets under `apps/staff-web/components/analytics/**` (or `app/dashboard-widgets/**`), **`apps/staff-web/lib/nav.ts`** for ALL M4 entries (including U3's) |
| **U3 staff AI + portal admin** | `apps/staff-web/app/{admin/ai,admin/portal}/**`, `apps/staff-web/components/ai/**`, `apps/staff-web/lib/api/{ai*,portal-admin*}`, the draft review panels embedded in the encounter / plan / patient screens **only through a small exported component** that the M2 screens import (U3 reports the one-line import for the screen owner to add; do not edit M2 pages) |
Nav entries to add (U2): Reports (exists; drop `milestone: "M4"`, `analytics:branch`), Analytics `analytics:org` `/analytics`, AI `ai:admin` `/admin/ai`, Patient portal `portal:manage` `/admin/portal`.

## Database (migration 0009) — what is enforced, so services can lean on it
New tables, all tenant-owned, FORCE RLS + `tenant_isolation`, composite `(tenantId, …)` FKs:
| Table | Purpose / key constraints |
|---|---|
| `PatientPortalAccount` | one per patient (`UNIQUE(tenantId, patientId)`); `INVITED / ACTIVE / SUSPENDED`; login phone / e-mail normalised (CHECK formats, ≥ 1); **trigger**: patient identity staff-verified and not merged, created `INVITED`, status machine, identity columns frozen, inviter / suspender must be current members; status ↔ timestamps CHECK; **suspension revokes all open sessions (trigger)**; never deleted; app role cannot update `patientId` / inviter (column grants) |
| `PortalOtp` | hash-only (CHECK 64-hex), TTL ≤ 1 h, attempts ≤ max (≤ 10), STEP_UP / CONTACT_VERIFY need an account; **only `attempts` (up) and `consumedAt` (once, before expiry, below cap) updatable**; no delete for the app role (retention sweep as schema owner) |
| `PortalSession` | refresh-token SHA-256 (unique), family, `rotatedFromId` (unique ⇒ a token rotates once), `stepUpAt`, revoke fields; **trigger**: only ACTIVE accounts open sessions, rotation stays in the account + family, revoked is final, step-up never goes back; column grants: `lastUsedAt`, `stepUpAt`, `revokedAt`, `revokedReason` |
| `PortalConsentSignature` | append-only e-signature evidence: typed name (≥ 2), text SHA-256, `otpVerifiedAt ≤ signedAt ≤ +15 min` (CHECK), one per consent, **trigger**: ACTIVE account, open session of that account, GRANTED DIGITAL consent; FK ties consent to the same patient |
| `AiSetting` | per tenant × capability; roles never contain PATIENT; quota ≥ 0; `updatedBy` guarded (member) |
| `AiUsage` | per tenant × month × capability; counts ≥ 0; month = day 1; upsert-increment allowed |
| `AiActivityLog` | **append-only** (UPDATE / DELETE revoked); scope / outcome / approval CHECKs; optional `content` (only if the tenant enabled retention) |
| `AiDraft` | kinds / links per kind (CHECK), provenance keys in `metadata` (CHECK), review fields per status (CHECK); **trigger `ai_draft_guard`**: created DRAFT, `DRAFT → APPROVED | REJECTED | EXPIRED` once, frozen after, identity + metadata immutable, content unchanged when leaving DRAFT, expired cannot be approved, a note draft's approval needs the approver's AI-flagged `ClinicalNote`; column grants: content / status / review fields only; creator / editor / reviewer guarded as members; no delete |
| `AnalyticsSnapshot` | unique per branch and local day; AI summary requires its label meta; no delete |

Altered: `Service.portalBookable` (default false); `PatientDocument.portalVisible/By/At` (CHECK: needs who + when, never `ID_PROOF`; `portalVisibleBy` guarded); `ClinicalNote.aiAssisted` + `aiDraftId`
(CHECK they travel together; **trigger `clinical_note_ai_guard`**: a note may only reference a pending CLINICAL_NOTE / VOICE_NOTE draft of its own encounter as a SOAP kind, link immutable;
signed encounters still refuse notes via the M2 trigger); `PatientConsent` gained `UNIQUE(tenantId, id, patientId)`; **`notification_outbox_guard` replaced** so a final `PORTAL_OTP` row may drop `variables.code` (nothing else changes).

DB error codes (trigger `P0001` message prefix) → `m4GuardError` in `common/db-errors.ts` (`M4_GUARD_HTTP` gives the status):
`portal_account_state`, `portal_identity_unverified` (400), `portal_patient_merged`, `portal_account_inactive` (403), `portal_session_revoked`, `portal_session_link_mismatch`, `portal_consent_invalid`,
`otp_state`, `otp_expired` (400), `otp_locked` (429), `ai_draft_state`, `ai_draft_expired`, `ai_note_invalid`. Validate in the service first for a clearer message; the DB is the final authority under races.

## Portal auth plumbing — the pattern for Wave 1

```ts
// apps/api/src/portal/...  (P1)
import { PortalAuth, PortalStepUp } from "../auth/portal.guard";
import { CurrentPatient, type PatientPrincipal } from "../auth/patient-principal";
import { Public } from "../auth/auth.guard";

@Controller("portal/appointments")
export class PortalAppointmentsController {
  constructor(private readonly svc: PortalAppointmentsService) {}

  @PortalAuth()                                   // staff AuthGuard skips it; PortalGuard authenticates token + live session
  @Get()
  list(@CurrentPatient() me: PatientPrincipal, @Query(new ZodPipe(listPortalAppointmentsQuery)) q: ListPortalAppointmentsQuery) {
    return this.svc.list(me, q);                  // every query: withTenant(prisma, me.tenantId, tx => tx.appointment.findMany({ where: { patientId: { in: me.patientIds }, ... } }))
  }

  @PortalAuth() @PortalStepUp()                   // 403 { error: "step_up_required" } unless a fresh step-up OTP is in the session
  @Post(":id/…") sensitive(...) {}
}

@Controller("portal/auth")
export class PortalAuthController {
  @Public() @Post("otp") requestOtp(@Body(new ZodPipe(portalOtpRequest)) body: PortalOtpRequest) {}   // unauthenticated: rate-limit from PortalOtp rows
}
```
Rules:
- **Never** accept a `patientId` / `accountId` / `tenantId` from a request body, query or path for scoping. Resolve rows with the principal's `patientIds` (reads) or `patientId` (writes) **in the same query**; 404 otherwise.
- Portal routes use `@PortalAuth()` or `@Public()` only. `@Can` / `@StepUp` / `@Authenticated` / `@CurrentPrincipal` are staff concepts and are meaningless there (the guard sets `req.principal` with **no roles** purely so the access log, tracing and `AuditService` have a tenant / actor).
- Audit with `PortalAuditService.record({ tenantId, actorId }, …)` (writes `AuditEvent`, `source = "portal"`, `actorId = "patient:<id>"`; `PORTAL_ANONYMOUS_ACTOR` before login). Ids only.
- Secrets: inject `@Inject(PORTAL_SECRETS) secrets: PortalSecrets | null` (null = not configured → answer 503 on login routes) and `@Inject(PORTAL_TOKEN_SERVICE) tokens: PortalTokenService`. Hash with the helpers from `@dentalos/validation`:
  `hashOtpCode(code, otpId, secrets.pepper)`, `hashDestination(normalised, secrets.pepper)`, `hashClientValue(ip, secrets.pepper)`, `sha256Hex(refreshToken)`; compare hex with `constantTimeEqual`.
  Tokens: `tokens.signAccess({ tenantId, patientId: account.patientId, accountId, sessionId })`; refresh tokens `generateRefreshToken(tenantId)`; picker `tokens.signSelection` / `verifySelection`.
- Login transaction (P1): resolve tenant → `withTenant` → find matching accounts by normalised destination (`loginPhone` / `loginEmail`, status INVITED or ACTIVE, patient not merged) → check throttles with `evaluateOtpRateLimit` over recent `PortalOtp` rows
  → insert the OTP row (hashes only) + the `NotificationOutbox` row (template `PORTAL_OTP`, purpose TRANSACTIONAL, `variables.code`) → after commit enqueue send + scrub jobs. Verify: `evaluateOtpAttempt`, increment `attempts` / set `consumedAt` in one UPDATE, activate `INVITED → ACTIVE`, create the session, `lastLoginAt`.
- Map DB trigger errors with `m4GuardError`; unique violation on `(tenantId, rotatedFromId)` = refresh replay → revoke the family and answer 401.
- Suspension / revocation are immediate (PortalGuard reads the session each request). Do not cache principals.

### Probe results (foundation run) — staff ⇄ portal token separation
Run as `dentalos_app` against the migrated database with `DEV_JWT_SECRET` only (portal key derived), real `AuthGuard` / `PortalGuard` / verifiers, fake execution contexts; probe script deleted afterwards:
- staff token (HS256, DEV secret, `mfa: true`) → `PortalTokenService.verifyAccess` **rejects**; portal access token → staff `DevTokenVerifier.verify` **rejects**.
- a token carrying portal claims (`iss`, `aud`, `typ`) but signed with the **staff** secret → rejected by the staff verifier (audience / type) and by the portal verifier (key).
- `createPortalSecrets` refuses `PORTAL_JWT_SECRET === DEV_JWT_SECRET` and refuses a production boot without explicit portal secrets.
- `@PortalAuth()` route: staff token → 401 from `PortalGuard`; no token → 401; portal token → allowed, `req.patient` set (`actorId = patient:<id>`), `req.principal.roles = []`.
- staff route: portal token → 401 from `AuthGuard`; `AuthGuard` skips `@PortalAuth()` routes and `PortalGuard` ignores staff routes.
- `@PortalStepUp()` without step-up → 403 `step_up_required`; with a fresh step-up → allowed (the DB refuses moving `stepUpAt` backwards, so staleness was checked with the pure `isStepUpFresh`).
- tenant `portal.enabled = false` → 403 `portal_disabled`; revoked session → 401 `session_revoked`; token whose `pid` does not match the session's patient → 401;
  **suspending the account revokes its sessions in the database** (token → 401 `session_revoked`) and reactivation does not resurrect them.
- merged patient: principal `patientId` = survivor, `patientIds` = survivor + merged record, `accountPatientId` = original, `actorId = patient:<survivor>`.
- The API boots with both global guards (`/health/live` 200, `/me` without token 401, garbage bearer 401).

## Suggested routes (Wave 1 may refine; report the final list)

**Portal (P1, patient-facing)** — `@Public()`: `POST /portal/auth/otp`, `/portal/auth/verify`, `/portal/auth/select`, `/portal/auth/refresh`. `@PortalAuth()`: `POST /portal/auth/logout`, `/portal/auth/step-up`, `/portal/auth/step-up/verify`;
`GET /portal/me`; `GET /portal/sessions`, `DELETE /portal/sessions/:id`; `GET|PATCH /portal/profile`, `POST /portal/profile/contact`, `/portal/profile/contact/verify`;
`GET /portal/appointments`, `/portal/appointments/options`, `/portal/appointments/slots`, `POST /portal/appointments`, `POST /portal/appointments/:id/reschedule|cancel`;
`GET /portal/plans`, `/portal/plans/:id`, `POST /portal/plans/:id/decisions` (+ `@PortalStepUp()`); `GET /portal/invoices`, `/portal/invoices/:id`, `/portal/payments`, `/portal/payments/:id/receipt`, `POST /portal/payments/checkout`;
`GET /portal/documents`, `/portal/documents/:id/download-url`; `GET /portal/consents`, `POST /portal/consents/sign` (+ `@PortalStepUp()`); `GET /portal/notifications`.
**Portal admin (P1, staff, `@Can`)**: `POST /portal-admin/accounts` (`portal:manage`), `GET /portal-admin/accounts`, `POST /portal-admin/accounts/:id/suspend|reactivate|reinvite`, `PATCH /documents/:id/portal` → lives in `portal-admin` as `PATCH /portal-admin/documents/:id` (`portal:manage` + `document:write`),
`GET|PATCH /portal-admin/settings` (`portal:admin`), `GET|PUT /portal-admin/bookable-services` (`portal:admin`).
**Analytics (A1)**: `GET /analytics/org`, `/analytics/branches/:branchId`, `/analytics/dentists`, `/analytics/trends`, `/analytics/snapshots`.
**AI (I1)**: `GET /ai/capabilities`, `GET /ai/settings`, `PATCH /ai/settings/:capability`, `GET /ai/usage`, `GET /ai/activity`; `POST /ai/patient-summary`, `/ai/encounter-summary`, `/ai/clinical-note-draft`, `/ai/voice-note-draft` (multipart, field `audio`),
`/ai/plan-explanation`, `/ai/nl-analytics`, `GET /ai/nl-analytics/catalogue`, `GET /ai/daily-summary`, `POST /ai/daily-summary/regenerate`; `GET /ai/drafts`, `GET /ai/drafts/:id`, `PATCH /ai/drafts/:id`, `POST /ai/drafts/:id/approve|reject`.

## Validation exports (`@dentalos/validation`) by area
- **Portal (`portal.ts`)** — constants (`PORTAL_OTP_*`, token / session lifetimes, `PORTAL_OTP_RATE_LIMITS`, `PORTAL_TOKEN_AUDIENCE`, `PORTAL_ERROR_CODES`, `PORTAL_QUEUES`); crypto / OTP helpers (`generateOtpCode`, `hmacSha256Hex`, `sha256Hex`,
  `hashOtpCode`, `hashDestination`, `hashClientValue`, `constantTimeEqual`, `generateRefreshToken`, `parseRefreshToken`, `normalizeLoginDestination`, `maskDestination`, `evaluateOtpAttempt`, `evaluateOtpRateLimit`, `isStepUpFresh`);
  settings (`portalSettings`, `resolvePortalSettings`, `DEFAULT_PORTAL_SETTINGS`) and booking evaluators (`evaluatePortalBooking`, `evaluatePortalChange`, `isPortalChangeableStatus`, `PORTAL_VIOLATION_ERROR`); template defaults (`PORTAL_DEFAULT_TEMPLATE_BODIES`, `portalNotificationTitle`);
  auth DTOs (`portalOtpRequest/Response`, `portalVerifyOtpRequest/Response`, `portalSelectAccountRequest`, `portalRefreshRequest`, `portalLogoutRequest`, `portalStepUpRequest/VerifyRequest/Response`, `portalMeResponse`, `portalSessionResponse`);
  profile (`portalProfileResponse`, `updatePortalProfileRequest`, `portalContactChangeRequest`, `portalContactVerifyRequest`); appointments (`portalAppointmentResponse`, `listPortalAppointmentsQuery`, `portalBookingOptionsResponse`, `portalSlotsQuery/Response`,
  `portalBookAppointmentRequest`, `portalRescheduleRequest`, `portalCancelRequest`); plans (`portalPlanSummary`, `portalPlanResponse`, `portalPlanDecisionRequest`, `portalSignatureInput`); billing (`portalInvoiceSummary`, `portalInvoiceDetail`, `listPortalInvoicesQuery`,
  `portalPaymentResponse`, `portalReceiptResponse`, `portalCheckoutRequest/Response`); documents (`portalDocumentResponse`, `portalDocumentDownloadResponse`); consents (`portalConsentTextHash`, `portalConsentListResponse`, `portalSignConsentRequest/Response`);
  notifications (`portalNotificationResponse`); staff admin (`invitePortalAccountRequest`, `portalAccountResponse`, `listPortalAccountsQuery`, `suspendPortalAccountRequest`, `reactivatePortalAccountRequest`, `setDocumentPortalVisibleRequest`,
  `portalSettingsResponse`, `updatePortalSettingsRequest`, `setPortalBookableServicesRequest`, `portalBookableServiceAdminResponse`); jobs (`scrubOtpMessageJob`, `portalRetentionSweepJob`).
- **Analytics (`analytics.ts`)** — periods / grains (`resolvePeriod`, `previousPeriod`, `enumerateBuckets`, `bucketStart`, `defaultGrain`, `addCalendarDays`, `daysBetween`); formulas (`rateBp`, `trendDelta`, `kpi`, `utilisationBp`, `agingBucket`, `appointmentRates`);
  permission mapping + caching (`ANALYTICS_PERMISSIONS`, `ANALYTICS_CACHE_TTL_SECONDS`, `analyticsCacheKey`); queries (`analyticsPeriodQuery`, `orgDashboardQuery`, `branchDashboardQuery`, `dentistPerformanceQuery`, `trendsQuery`, `analyticsSnapshotQuery`);
  responses (`orgDashboardResponse`, `branchDashboardResponse`, `dentistPerformanceResponse`, `trendsResponse`, `analyticsSnapshotResponse`, `branchDailyMetrics`, `financeSummary`, `kpiResponse`, `aiLabel`); the NL catalogue (`ANALYTICS_CATALOGUE`, `ANALYTICS_QUERY_IDS`, `analyticsQueryParams`); jobs (`ANALYTICS_QUEUES`, `dailySnapshotJob`, `snapshotSweepJob`).
- **AI (`ai.ts`)** — catalogue / rules (`AI_CAPABILITIES`, `AI_CAPABILITY_CATALOGUE`, `AI_DRAFT_KINDS`, labels, `AI_ERROR_CODES`); provider (`AiProvider` interface, `AiChatRequest/Result`, `resolveAiConfig`, `aiDataPolicy`, `createStubAiProvider`, `estimateTokens`);
  gate helpers (`evaluateAiAccess`, `AI_DENIAL_ERROR`, `aiQuotaRemaining`, `aiUsageMonth`); minimisation (`deidentifyText`, `ageYears`, `ageBand`, `buildHistorySummaryPrompt`, `buildEncounterSummaryPrompt`, `buildClinicalNotePrompt`, `buildPlanExplanationPrompt`,
  `buildNlAnalyticsPrompt`, `buildDailySummaryPrompt`, `AI_PROMPT_VERSIONS`); drafts (`AI_DRAFT_CONTENT_SCHEMAS`, `parseDraftContent`, `soapNotesFromDraft`, `extractJsonObject`, `canonicalJson`, `aiContentHash`, `aiDraftMetadata`);
  NL (`nlAnalyticsModelOutput`, `resolveNlAnalyticsPlan`); DTOs (settings / capabilities / usage, `generate*Request`, `voiceNoteDraftFields`, `nlAnalyticsRequest/Response/CatalogueResponse`, `dailySummaryQuery`, `aiDraftResponse`, `listAiDraftsQuery`,
  `updateAiDraftRequest`, `approveAiDraftRequest/Response`, `rejectAiDraftRequest`, activity log, `aiProposal`); voice limits (`AI_AUDIO_MIME_TYPES`, `AI_MAX_AUDIO_BYTES`); jobs (`AI_QUEUES`, `aiDailySummaryJob`, `aiDraftExpirySweepJob`).

## Conventions (M4 additions; M1–M3 conventions apply unchanged)
- **Error shape**: `{ error: "<code>", ... }` with the stable codes of `PORTAL_ERROR_CODES` / `AI_ERROR_CODES`; validation failures are `validation_failed` from `ZodPipe`. Never echo submitted values (PII).
- **Idempotency**: portal create endpoints take `idempotencyKey` → `RequestDedupe` scope `portal.<action>` with `createdBy = "patient:<id>"` (replay returns the original). AI generation is not idempotent (each call is a quota unit) — the UI must disable double-submit.
- **Time**: day / period maths only through `utcToZoned` / `zonedToUtc` / `resolvePeriod` (branch or tenant time zone); store UTC.
- **Analytics SQL**: grouped aggregates in `$queryRaw` inside `withTenant`, parameterised, branch scope as `branchId = ANY(...)`; money as `bigint` cast to number at the edge; never loop per row. Cache with `analyticsCacheKey` + TTL constants; money masked per `finance:report`.
- **AI**: never log or persist prompts / responses (only the activity log row; `content` only with `retainContent`); never send a field that the prompt builders do not list; check `evaluateAiAccess` before building anything; validate every model output with `parseDraftContent` or the JSON shape
  and treat a parse failure as `ai_provider_error` (log `error`, no draft); show the label (`metadata` + `AI_DRAFT_LABEL`) everywhere AI text appears; approval writes records only inside the dentist-attributed transaction (ADR §5.3); audio never leaves memory; no assistant mutation (`aiProposal`).
  Multipart for voice: use `FileInterceptor("audio", { storage: memoryStorage(), limits: { fileSize: AI_MAX_AUDIO_BYTES } })` from `@nestjs/platform-express` (it bundles multer; add no dependency — if `@types/multer` is missing, declare a minimal local file type).
- **Portal data minimisation**: build portal responses with explicit field lists (the allow-list tables in ADR §3.1), never by spreading a Prisma row; no staff ids, notes or internal statuses.
- **Documents**: portal downloads use `StorageService` presigned GET (≤ 5 minutes) after the same `patientId` + `portalVisible` + `AVAILABLE` check; never a public URL; audit `portal.document.download`.
- **Payments**: the portal calls the same gateway-checkout code as staff with the principal's patient and the payable invoices; confirmation only by the signed webhook.
- **Seed / demo** (last Wave 1 integrator): demo patient with `identityVerifiedAt`, an ACTIVE portal account (phone = the demo patient's), `Tenant.settings.portal.enabled = true`, a few `Service.portalBookable`, `AI_PROVIDER=stub` hint, `AiSetting` rows for the demo roles. Dev OTP: read it in the worker log (console provider).

## Patient portal conventions (skeleton for U1; no screens built yet)
- **App**: `apps/patient-portal` (Next 15, port 3002, `@dentalos/ui` tokens + its own identity: a distinct accent / type scale in `app/portal.css` layered over `@dentalos/ui/tokens.css`; PRD 3.5 — **no staff chrome, no staff navigation**, no "DentalOS staff" strings).
  Add `@dentalos/validation` (and `@dentalos/contracts` only if needed) to `transpilePackages`; U1 may edit `package.json` of its own app for workspace deps that already exist in the repo (no new third-party dependency without reporting it).
- **Env** (root `.env`, loaded like staff-web's `loadRootEnv`): `PORTAL_API_URL` (server-side only, default `http://localhost:3001`), `PORTAL_TENANT_ID` (single-clinic deployments; otherwise the tenant is the first path segment `/t/<tenantId>/…` and is remembered in the non-sensitive cookie `portal_tenant`),
  `PORTAL_PUBLIC_URL` (invite / return links), `NEXT_PUBLIC_*` only for non-secret display values (e.g. `NEXT_PUBLIC_PORTAL_SUPPORT_PHONE`). **No token, secret or tenant secret is ever `NEXT_PUBLIC_*`.**
- **Same-origin BFF instead of a header-passing proxy** (the one deliberate difference from staff-web's `/api-proxy` rewrite: tokens must be attached server-side from an HttpOnly cookie, which a rewrite cannot do):
  - Auth route handlers (`app/api/portal/auth/{otp,verify,select,logout,step-up,step-up/verify}/route.ts`) call the API, **set / clear the cookies** and return only non-secret JSON (`me`, picker options, `stepUpUntil`) — never `tokens`.
  - A catch-all `app/api/portal/[...path]/route.ts` forwards every other call to `PORTAL_API_URL/portal/<path>` with `Authorization: Bearer <access cookie>`, transparently refreshes once on 401 (`/portal/auth/refresh`, rotating the refresh cookie; if refresh fails → clear cookies, 401 → the UI goes to `/login`), streams the body and relays `Retry-After` / error JSON.
  - Server components may call the same internal helper directly (no browser round trip).
- **Cookies**: `__Host-portal_at` (access token, `HttpOnly; Secure; SameSite=Lax; Path=/`, max-age = token ttl) and `__Host-portal_rt` (refresh token, `HttpOnly; Secure; SameSite=Strict; Path=/api/portal/auth`, 30 days). In local http development the `__Host-` prefix and `Secure` are dropped (`NODE_ENV !== "production"`). Tokens are never in `localStorage`, JS-readable cookies, URLs, logs or page props.
  CSRF: SameSite plus, on every mutating BFF call, a required `X-Portal-Csrf: 1` header and an `Origin` equal to the app's origin; JSON bodies only. Logout clears both cookies and revokes the session (`allDevices` optional).
- **Auth UX**: `/login` (phone or e-mail, tenant from URL / env) → `/login/verify` (6-digit code, resend countdown from `resendAfterSeconds`, attempts hint, 429 `Retry-After`) → optional `/login/choose` (picker) → `/`. A returning visitor with a valid refresh cookie lands signed in. Step-up is a modal that asks for a new code and retries the pending action.
- **Mobile first**: design at 360 px, one column, bottom tab bar (Home, Appointments, Bills, Plans, More), ≥ 44 px targets, `inputmode="numeric"` + `autocomplete="one-time-code"` on the code field, `font-size ≥ 16px` inputs, safe-area insets, no hover-only affordances, skeleton states, offline-tolerant error toasts. Progressive enhancement: pages render server-side.
- **Language**: English and Hindi (UI strings in a small `lib/i18n` dictionary keyed by `Accept-Language` / a stored choice; the AI explanation is already bilingual). Dates / amounts via `Intl` in the clinic's time zone and INR.
- **Pages (suggested)**: `/` home (next appointment, balance due, pending plan / consent, notifications), `/appointments` + `/appointments/new` (branch → service / type → date → slot) + `/appointments/[id]`, `/plans` + `/plans/[id]` (items, estimate, approved AI explanation with its label, decide + sign flow with step-up),
  `/bills` + `/bills/[id]` + `/bills/pay/return`, `/documents`, `/consents`, `/notifications`, `/profile` (+ contact change), `/sessions`. Show clinic name / branch phone prominently for anything the portal refuses (e.g. changes inside the notice window).
- **Safety copy**: never display the AI draft label as "approved" unless the API says so; sensitive pages set `Cache-Control: no-store`; no analytics / third-party scripts; strict CSP (self + the gateway checkout origin for return flows).

## Verification notes (Phase 0)
- Gate: `bun run lint`, `bun run typecheck`, `bun run build` all pass.
- Database: `prisma migrate deploy` applied 0001–0009 to a clean database; `prisma migrate status` up to date; `prisma migrate diff` (migrated DB → `schema.prisma`) is empty.
- RLS: every public table has `relforcerowsecurity` and exactly one `tenant_isolation` policy (query run: tables lacking either → 0 rows); the 9 new tables checked by name.
- Constraint / trigger / grant probes (≈ 75 statements as `dentalos_app` with RLS on, scripts deleted): account lifecycle and identity gates, OTP bounds / single use / expiry / column grants, session rotation / replay / revocation finality, document flag rules, e-signature evidence rules,
  AI setting / usage / log (append-only), draft status machine, note ↔ draft linkage, outbox OTP scrub rule, cross-tenant invisibility — all behaved as specified.
- Pure helpers probed with `bun` (OTP generation / hashing / throttles / attempts, booking evaluators, period maths in `Asia/Kolkata`, rates, deltas, ageing, cache keys, de-identifier, prompt minimiser, stub provider → draft schemas, NL plan validation incl. injection attempts, PATCH `parse({})`).
