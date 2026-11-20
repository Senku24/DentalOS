import type { AuthConfig } from "./config";
import {
  type CookieOptions,
  chunkedCookies,
  parseCookies,
  readChunked,
  serializeCookie,
} from "./cookies";
import { hmac, seal, unseal } from "./crypto";

/**
 * The server-side session, sealed (AES-256-GCM) into HttpOnly cookies. Tokens never reach browser JS.
 */
export interface Session {
  v: 1;
  /** Random session id; the CSRF token is HMAC(sid). Rotated on every sign-in. */
  sid: string;
  /** Cognito access token (sent to the API as Bearer). */
  at: string;
  /** Cognito refresh token, when issued. */
  rt?: string;
  /** Access token expiry (epoch seconds). */
  exp: number;
  /** Session creation (epoch seconds); the session dies at iat + sessionMaxAge regardless of refresh. */
  iat: number;
  /** Last interactive sign-in (epoch seconds), from the token's auth_time. */
  authTime: number;
  sub: string;
  email?: string;
  name?: string;
  /** Selected organisation (X-Tenant-Id). Membership is verified by the API on every call. */
  tid?: string;
}

/** Short-lived login transaction (state / nonce / PKCE verifier), sealed into its own cookie. */
export interface LoginTx {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  tenantId?: string;
  reauth: boolean;
  /** Epoch seconds the transaction started (reauth freshness check). */
  at: number;
}

const SESSION_PURPOSE = "dentalos.session.v1";
const TX_PURPOSE = "dentalos.login-tx.v1";
export const TX_MAX_AGE = 600;

export const cookieNames = (cfg: Pick<AuthConfig, "secureCookies">) => {
  const p = cfg.secureCookies ? "__Host-" : "";
  return {
    session: `${p}dos_session`,
    tx: `${p}dos_auth_tx`,
    /** Readable by JS on purpose: double-submit CSRF token (useless without the HttpOnly session). */
    csrf: `${p}dos_csrf`,
    /** Last organisation chosen on this browser (not secret; membership is re-checked). */
    tenant: `${p}dos_tenant`,
  };
};

const baseOpts = (cfg: AuthConfig): CookieOptions => ({
  httpOnly: true,
  secure: cfg.secureCookies,
  sameSite: "Lax",
  path: "/",
});

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function readSession(
  req: Request,
  cfg: AuthConfig,
  now = nowSeconds(),
): Promise<Session | null> {
  const cookies = parseCookies(req.headers.get("cookie"));
  return readSessionFrom(cookies, cfg, now);
}

export async function readSessionFrom(
  cookies: Map<string, string>,
  cfg: AuthConfig,
  now = nowSeconds(),
): Promise<Session | null> {
  const raw = readChunked(cookies, cookieNames(cfg).session);
  if (!raw) return null;
  const s = await unseal<Session>(raw, cfg.sessionSecret, SESSION_PURPOSE);
  if (!s || s.v !== 1 || typeof s.at !== "string" || typeof s.sid !== "string") return null;
  if (s.iat + cfg.sessionMaxAge <= now) return null;
  return s;
}

/** Set-Cookie headers persisting `session` (or clearing it when null) plus its CSRF cookie. */
export async function sessionCookies(
  req: Request,
  cfg: AuthConfig,
  session: Session | null,
  now = nowSeconds(),
): Promise<string[]> {
  const names = cookieNames(cfg);
  const present = parseCookies(req.headers.get("cookie"));
  if (!session) {
    return [
      ...chunkedCookies(names.session, null, baseOpts(cfg), present),
      serializeCookie(names.csrf, "", { ...baseOpts(cfg), httpOnly: false, maxAge: 0 }),
    ];
  }
  const maxAge = session.iat + cfg.sessionMaxAge - now;
  const sealed = await seal(session, cfg.sessionSecret, SESSION_PURPOSE);
  return [
    ...chunkedCookies(names.session, sealed, { ...baseOpts(cfg), maxAge }, present),
    serializeCookie(names.csrf, await csrfTokenFor(session, cfg), {
      ...baseOpts(cfg),
      httpOnly: false,
      maxAge,
    }),
  ];
}

export async function csrfTokenFor(session: Session, cfg: AuthConfig): Promise<string> {
  return hmac(`csrf:${session.sid}`, cfg.sessionSecret);
}

export async function txCookie(cfg: AuthConfig, tx: LoginTx | null): Promise<string> {
  const name = cookieNames(cfg).tx;
  // Path-scoped to the auth routes: the transaction is never sent with app requests.
  const o = { ...baseOpts(cfg), path: "/api/auth" };
  // __Host- cookies must use Path=/; keep the prefix semantics valid.
  if (cfg.secureCookies) o.path = "/";
  if (!tx) return serializeCookie(name, "", { ...o, maxAge: 0 });
  return serializeCookie(name, await seal(tx, cfg.sessionSecret, TX_PURPOSE), {
    ...o,
    maxAge: TX_MAX_AGE,
  });
}

export async function readTx(req: Request, cfg: AuthConfig, now = nowSeconds()) {
  const raw = parseCookies(req.headers.get("cookie")).get(cookieNames(cfg).tx);
  if (!raw) return null;
  const tx = await unseal<LoginTx>(raw, cfg.sessionSecret, TX_PURPOSE);
  if (!tx || typeof tx.state !== "string" || now - tx.at > TX_MAX_AGE) return null;
  return tx;
}

export function tenantCookie(cfg: AuthConfig, tenantId: string): string {
  return serializeCookie(cookieNames(cfg).tenant, tenantId, {
    ...baseOpts(cfg),
    maxAge: 365 * 86400,
  });
}
