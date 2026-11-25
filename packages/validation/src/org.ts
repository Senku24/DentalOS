import { z } from "zod";
import { tenantBillingSettings } from "./billing";
import {
  address,
  countryCode,
  dateOnly,
  email,
  isoDateTime,
  optionalText,
  phone,
  staffRole,
  timeZone,
  trimmed,
  uuid,
} from "./common";
import { notificationSettings } from "./notifications";
import { clinicalSettings } from "./plans";
import { portalSettings } from "./portal";

// ---------------------------------------------------------------------------------------------
// Tenant (organisation) settings & onboarding — PRD 4.1
// ---------------------------------------------------------------------------------------------

export const ONBOARDING_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED"] as const;
export const onboardingStatus = z.enum(ONBOARDING_STATUSES);

/** Non-secret organisation settings stored in Tenant.settings (JSON). Unknown keys are rejected. */
export const tenantSettings = z.strictObject({
  displayName: optionalText(120),
  logoKey: optionalText(300),
  defaultTimeZone: timeZone.optional(),
  currency: z.literal("INR").optional(),
  gstin: z
    .string()
    .trim()
    .regex(/^[0-9]{2}[A-Z0-9]{13}$/)
    .optional(),
  /** M2 clinical knobs (ADR 0003). */
  clinical: clinicalSettings.optional(),
  /** M3 billing knobs (ADR 0004 §10): GST mode, discount limits, refund threshold … */
  billing: tenantBillingSettings.optional(),
  /** M3 notification knobs (ADR 0004 §10): channels, reminder offsets, quiet hours, implicit consent. */
  notifications: notificationSettings.optional(),
  /** M4 patient-portal knobs (ADR 0005 §3): master switch, booking notice / limits, bookable types, step-up window. */
  portal: portalSettings.optional(),
});
export type TenantSettings = z.infer<typeof tenantSettings>;

export const updateTenantRequest = z.object({
  name: trimmed(120).optional(),
  settings: tenantSettings.optional(),
  onboardingStatus: onboardingStatus.optional(),
});
export type UpdateTenantRequest = z.infer<typeof updateTenantRequest>;

export const tenantResponse = z.object({
  id: uuid,
  name: z.string(),
  settings: tenantSettings,
  onboardingStatus,
  onboardedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type TenantResponse = z.infer<typeof tenantResponse>;

// ---------------------------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const session = z
  .object({ open: hhmm, close: hhmm })
  .refine((s) => s.open < s.close, "open must be before close");
/** Branch.workingHours: per weekday, zero or more non-overlapping sessions (local branch time). Missing day = closed. */
export const workingHours = z
  .partialRecord(z.enum(WEEKDAYS), z.array(session).max(4))
  .refine(
    (wh) =>
      Object.values(wh).every((sessions) =>
        [...(sessions ?? [])]
          .sort((a, b) => a.open.localeCompare(b.open))
          .every((s, i, arr) => i === 0 || (arr[i - 1]?.close ?? "") <= s.open),
      ),
    "Sessions overlap",
  );
export type WorkingHours = z.infer<typeof workingHours>;

/** Short branch code, stored upper-case (DB CHECK). */
export const branchCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/, "2-16 chars: letters, digits, hyphen");

export const createBranchRequest = address.extend({
  code: branchCode,
  name: trimmed(120),
  phone: phone.optional(),
  email: email.optional(),
  timezone: timeZone.default("Asia/Kolkata"),
  workingHours: workingHours.default({}),
});
export type CreateBranchRequest = z.infer<typeof createBranchRequest>;

/** PATCH: defaults stripped so absent keys stay absent (see `address` note in common.ts). */
export const updateBranchRequest = createBranchRequest.partial().extend({
  country: countryCode.optional(),
  timezone: timeZone.optional(),
  workingHours: workingHours.optional(),
});
export type UpdateBranchRequest = z.infer<typeof updateBranchRequest>;

export const setBranchActiveRequest = z.object({ active: z.boolean() });

export const listBranchesQuery = z.object({ active: z.stringbool().optional() });
export type ListBranchesQuery = z.infer<typeof listBranchesQuery>;

export const branchResponse = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string(),
  workingHours,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type BranchResponse = z.infer<typeof branchResponse>;

// ---------------------------------------------------------------------------------------------
// Staff: memberships & invitations
// ---------------------------------------------------------------------------------------------

const scopeRule = <T extends { orgWide?: boolean; branchScope?: string[] }>(v: T) =>
  v.orgWide === true || (v.branchScope?.length ?? 0) > 0;
const scopeMessage = { message: "Branch scope required unless orgWide", path: ["branchScope"] };

export const staffAccess = z.object({
  roles: z.array(staffRole).min(1).max(5),
  orgWide: z.boolean().default(false),
  branchScope: z.array(uuid).max(200).default([]),
});

export const createInvitationRequest = staffAccess
  .extend({ email, expiresInDays: z.number().int().min(1).max(30).default(7) })
  .refine(scopeRule, scopeMessage);
export type CreateInvitationRequest = z.infer<typeof createInvitationRequest>;

/** Invite link carries tenantId + raw token; the server stores only sha256(token). */
export const acceptInvitationRequest = z.object({
  tenantId: uuid,
  token: z.string().min(32).max(256),
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequest>;

export const INVITATION_STATUSES = ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"] as const;
export const invitationResponse = z.object({
  id: uuid,
  email: z.string(),
  roles: z.array(staffRole),
  orgWide: z.boolean(),
  branchScope: z.array(z.string()),
  status: z.enum(INVITATION_STATUSES),
  expiresAt: isoDateTime,
  invitedBy: z.string(),
  createdAt: isoDateTime,
});
export type InvitationResponse = z.infer<typeof invitationResponse>;

/** Re-issues a PENDING/EXPIRED invitation with a fresh token (the old link stops working). */
export const resendInvitationRequest = z.object({
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export type ResendInvitationRequest = z.infer<typeof resendInvitationRequest>;

export const listInvitationsQuery = z.object({ status: z.enum(INVITATION_STATUSES).optional() });
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuery>;

/** Full replacement of a member's access (PUT semantics: omitted orgWide/branchScope reset). */
export const updateMembershipRequest = staffAccess.refine(scopeRule, scopeMessage);
export type UpdateMembershipRequest = z.infer<typeof updateMembershipRequest>;

export const staffMemberResponse = z.object({
  id: uuid,
  userId: z.string(),
  roles: z.array(staffRole),
  orgWide: z.boolean(),
  branchScope: z.array(z.string()),
  /** M2 carry-over (Membership.displayName / email). Optional until every API path returns them. */
  displayName: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  /** Set when the member was removed (DELETE /staff/:id); only listed with `includeRemoved=true`. */
  removedAt: isoDateTime.nullable().optional(),
  removedBy: z.string().nullable().optional(),
  createdAt: isoDateTime,
});
export type StaffMemberResponse = z.infer<typeof staffMemberResponse>;

/** PATCH /staff/:id/profile — display details only (access changes use updateMembershipRequest). */
export const updateStaffProfileRequest = z.object({
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
});
export type UpdateStaffProfileRequest = z.infer<typeof updateStaffProfileRequest>;

export const listStaffQuery = z.object({
  role: staffRole.optional(),
  branchId: uuid.optional(),
  /** Include removed members (org-wide `staff:manage` only; 403 otherwise). */
  includeRemoved: z.stringbool().default(false),
});
export type ListStaffQuery = z.infer<typeof listStaffQuery>;

// ---------------------------------------------------------------------------------------------
// Dentist ↔ branch assignments (effective-dated; transfers affect the future only — PRD 2.5)
// ---------------------------------------------------------------------------------------------

export const assignDentistRequest = z.object({
  userId: z.string().min(1).max(200),
  branchId: uuid,
  effectiveFrom: dateOnly,
});
export type AssignDentistRequest = z.infer<typeof assignDentistRequest>;

/** Closes the open assignment at `fromBranchId` on `effectiveFrom` and opens one at `toBranchId`. */
export const transferDentistRequest = z
  .object({
    userId: z.string().min(1).max(200),
    fromBranchId: uuid,
    toBranchId: uuid,
    effectiveFrom: dateOnly,
  })
  .refine((v) => v.fromBranchId !== v.toBranchId, {
    message: "Branches must differ",
    path: ["toBranchId"],
  });
export type TransferDentistRequest = z.infer<typeof transferDentistRequest>;

export const endAssignmentRequest = z.object({ effectiveTo: dateOnly });

export const listAssignmentsQuery = z.object({
  userId: z.string().min(1).max(200).optional(),
  branchId: uuid.optional(),
  /** current = open today (branch-local) or starting later; all = full history. */
  status: z.enum(["current", "all"]).default("all"),
});
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuery>;

export const dentistAssignmentResponse = z.object({
  id: uuid,
  userId: z.string(),
  branchId: uuid,
  effectiveFrom: dateOnly,
  effectiveTo: dateOnly.nullable(),
  createdBy: z.string(),
  createdAt: isoDateTime,
});
export type DentistAssignmentResponse = z.infer<typeof dentistAssignmentResponse>;
