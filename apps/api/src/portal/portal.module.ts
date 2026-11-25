import { Module } from "@nestjs/common";

/**
 * M4 Patient portal — PATIENT-FACING API (PRD 3.5, 4.10). Owner: P1 (apps/api/src/portal/**).
 * Routes: `@Public()` for OTP request / verify / select / refresh; everything else `@PortalAuth()` (+ `@PortalStepUp()` on
 * consent signing and plan decisions) with `@CurrentPatient() me: PatientPrincipal` — scope EVERY query by `me`, never by
 * a request field. Auth plumbing (PortalGuard, PortalTokenService, PortalAuditService, PORTAL_SECRETS) is global and lives
 * in apps/api/src/auth; DTOs, OTP / booking helpers and error codes in @dentalos/validation `portal.ts`.
 * Reuse the staff services' rules (scheduling, plans, billing, documents, notifications) by calling their helpers /
 * repeating their checks inside `withTenant`; do not widen staff controllers. See docs/M4-portal-analytics-ai.md and
 * docs/adr/0005-portal-analytics-ai-rules.md §1, §3. PRISMA, AuditService, EventBus, JobQueueService and StorageService are
 * @Global (AppModule) and injectable as-is.
 */
@Module({})
export class PortalModule {}
