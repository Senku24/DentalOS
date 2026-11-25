import { Module } from "@nestjs/common";
import { NotificationEnqueueService } from "../notifications/enqueue.service";
import { PortalAppointmentsController, PortalAppointmentsService } from "./portal-appointments";
import { PortalAuthController, PortalAuthService } from "./portal-auth";
import { PortalBillingController, PortalBillingService } from "./portal-billing";
import { PortalContentController, PortalContentService } from "./portal-content";
import { PortalOtpService } from "./portal-otp.service";
import { PortalPlansController, PortalPlansService } from "./portal-plans";
import { PortalProfileController, PortalProfileService } from "./portal-profile";

/**
 * M4 Patient portal — PATIENT-FACING API (PRD 3.5, 4.10). Owner: P1 (apps/api/src/portal/**).
 * Routes: `@Public()` for OTP request / verify / select / refresh; everything else `@PortalAuth()` (+ `@PortalStepUp()` on
 * consent signing, plan decisions and contact change) with `@CurrentPatient() me: PatientPrincipal` — EVERY query is scoped by
 * `me` (never by a request field). Auth plumbing (PortalGuard, PortalTokenService, PortalAuditService, PORTAL_SECRETS) is global
 * and lives in apps/api/src/auth; DTOs, OTP / booking helpers and error codes in @dentalos/validation `portal.ts`.
 * Files: portal-auth (login / refresh / step-up / me / sessions), portal-profile, portal-appointments, portal-plans (plans +
 * consents), portal-billing, portal-content (documents + notifications), portal-otp.service (codes + throttles).
 * `NotificationEnqueueService` needs only the global `JobQueueService`, so it is listed here instead of editing the
 * notifications module. See docs/M4-portal-analytics-ai.md and docs/adr/0005-portal-analytics-ai-rules.md §1, §3.
 */
@Module({
  controllers: [
    PortalAuthController,
    PortalProfileController,
    PortalAppointmentsController,
    PortalPlansController,
    PortalBillingController,
    PortalContentController,
  ],
  providers: [
    NotificationEnqueueService,
    PortalOtpService,
    PortalAuthService,
    PortalProfileService,
    PortalAppointmentsService,
    PortalPlansService,
    PortalBillingService,
    PortalContentService,
  ],
})
export class PortalModule {}
