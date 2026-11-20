/**
 * Browser helpers for the BFF. Tokens never reach JS; the browser talks to same-origin
 * `/api/auth/*` routes with its HttpOnly session cookie, and sends the double-submit CSRF token
 * (readable `dos_csrf` cookie) on state-changing calls.
 */

export const AUTH_ROUTES = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  session: "/api/auth/session",
  /** Same-origin API proxy: point the API client's base URL here in Cognito mode. */
  proxy: "/api/auth/proxy",
} as const;

export const CSRF_HEADER = "X-CSRF-Token";

/** Reads the CSRF cookie (`__Host-dos_csrf` on https, `dos_csrf` on http://localhost). */
export function readCsrfToken(
  cookie: string = typeof document === "undefined" ? "" : document.cookie,
): string | undefined {
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "__Host-dos_csrf" || k === "dos_csrf") return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Headers to add to a same-origin BFF request (`X-CSRF-Token` for unsafe methods). */
export function csrfHeaders(method: string): Record<string, string> {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return {};
  const t = readCsrfToken();
  return t ? { [CSRF_HEADER]: t } : {};
}

const here = () =>
  typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;

export function loginUrl(returnTo = here(), opts: { reauth?: boolean; tenantId?: string } = {}) {
  const q = new URLSearchParams({ returnTo });
  if (opts.reauth) q.set("reauth", "1");
  if (opts.tenantId) q.set("tenantId", opts.tenantId);
  return `${AUTH_ROUTES.login}?${q.toString()}`;
}

/** Full-page navigation to Cognito sign-in. */
export function signIn(returnTo?: string) {
  window.location.assign(loginUrl(returnTo));
}

/**
 * Step-up for `401 { error: "reauth_required" }` (ApiError.needsReauth): forces an interactive
 * sign-in (prompt=login, max_age=0) and returns to `returnTo`, where the user retries the action.
 */
export function reauthenticate(returnTo?: string) {
  window.location.assign(loginUrl(returnTo, { reauth: true }));
}

/** Ends the local session, revokes the refresh token, then ends the Cognito session. */
export async function signOut(): Promise<void> {
  try {
    const r = await fetch(AUTH_ROUTES.logout, {
      method: "POST",
      headers: { Accept: "application/json", ...csrfHeaders("POST") },
      credentials: "same-origin",
    });
    const body = (await r.json().catch(() => ({}))) as { redirect?: string };
    window.location.assign(body.redirect ?? "/sign-in?signed_out=1");
  } catch {
    window.location.assign("/sign-in?signed_out=1");
  }
}

/** Switches the active organisation (membership is verified server-side via GET /me). */
export async function selectTenant(tenantId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(AUTH_ROUTES.session, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders("POST") },
    credentials: "same-origin",
    body: JSON.stringify({ tenantId }),
  });
  if (r.ok) return { ok: true };
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? "unknown" };
}
