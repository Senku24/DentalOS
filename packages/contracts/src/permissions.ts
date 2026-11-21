import { ROLES, type Role } from "./roles";

/**
 * Staff permission catalogue (PRD 2.3, 7.4, 12.2). Code is the single source of truth:
 * `docs/permissions.md` is generated from it and tests are table-driven from it.
 *
 * Scope kinds:
 *  - tenant : any member holding the permission (shared patient profile, PRD 2.4)
 *  - branch : resource must belong to a branch in the principal's scope (or principal is orgWide)
 *  - org    : principal must be orgWide (organisation-wide administration/reporting)
 *  - self   : resource.ownerUserId must be the principal, unless principal is orgWide
 *
 * The client is never trusted; this runs server-side. The UI may reuse `can` only to hide controls.
 */
export const PERMISSIONS = {
  // Organisation & administration
  "org:read": "tenant",
  "org:manage": "org",
  "branch:read": "branch",
  "branch:manage": "org",
  "staff:read": "branch",
  "staff:manage": "org",
  "catalog:read": "tenant",
  "catalog:manage": "org",
  "price:override": "branch",
  // Patients
  "patient:read": "tenant",
  "patient:write": "tenant",
  /** Also covers duplicate-candidate review/dismissal. */
  "patient:merge": "tenant",
  "patient:export": "org",
  /** Medical/dental history, allergies, clinical alerts: health data, narrower than patient:read. */
  "medical:read": "tenant",
  "medical:write": "tenant",
  "document:read": "branch",
  "document:write": "branch",
  "consent:manage": "branch",
  /**
   * M2: author consent templates and publish new (append-only) versions. Org-wide clinical/legal
   * governance; capturing a patient's signature on a template stays `consent:manage`.
   */
  "consent:template": "org",
  // Appointments
  "appointment:read": "branch",
  "appointment:write": "branch",
  "appointment:checkin": "branch",
  "schedule:manage": "branch",
  // Clinical
  "clinical:read": "branch",
  "clinical:write": "branch",
  "clinical:sign": "branch",
  "clinical:amend": "branch",
  "plan:read": "branch",
  "plan:write": "branch",
  "plan:approve": "branch",
  // Finance
  "billing:read": "branch",
  "invoice:write": "branch",
  /** M3 (ADR 0004): credit / debit notes — the only correction of an issued invoice. */
  "invoice:adjust": "branch",
  "payment:record": "branch",
  "discount:apply": "branch",
  /** Request and process refunds. Above the approval threshold a second person needs `refund:approve`. */
  "refund:issue": "branch",
  /** M3: approve (or reject) a refund above the threshold; never the requester (maker-checker). */
  "refund:approve": "branch",
  "finance:report": "branch",
  "compensation:read": "self",
  /** Commission rules, ledger adjustments, creating and paying settlement runs. */
  "compensation:manage": "org",
  /** M3: approve a commission settlement run (maker-checker with `compensation:manage`). */
  "compensation:settle": "org",
  // Inventory
  "inventory:read": "branch",
  "inventory:write": "branch",
  /** M3: stock adjustments and waste write-offs (dentists consume stock but do not write it off). */
  "inventory:adjust": "branch",
  "inventory:transfer": "branch",
  // Communications
  "comms:send": "branch",
  /** M3: outbox, delivery status and notification history. */
  "comms:read": "branch",
  /** Notification templates and versions, channel/reminder/quiet-hours settings, recall intervals. */
  "comms:templates": "org",
  // Analytics, AI, audit
  "analytics:branch": "branch",
  "analytics:org": "org",
  "ai:use": "branch",
  "ai:admin": "org",
  "audit:read": "org",
  "breakglass:use": "org",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export type Scope = (typeof PERMISSIONS)[Permission];
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const ALL = ALL_PERMISSIONS;
const without = (...p: Permission[]) => ALL.filter((x) => !p.includes(x));

/**
 * Role -> permissions. Least privilege by default. Owners are administrators, not clinicians:
 * an owner who also treats patients holds BOTH roles (Membership.roles is a set).
 * PATIENT has no staff permissions; the portal uses its own self-scoped surface (M4).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: without(
    "medical:write",
    "clinical:write",
    "clinical:sign",
    "clinical:amend",
    "plan:write",
    "plan:approve",
    "breakglass:use",
  ),
  MANAGER: [
    "org:read",
    "branch:read",
    "staff:read",
    "catalog:read",
    "price:override",
    "patient:read",
    "patient:write",
    "patient:merge",
    "medical:read",
    "document:read",
    "document:write",
    "consent:manage",
    "appointment:read",
    "appointment:write",
    "appointment:checkin",
    "schedule:manage",
    "clinical:read",
    "plan:read",
    "billing:read",
    "invoice:write",
    "invoice:adjust",
    "payment:record",
    "discount:apply",
    "refund:approve",
    "finance:report",
    "inventory:read",
    "inventory:write",
    "inventory:adjust",
    "inventory:transfer",
    "comms:send",
    "comms:read",
    "analytics:branch",
    "ai:use",
  ],
  DENTIST: [
    "org:read",
    "branch:read",
    "catalog:read",
    "patient:read",
    "patient:write",
    "medical:read",
    "medical:write",
    "document:read",
    "document:write",
    "consent:manage",
    "appointment:read",
    "clinical:read",
    "clinical:write",
    "clinical:sign",
    "clinical:amend",
    "plan:read",
    "plan:write",
    "plan:approve",
    "inventory:read",
    "inventory:write",
    "compensation:read",
    "ai:use",
  ],
  RECEPTIONIST: [
    "org:read",
    "branch:read",
    "catalog:read",
    "patient:read",
    "patient:write",
    "medical:read",
    "medical:write",
    "document:read",
    "document:write",
    "consent:manage",
    "appointment:read",
    "appointment:write",
    "appointment:checkin",
    // M2 (ADR 0003, proposed): front desk quotes estimates, books plan items and collects plan consent.
    "plan:read",
    "billing:read",
    "invoice:write",
    "payment:record",
    "inventory:read",
    "comms:send",
    "comms:read",
  ],
  ACCOUNTANT: [
    "org:read",
    "branch:read",
    "catalog:read",
    "patient:read",
    "billing:read",
    "invoice:write",
    "invoice:adjust",
    "payment:record",
    "discount:apply",
    "refund:issue",
    "finance:report",
    "compensation:read",
    "compensation:manage",
    "analytics:branch",
    "analytics:org",
  ],
  PATIENT: [],
};

/** Authenticated, verified, server-built identity. Never populated from client input. */
export interface Principal {
  userId: string;
  tenantId: string;
  roles: Role[];
  /** Organisation-wide access across all branches of the tenant. */
  orgWide: boolean;
  /** Branch ids this principal is restricted to when not orgWide. */
  branchScope: string[];
}

/** What a permission check is about. Omit fields that do not apply (e.g. list endpoints). */
export interface Resource {
  tenantId?: string;
  branchId?: string;
  ownerUserId?: string;
}

export const isRole = (v: unknown): v is Role => (ROLES as readonly string[]).includes(v as string);

export const hasPermission = (roles: readonly Role[], perm: Permission): boolean =>
  roles.some((r) => ROLE_PERMISSIONS[r].includes(perm));

/**
 * Capability + scope check. Fails closed.
 * Without `resource.branchId` a branch-scoped permission only proves capability: callers
 * MUST then filter data with `branchFilter()`.
 */
export function can(p: Principal, perm: Permission, resource: Resource = {}): boolean {
  if (resource.tenantId !== undefined && resource.tenantId !== p.tenantId) return false;
  if (!hasPermission(p.roles, perm)) return false;
  switch (PERMISSIONS[perm]) {
    case "tenant":
      return true;
    case "org":
      return p.orgWide;
    case "branch":
      if (p.orgWide || resource.branchId === undefined) return true;
      return p.branchScope.includes(resource.branchId);
    case "self":
      if (p.orgWide) return true;
      return resource.ownerUserId !== undefined && resource.ownerUserId === p.userId;
    default:
      return false;
  }
}

/** `undefined` = no branch restriction (orgWide); otherwise the only branch ids that may be queried. */
export const branchFilter = (p: Principal): string[] | undefined =>
  p.orgWide ? undefined : p.branchScope;
