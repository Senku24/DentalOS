import { Module } from "@nestjs/common";

/**
 * M4 Patient portal — STAFF-FACING administration (ADR 0005 §1.5, §3.7). Owner: P1 (apps/api/src/portal-admin/**).
 * Staff routes with the normal `@Can(...)`: `portal:manage` (invite / suspend / reactivate / list accounts, flag a
 * document `portalVisible`) and `portal:admin` (portal settings in `Tenant.settings.portal`, bookable services,
 * default OTP / invite templates). Invites require `Patient.identityVerifiedAt` and a non-merged patient (the DB refuses
 * otherwise: `portal_identity_unverified`, `portal_patient_merged`). Audit with `AuditService` (source "api"). DTOs in
 * @dentalos/validation `portal.ts` (`invitePortalAccountRequest`, `portalAccountResponse`, `updatePortalSettingsRequest`, ...).
 * See docs/M4-portal-analytics-ai.md.
 */
@Module({})
export class PortalAdminModule {}
