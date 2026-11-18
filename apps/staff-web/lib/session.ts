import { type Principal, ROLES, type Role, isRole } from "@dentalos/contracts";

/**
 * DEV-ONLY stand-in for the real session (Cognito + /me, next M0 item). The server remains the
 * authority for every permission; this only decides what the UI shows.
 * Pick a role with NEXT_PUBLIC_DEV_ROLE (e.g. RECEPTIONIST) to preview role-specific navigation.
 */
const envRole = process.env.NEXT_PUBLIC_DEV_ROLE;
const role: Role = isRole(envRole) && envRole !== "PATIENT" ? envRole : "MANAGER";

export const DEV_BRANCHES = [
  { id: "b1", name: "Saket" },
  { id: "b2", name: "Gurugram" },
  { id: "b3", name: "Noida" },
];

export const DEV_PRINCIPAL: Principal = {
  userId: "dev-user",
  tenantId: "00000000-0000-0000-0000-000000000001",
  roles: [role],
  orgWide: role === "OWNER" || role === "ACCOUNTANT",
  branchScope: ["b1"],
};
export const DEV_USER = {
  name: "Asha Verma",
  roleLabel: role.charAt(0) + role.slice(1).toLowerCase(),
};
export { ROLES };
