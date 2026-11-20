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
 * Session principal for the UI. The server remains the authority for every permission; this only
 * decides what the UI shows.
 *
 * - Cognito mode (COGNITO_DOMAIN set, see README): the BFF (`/api/auth/*`, lib/auth) keeps the tokens
 *   server-side and resolves the principal with `fetchPrincipal` (API `GET /me` + access token);
 *   `<SessionProvider>` (lib/auth/session-provider.tsx) installs it with `setSessionPrincipal`.
 * - Dev mode (no Cognito env): the DEV principal below. Pick a role with NEXT_PUBLIC_DEV_ROLE
 *   (e.g. OWNER, RECEPTIONIST) to preview role-specific screens. Branch ids match the mock fixtures
 *   so mock mode and the switcher agree.
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

let current: Principal = DEV_PRINCIPAL;

/** The principal display checks use: the signed-in one once installed, else the DEV principal. */
export const sessionPrincipal = (): Principal => current;

/** Installed by `<SessionProvider>` after `/api/auth/session` resolves (null restores DEV). */
export function setSessionPrincipal(p: Principal | null): void {
  current = p ?? DEV_PRINCIPAL;
}

/** Display-only permission check against the session principal. Never a security boundary. */
export const canDo = (perm: Permission, resource?: Resource) => can(current, perm, resource);

/** Active branches the principal may act in (all active ones when orgWide). Used to default forms. */
export const scopedBranchIds = (all: { id: string; active?: boolean }[]) =>
  all
    .filter((b) => b.active !== false)
    .map((b) => b.id)
    .filter((id) => current.orgWide || current.branchScope.includes(id));

/** Narrows an untrusted `GET /me` body to a Principal (staff roles only). */
export function parsePrincipal(v: unknown): Principal | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const strings = (a: unknown): a is string[] =>
    Array.isArray(a) && a.every((x) => typeof x === "string");
  if (typeof o.userId !== "string" || !o.userId) return null;
  if (typeof o.tenantId !== "string" || !o.tenantId) return null;
  if (typeof o.orgWide !== "boolean" || !strings(o.branchScope) || !strings(o.roles)) return null;
  if (!o.roles.every((r) => isRole(r) && r !== "PATIENT")) return null;
  return {
    userId: o.userId,
    tenantId: o.tenantId,
    roles: o.roles as Role[],
    orgWide: o.orgWide,
    branchScope: o.branchScope,
  };
}

export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: number; code?: string };

/**
 * Resolves the principal from the API (`GET /me`) with the user's access token and selected tenant.
 * Server-side only in practice (the BFF holds the token); kept here so the session model lives in one
 * module. 401 = token rejected / step-up, 403 = not a member of that tenant (or MFA missing).
 */
export async function fetchPrincipal(
  apiUrl: string,
  accessToken: string,
  tenantId: string,
  f: typeof fetch = fetch,
): Promise<PrincipalResult> {
  let res: Response;
  try {
    res = await f(`${apiUrl.replace(/\/+$/, "")}/me`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-Tenant-Id": tenantId,
      },
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 502, code: "api_unavailable" };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body && typeof body.error === "string" ? body.error : undefined;
    return { ok: false, status: res.status, ...(code ? { code } : {}) };
  }
  const principal = parsePrincipal(body);
  // A removed member keeps a row with no roles: treat as not a member (403).
  if (!principal || principal.roles.length === 0)
    return { ok: false, status: principal ? 403 : 502 };
  return { ok: true, principal };
}

/** Human label for a staff user id. The membership API returns ids only (see Flags). */
export const userLabel = (userId: string) => STAFF_DIRECTORY[userId]?.name ?? userId;
export const userEmail = (userId: string) => STAFF_DIRECTORY[userId]?.email;

export { ROLES };
