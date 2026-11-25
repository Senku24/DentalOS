import { Module } from "@nestjs/common";
import { NotificationEnqueueService } from "../notifications/enqueue.service";
import { PortalAdminController, PortalAdminService } from "./portal-admin";

/**
 * M4 Patient portal — STAFF-FACING administration (ADR 0005 §1.5, §3.7). Owner: P1 (apps/api/src/portal-admin/**).
 * Staff routes with the normal `@Can(...)`: `portal:manage` (invite / suspend / reactivate / re-invite / list accounts, flag a
 * document `portalVisible`) and `portal:admin` (portal settings in `Tenant.settings.portal`, bookable services, default
 * OTP / invite templates seeded when the portal is enabled). Invites require `Patient.identityVerifiedAt` and a non-merged
 * patient (the DB refuses otherwise: `portal_identity_unverified`, `portal_patient_merged`). Audit with `AuditService`
 * (source "api"). DTOs in @dentalos/validation `portal.ts`. See docs/M4-portal-analytics-ai.md.
 */
@Module({
  controllers: [PortalAdminController],
  providers: [NotificationEnqueueService, PortalAdminService],
})
export class PortalAdminModule {}
