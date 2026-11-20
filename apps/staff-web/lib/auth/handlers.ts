import { DEV_PRINCIPAL, DEV_USER, fetchPrincipal } from "../session";
import { type AuthConfig, isUuid } from "./config";
import { parseCookies } from "./cookies";
import { decodeJwtPayload, pkceChallenge, randomToken, safeEqual } from "./crypto";
import {
  OidcError,
  accessExpiry,
  authorizeUrl,
  exchangeCode,
  logoutUrl,
  refreshTokens,
  revokeRefreshToken,
  validateIdToken,
} from "./oidc";
import { safeReturnTo } from "./return-to";
import {
  type Session,
  cookieNames,
  csrfTokenFor,
  nowSeconds,
  readSession,
  readTx,
  sessionCookies,
  tenantCookie,
  txCookie,
} from "./session-store";

/**
 * BFF route logic on plain Web Request/Response (the Next route files are one-line adapters), so the
 * whole flow is unit-testable without a Next server. All responses are `Cache-Control: no-store`.
 */

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
}
export const defaultDeps = (): Deps => ({ fetch: globalThis.fetch, now: nowSeconds });

/** Refresh the access token when it has less than this many seconds left. */
const REFRESH_LEEWAY = 60;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-csrf-token";

/** Error codes the sign-in page knows how to explain (never reflect IdP-provided text). */
export const SIGN_IN_ERRORS = [
  "access_denied",
  "idp_error",
  "login_expired",
  "state_mismatch",
  "invalid_request",
  "token_exchange_failed",
  "invalid_id_token",
  "reauth_failed",
  "idp_unreachable",
] as const;
export type SignInError = (typeof SIGN_IN_ERRORS)[number];

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const h = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers: h });
}

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const h = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status, headers: h });
}

// ------------------------------------------------------------------------------------- CSRF

/**
 * Two independent checks for every state-changing BFF call:
 *  1. Origin (or, if absent, Sec-Fetch-Site) must be our own origin — blocks cross-site forms/fetch.
 *  2. Signed double-submit token: `X-CSRF-Token` (or a `csrf` form field) must equal HMAC(session id),
 *     which only our origin can read from the `dos_csrf` cookie.
 * The session cookie is also SameSite=Lax, so it is not even sent on cross-site POSTs.
 */
export async function verifyCsrf(
  req: Request,
  cfg: AuthConfig,
  session: Session,
  formToken?: string,
): Promise<boolean> {
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin !== cfg.appUrl) return false;
  } else if (req.headers.get("sec-fetch-site") !== "same-origin") {
    return false;
  }
  const token = req.headers.get(CSRF_HEADER) ?? formToken ?? "";
  return safeEqual(token, await csrfTokenFor(session, cfg));
}

// ------------------------------------------------------------------------------------- refresh

type Fresh = { ok: true; session: Session; changed: boolean } | { ok: false };

export async function ensureFresh(session: Session, cfg: AuthConfig, deps: Deps): Promise<Fresh> {
  const now = deps.now();
  if (session.exp - now > REFRESH_LEEWAY) return { ok: true, session, changed: false };
  if (!session.rt) return session.exp > now ? { ok: true, session, changed: false } : { ok: false };
  try {
    const t = await refreshTokens(cfg, session.rt, deps.fetch);
    const sub = decodeJwtPayload(t.access_token)?.sub;
    if (sub !== session.sub) return { ok: false };
    return {
      ok: true,
      changed: true,
      session: {
        ...session,
        at: t.access_token,
        exp: accessExpiry(t, now),
        // Cognito only returns a new refresh token when rotation is enabled.
        rt: t.refresh_token ?? session.rt,
      },
    };
  } catch (e) {
    // IdP down: keep using a still-valid token rather than signing the user out.
    if (e instanceof OidcError && e.code === "idp_unreachable" && session.exp > now)
      return { ok: true, session, changed: false };
    return { ok: false };
  }
}

// ------------------------------------------------------------------------------------- login

/**
 * GET /api/auth/login?returnTo=&tenantId=&reauth=1 → 302 to Cognito with state, nonce and an S256
 * PKCE challenge; the verifier, state and nonce live only in the sealed transaction cookie.
 */
export async function handleLogin(req: Request, cfg: AuthConfig, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const reauth = url.searchParams.get("reauth") === "1";
  const cookies = parseCookies(req.headers.get("cookie"));
  const current = await readSession(req, cfg, deps.now());
  const asked = url.searchParams.get("tenantId");
  const remembered = cookies.get(cookieNames(cfg).tenant);
  const tenantId = [asked, current?.tid, remembered, cfg.defaultTenantId].find(isUuid);
  const verifier = randomToken(48);
  const tx = {
    state: randomToken(),
    nonce: randomToken(),
    verifier,
    returnTo,
    tenantId,
    reauth,
    at: deps.now(),
  };
  const location = authorizeUrl(cfg, {
    state: tx.state,
    nonce: tx.nonce,
    challenge: await pkceChallenge(verifier),
    reauth,
  });
  return redirect(location, [await txCookie(cfg, tx)]);
}

// ------------------------------------------------------------------------------------- callback

/** GET /api/auth/callback?code&state — validates, exchanges, starts a fresh session. */
export async function handleCallback(req: Request, cfg: AuthConfig, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const now = deps.now();
  const clearTx = await txCookie(cfg, null);
  const fail = (code: SignInError) => redirect(`${cfg.appUrl}/sign-in?error=${code}`, [clearTx]);

  const tx = await readTx(req, cfg, now);
  const idpError = url.searchParams.get("error");
  if (idpError) return fail(idpError === "access_denied" ? "access_denied" : "idp_error");
  if (!tx) return fail("login_expired");
  const state = url.searchParams.get("state") ?? "";
  if (!safeEqual(state, tx.state)) return fail("state_mismatch");
  const code = url.searchParams.get("code");
  if (!code) return fail("invalid_request");

  let session: Session;
  try {
    const t = await exchangeCode(cfg, code, tx.verifier, deps.fetch);
    const id = validateIdToken(t.id_token, cfg, tx.nonce, now);
    const access = decodeJwtPayload(t.access_token);
    if (!access || access.sub !== id.sub) throw new OidcError("invalid_id_token", "sub mismatch");
    const authTime = typeof access.auth_time === "number" ? access.auth_time : id.authTime;
    // Step-up: the IdP must have re-authenticated the user after this transaction started.
    if (tx.reauth && authTime < tx.at - 5) return fail("reauth_failed");
    session = {
      v: 1,
      sid: randomToken(),
      at: t.access_token,
      ...(t.refresh_token ? { rt: t.refresh_token } : {}),
      exp: accessExpiry(t, now),
      iat: now,
      authTime,
      sub: id.sub,
      ...(id.email ? { email: id.email } : {}),
      ...(id.name ? { name: id.name } : {}),
      ...(tx.tenantId ? { tid: tx.tenantId } : {}),
    };
  } catch (e) {
    const c = e instanceof OidcError ? e.code : "token_exchange_failed";
    return fail(
      (SIGN_IN_ERRORS as readonly string[]).includes(c)
        ? (c as SignInError)
        : "token_exchange_failed",
    );
  }
  const target = session.tid
    ? tx.returnTo
    : `/select-organisation?returnTo=${encodeURIComponent(tx.returnTo)}`;
  const cookies = [clearTx, ...(await sessionCookies(req, cfg, session, now))];
  if (session.tid) cookies.push(tenantCookie(cfg, session.tid));
  return redirect(`${cfg.appUrl}${target}`, cookies);
}

// ------------------------------------------------------------------------------------- logout

/**
 * POST /api/auth/logout (CSRF-checked). Clears the session, revokes the refresh token (best effort)
 * and sends the browser to Cognito's /logout so the IdP session ends too. JSON callers get
 * `{ redirect }`; form posts get a 303.
 */
export async function handleLogout(req: Request, cfg: AuthConfig, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const session = await readSession(req, cfg, deps.now());
  if (session) {
    let formToken: string | undefined;
    if ((req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
      formToken = new URLSearchParams(await req.text()).get("csrf") ?? undefined;
    }
    if (!(await verifyCsrf(req, cfg, session, formToken)))
      return json({ error: "csrf_failed" }, 403);
    if (session.rt) await revokeRefreshToken(cfg, session.rt, deps.fetch);
  }
  const cookies = [...(await sessionCookies(req, cfg, null)), await txCookie(cfg, null)];
  const target = logoutUrl(cfg);
  if ((req.headers.get("accept") ?? "").includes("application/json"))
    return json({ redirect: target }, 200, cookies);
  return redirect(target, cookies, 303);
}

// ------------------------------------------------------------------------------------- session

export type SessionResponse =
  | {
      mode: "dev";
      authenticated: true;
      principal: typeof DEV_PRINCIPAL;
      user: { name: string; email?: string };
    }
  | {
      mode: "cognito";
      authenticated: false;
      error?: "session_expired";
    }
  | {
      mode: "cognito";
      authenticated: true;
      principal: typeof DEV_PRINCIPAL | null;
      needsTenant: boolean;
      error?: "not_a_member" | "api_unavailable";
      user: { name: string; email?: string };
      tenantId: string | null;
      csrfToken: string;
      authTime: number;
      expiresAt: number;
    };

export const devSession = (): SessionResponse => ({
  mode: "dev",
  authenticated: true,
  principal: DEV_PRINCIPAL,
  user: { name: DEV_USER.name },
});

/** GET /api/auth/session — who am I (principal from the API's GET /me, via the access token). */
export async function handleSessionGet(
  req: Request,
  cfg: AuthConfig,
  deps: Deps,
): Promise<Response> {
  const session = await readSession(req, cfg, deps.now());
  if (!session) return json({ mode: "cognito", authenticated: false } satisfies SessionResponse);
  const fresh = await ensureFresh(session, cfg, deps);
  if (!fresh.ok) {
    return json(
      { mode: "cognito", authenticated: false, error: "session_expired" } satisfies SessionResponse,
      200,
      await sessionCookies(req, cfg, null),
    );
  }
  const s = fresh.session;
  const cookies = fresh.changed ? await sessionCookies(req, cfg, s, deps.now()) : [];
  let principal: typeof DEV_PRINCIPAL | null = null;
  let error: "not_a_member" | "api_unavailable" | undefined;
  if (s.tid) {
    const r = await fetchPrincipal(cfg.apiUrl, s.at, s.tid, deps.fetch);
    if (r.ok) principal = r.principal;
    else if (r.status === 401) {
      return json(
        {
          mode: "cognito",
          authenticated: false,
          error: "session_expired",
        } satisfies SessionResponse,
        200,
        await sessionCookies(req, cfg, null),
      );
    } else error = r.status === 403 ? "not_a_member" : "api_unavailable";
  }
  const body: SessionResponse = {
    mode: "cognito",
    authenticated: true,
    principal,
    needsTenant: !s.tid || error === "not_a_member",
    ...(error ? { error } : {}),
    user: { name: s.name ?? s.email ?? "Signed-in user", ...(s.email ? { email: s.email } : {}) },
    tenantId: s.tid ?? null,
    csrfToken: await csrfTokenFor(s, cfg),
    authTime: s.authTime,
    expiresAt: s.iat + cfg.sessionMaxAge,
  };
  return json(body, 200, cookies);
}

/** POST /api/auth/session { tenantId } — switch organisation (membership verified via GET /me). */
export async function handleSessionPost(
  req: Request,
  cfg: AuthConfig,
  deps: Deps,
): Promise<Response> {
  const session = await readSession(req, cfg, deps.now());
  if (!session) return json({ error: "unauthenticated" }, 401);
  if (!(await verifyCsrf(req, cfg, session))) return json({ error: "csrf_failed" }, 403);
  const body = (await req.json().catch(() => null)) as { tenantId?: unknown } | null;
  if (!isUuid(body?.tenantId)) return json({ error: "validation_failed" }, 400);
  const fresh = await ensureFresh(session, cfg, deps);
  if (!fresh.ok)
    return json({ error: "session_expired" }, 401, await sessionCookies(req, cfg, null));
  const r = await fetchPrincipal(cfg.apiUrl, fresh.session.at, body.tenantId, deps.fetch);
  if (!r.ok) {
    const status = r.status === 401 || r.status === 403 ? r.status : 502;
    return json(
      {
        error:
          status === 403 ? "not_a_member" : status === 401 ? "session_expired" : "api_unavailable",
      },
      status,
    );
  }
  const next: Session = { ...fresh.session, tid: body.tenantId };
  return json({ principal: r.principal }, 200, [
    ...(await sessionCookies(req, cfg, next, deps.now())),
    tenantCookie(cfg, body.tenantId),
  ]);
}

// ------------------------------------------------------------------------------------- proxy

export const PROXY_PREFIX = "/api/auth/proxy";
const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "traceparent", "x-request-id"];
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "content-disposition",
  "etag",
  "last-modified",
  "retry-after",
  "x-request-id",
];

/** Maps `/api/auth/proxy/<path>?<query>` onto the API; `null` for traversal / foreign targets. */
export function upstreamUrl(reqUrl: string, apiUrl: string): URL | null {
  const u = new URL(reqUrl);
  if (!u.pathname.startsWith(`${PROXY_PREFIX}/`)) return null;
  const rest = u.pathname.slice(PROXY_PREFIX.length);
  const segments = rest.split("/").slice(1);
  for (const seg of segments) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (d === "." || d === ".." || d.includes("\\") || seg === "") return null;
  }
  const base = new URL(`${apiUrl}/`);
  const target = new URL(base.pathname.replace(/\/$/, "") + rest + u.search, base.origin);
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(base.pathname.replace(/\/$/, ""))
  )
    return null;
  return target;
}

/**
 * Same-origin API proxy: the browser never holds a token. Adds `Authorization: Bearer <access>` and
 * `X-Tenant-Id: <selected org>`, refreshes the access token when close to expiry, CSRF-checks
 * state-changing methods and streams the upstream body back (works for SSE `/events`).
 */
export async function handleProxy(req: Request, cfg: AuthConfig, deps: Deps): Promise<Response> {
  const session = await readSession(req, cfg, deps.now());
  if (!session) return json({ error: "unauthenticated" }, 401);
  if (UNSAFE.has(req.method) && !(await verifyCsrf(req, cfg, session)))
    return json({ error: "csrf_failed" }, 403);
  const target = upstreamUrl(req.url, cfg.apiUrl);
  if (!target) return json({ error: "bad_path" }, 400);
  const fresh = await ensureFresh(session, cfg, deps);
  if (!fresh.ok)
    return json({ error: "session_expired" }, 401, await sessionCookies(req, cfg, null));
  const s = fresh.session;

  const headers = new Headers({ Authorization: `Bearer ${s.at}` });
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (s.tid) headers.set("X-Tenant-Id", s.tid);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  let upstream: Response;
  try {
    upstream = await deps.fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: req.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    return json({ error: "upstream_unreachable" }, 502);
  }
  const out = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has("cache-control")) out.set("Cache-Control", "no-store");
  if (fresh.changed)
    for (const c of await sessionCookies(req, cfg, s, deps.now())) out.append("Set-Cookie", c);
  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}
