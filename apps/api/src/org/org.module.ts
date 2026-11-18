import { Module } from "@nestjs/common";
import { AssignmentsController } from "./assignments.controller";
import { BranchesController } from "./branches.controller";
import { InvitationsController } from "./invitations.controller";
import { StaffController } from "./staff.controller";
import { TenantController } from "./tenant.controller";

/**
 * M1 Organisation: tenant settings/onboarding, branches, staff (memberships + invitations) and
 * dentist ↔ branch assignments. Owned by the org worker — add controllers/providers here only.
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Controllers depend only on those global providers (no module-local providers), so the module
 * stays wireable in isolation (see m1-wiring.test.ts).
 */
@Module({
  controllers: [
    TenantController,
    BranchesController,
    StaffController,
    InvitationsController,
    AssignmentsController,
  ],
  providers: [],
})
export class OrgModule {}
