import {
  type Permission,
  type Principal,
  ROLES,
  type Resource,
  type Role,
  can,
  isRole,
} from "@dentalos/contracts";
import { branches as FIXTURE_BRANCHES, STAFF_DIRECTORY } from "./api/fixtures";

/**
 * DEV-ONLY stand-in for the real session (Cognito + /me, next M0 item). The server remains the
 * authority for every permission; this only decides what the UI shows.
 * Pick a role with NEXT_PUBLIC_DEV_ROLE (e.g. OWNER, RECEPTIONIST) to preview role-specific screens.
 * Branch ids match the mock fixtures so mock mode and the switcher agree.
 */
const envRole = process.env.NEXT_PUBLIC_DEV_ROLE;
const role: Role = isRole(envRole) && envRole !== "PATIENT" ? envRole : "MANAGER";

export const DEV_BRANCHES = FIXTURE_BRANCHES.filter((b) => b.active).map((b) => ({
  id: b.id,
  name: b.name,
}));

export const DEV_PRINCIPAL: Principal = {
  userId: "dev-user",
  tenantId: "00000000-0000-0000-0000-000000000001",
  roles: [role],
  orgWide: role === "OWNER" || role === "ACCOUNTANT",
  branchScope: [DEV_BRANCHES[0]?.id ?? ""],
};
export const DEV_USER = {
  name: "Asha Verma",
  roleLabel: role.charAt(0) + role.slice(1).toLowerCase(),
};

/** Display-only permission check against the DEV principal. Never a security boundary. */
export const canDo = (perm: Permission, resource?: Resource) => can(DEV_PRINCIPAL, perm, resource);

/** Active branches the DEV principal may act in (all active ones when orgWide). Used to default forms. */
export const scopedBranchIds = (all: { id: string; active?: boolean }[]) =>
  all
    .filter((b) => b.active !== false)
    .map((b) => b.id)
    .filter((id) => DEV_PRINCIPAL.orgWide || DEV_PRINCIPAL.branchScope.includes(id));

/** Human label for a staff user id. The membership API returns ids only (see Flags). */
export const userLabel = (userId: string) => STAFF_DIRECTORY[userId]?.name ?? userId;
export const userEmail = (userId: string) => STAFF_DIRECTORY[userId]?.email;

export { ROLES };
