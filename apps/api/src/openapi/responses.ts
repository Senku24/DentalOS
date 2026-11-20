import {
  STAFF_ROLES,
  branchResponse,
  dentistAssignmentResponse,
  invitationResponse,
  isoDateTime,
  onboardingStatus,
  staffMemberResponse,
  tenantResponse,
  uuid,
} from "@dentalos/validation";
import { z } from "zod";

/**
 * Per-operation response documentation, keyed by operationId (`<Controller>_<handler>`), for what the
 * Nest metadata cannot tell the generator: the success body (controllers return plain objects) and
 * the route-specific error codes (`{ error: "<code>" }`), most of which are thrown from services and
 * helpers rather than declared on the handler.
 *
 * Coverage: the org / staff / me routes (verified against live responses in openapi.test.ts).
 * Operations not listed here are documented with an untyped success body — see UNTYPED_NOTE — until
 * their owners add entries (the clinical, scheduling, plans, patients, catalog and documents
 * controllers are outside this module's owners; proposal in the X1 report).
 *
 * Schemas exported by @dentalos/validation are emitted as named components; inline ones are inlined.
 * Codes listed for a status are in addition to the generic ones (400 `validation_failed`, 401, 403,
 * 404) that every operation already documents.
 */
export interface RouteDoc {
  /** Success body (output side). Omit for 204 / SSE. */
  response?: z.ZodType;
  /** Shorthand for a `{ items: T[] }` list body (keeps `T` a named, $ref'd component). */
  items?: z.ZodType;
  /** Route-specific `error` codes by HTTP status. */
  errors?: Partial<Record<400 | 403 | 404 | 409 | 410, string[]>>;
}

export const UNTYPED_NOTE =
  "Response body not yet described in the contract (apps/api/src/openapi/responses.ts).";

const issuedInvitation = invitationResponse.extend({
  /** Raw invite token, returned once (only its sha256 is stored). */
  token: z.string(),
  acceptPath: z.string(),
});

const principal = z.object({
  userId: z.string(),
  tenantId: uuid,
  roles: z.array(z.enum(STAFF_ROLES)),
  orgWide: z.boolean(),
  branchScope: z.array(z.string()),
});

const staffRemoval = staffMemberResponse.extend({
  endedAssignmentIds: z.array(uuid),
  cancelledAssignmentIds: z.array(uuid),
});

const onboarding = z.object({
  status: onboardingStatus,
  onboardedAt: isoDateTime.nullable(),
  steps: z.object({
    settings: z.boolean(),
    branches: z.boolean(),
    services: z.boolean(),
    staff: z.boolean(),
  }),
  complete: z.boolean(),
});

const transfer = z.object({ closed: dentistAssignmentResponse, opened: dentistAssignmentResponse });

export const ROUTE_DOCS: Record<string, RouteDoc> = {
  // ---------------------------------------------------------------- me
  Me_me: { response: principal },
  Me_admin: { response: z.object({ ok: z.literal(true) }) },

  // ---------------------------------------------------------------- organisation
  Tenant_get: { response: tenantResponse },
  Tenant_update: { response: tenantResponse, errors: { 400: ["invalid_settings"] } },
  Tenant_onboarding: { response: onboarding },

  // ---------------------------------------------------------------- branches
  Branches_list: { items: branchResponse },
  Branches_get: { response: branchResponse },
  Branches_create: { response: branchResponse, errors: { 409: ["branch_code_taken"] } },
  Branches_update: { response: branchResponse, errors: { 409: ["branch_code_taken"] } },
  Branches_activate: { response: branchResponse },
  Branches_deactivate: { response: branchResponse },

  // ---------------------------------------------------------------- staff
  Staff_list: { items: staffMemberResponse },
  Staff_get: { response: staffMemberResponse },
  Staff_update: {
    response: staffMemberResponse,
    errors: { 400: ["unknown_branch"], 409: ["member_removed", "last_owner"] },
  },
  Staff_updateProfile: { response: staffMemberResponse, errors: { 409: ["member_removed"] } },
  Staff_remove: { response: staffRemoval, errors: { 409: ["member_removed", "last_owner"] } },

  // ---------------------------------------------------------------- invitations
  Invitations_list: { items: invitationResponse },
  Invitations_create: {
    response: issuedInvitation,
    errors: { 400: ["unknown_branch"], 409: ["invitation_pending"] },
  },
  Invitations_resend: {
    response: issuedInvitation,
    errors: { 409: ["invitation_not_resendable", "invitation_pending"] },
  },
  Invitations_revoke: { response: invitationResponse, errors: { 409: ["invitation_not_pending"] } },
  Invitations_accept: {
    response: staffMemberResponse,
    errors: {
      403: ["email_mismatch"],
      409: ["already_member"],
      410: ["invitation_expired", "invitation_accepted", "invitation_revoked"],
    },
  },

  // ---------------------------------------------------------------- dentist assignments
  Assignments_list: { items: dentistAssignmentResponse },
  Assignments_assign: {
    response: dentistAssignmentResponse,
    errors: {
      400: ["not_a_dentist", "effective_date_in_past"],
      409: ["branch_inactive", "assignment_open"],
    },
  },
  Assignments_transfer: {
    response: transfer,
    errors: {
      400: ["not_a_dentist", "effective_date_in_past", "transfer_before_assignment_start"],
      409: ["branch_inactive", "no_open_assignment", "assignment_open"],
    },
  },
  Assignments_end: {
    response: dentistAssignmentResponse,
    errors: {
      400: ["effective_date_in_past", "end_before_assignment_start"],
      409: ["assignment_closed"],
    },
  },
};
