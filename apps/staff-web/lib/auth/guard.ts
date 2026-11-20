import type { AuthConfig } from "./config";
import { safeReturnTo } from "./return-to";
import { readSessionFrom } from "./session-store";

/**
 * Middleware decision for one request (pure; middleware.ts maps it to NextResponse).
 * Dev mode lets everything through. In Cognito mode every app page and API route needs a live
 * session; the auth routes and the sign-in page are public. Expired ACCESS tokens are fine here:
 * the BFF refreshes them; only the absolute session lifetime is enforced.
 */
export type GuardDecision =
  | { type: "next" }
  | { type: "redirect"; location: string }
  | { type: "unauthorized" };

/** Exact paths or `<path>/…` sub-paths (so "/sign-income" is NOT public). */
const PUBLIC_PATHS = ["/api/auth", "/sign-in"];

export async function guardRequest(
  url: URL,
  cookies: Map<string, string>,
  cfg: AuthConfig | null,
  now?: number,
): Promise<GuardDecision> {
  if (!cfg) return { type: "next" };
  const path = url.pathname;
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return { type: "next" };
  if (await readSessionFrom(cookies, cfg, now)) return { type: "next" };
  if (path === "/api" || path.startsWith("/api/")) return { type: "unauthorized" };
  const returnTo = safeReturnTo(`${path}${url.search}`);
  return {
    type: "redirect",
    location: `${cfg.appUrl}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  };
}

/**
 * Decision when the auth configuration is invalid (readAuthConfig threw): fail closed. API routes
 * answer 500 auth_misconfigured; pages go to /sign-in, which renders the "misconfigured" notice.
 * The auth routes handle the error themselves (route.ts withAuth answers 500).
 */
export function guardMisconfigured(url: URL): GuardDecision | { type: "misconfigured" } {
  const path = url.pathname;
  if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return { type: "next" };
  if (path === "/api" || path.startsWith("/api/")) return { type: "misconfigured" };
  return { type: "redirect", location: new URL("/sign-in", url).toString() };
}
