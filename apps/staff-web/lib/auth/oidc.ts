import type { AuthConfig } from "./config";
import { decodeJwtPayload } from "./crypto";

/**
 * Cognito OAuth 2.0 authorization-code + PKCE (S256) against the user pool's managed login.
 * Endpoints: /oauth2/authorize, /oauth2/token, /oauth2/revoke, /logout.
 */

export interface TokenSet {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export class OidcError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

export function authorizeUrl(
  cfg: AuthConfig,
  p: { state: string; nonce: string; challenge: string; reauth: boolean },
): string {
  const u = new URL(`${cfg.domain}/oauth2/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.reauth) {
    // Step-up: force an interactive sign-in so the new token carries a fresh auth_time.
    u.searchParams.set("prompt", "login");
    u.searchParams.set("max_age", "0");
  }
  return u.toString();
}

export function logoutUrl(cfg: AuthConfig): string {
  const u = new URL(`${cfg.domain}/logout`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("logout_uri", cfg.logoutUri);
  return u.toString();
}

function tokenHeaders(cfg: AuthConfig): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (cfg.clientSecret) {
    const basic = `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`;
    h.Authorization = `Basic ${btoa(basic)}`;
  }
  return h;
}

async function tokenRequest(
  cfg: AuthConfig,
  form: Record<string, string>,
  f: typeof fetch,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await f(`${cfg.domain}/oauth2/token`, {
      method: "POST",
      headers: tokenHeaders(cfg),
      body: new URLSearchParams({ client_id: cfg.clientId, ...form }).toString(),
      cache: "no-store",
    });
  } catch {
    throw new OidcError("idp_unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as Partial<TokenSet> & { error?: string };
  if (!res.ok || typeof body.access_token !== "string") {
    throw new OidcError(body.error === "invalid_grant" ? "invalid_grant" : "token_exchange_failed");
  }
  return body as TokenSet;
}

export const exchangeCode = (cfg: AuthConfig, code: string, verifier: string, f: typeof fetch) =>
  tokenRequest(
    cfg,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
    },
    f,
  );

export const refreshTokens = (cfg: AuthConfig, refreshToken: string, f: typeof fetch) =>
  tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, f);

/** Best effort: revokes the refresh token (and the access tokens issued from it). */
export async function revokeRefreshToken(cfg: AuthConfig, token: string, f: typeof fetch) {
  try {
    await f(`${cfg.domain}/oauth2/revoke`, {
      method: "POST",
      headers: tokenHeaders(cfg),
      body: new URLSearchParams({ token, client_id: cfg.clientId }).toString(),
      cache: "no-store",
    });
  } catch {
    // Signing out locally must not depend on the IdP being reachable.
  }
}

export interface IdClaims {
  sub: string;
  email?: string;
  name?: string;
  authTime: number;
}

/**
 * Validates the ID token's claims: iss, aud, exp, nonce (replay), token_use. The signature is not
 * re-checked here: the token came straight from the token endpoint over TLS in exchange for our
 * code + PKCE verifier (OIDC Core 3.1.3.7 §6 permits TLS server validation in that case), and the
 * API verifies the ACCESS token's signature against the pool JWKS on every call.
 */
export function validateIdToken(
  idToken: string | undefined,
  cfg: AuthConfig,
  nonce: string,
  now: number,
): IdClaims {
  if (!idToken) throw new OidcError("invalid_id_token", "missing id_token");
  const c = decodeJwtPayload(idToken);
  if (!c) throw new OidcError("invalid_id_token", "malformed id_token");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== cfg.issuer) throw new OidcError("invalid_id_token", "issuer");
  if (!aud.includes(cfg.clientId)) throw new OidcError("invalid_id_token", "audience");
  if (typeof c.exp !== "number" || c.exp + 60 < now)
    throw new OidcError("invalid_id_token", "expired");
  if (c.token_use !== undefined && c.token_use !== "id")
    throw new OidcError("invalid_id_token", "token_use");
  if (typeof c.nonce !== "string" || c.nonce !== nonce)
    throw new OidcError("invalid_id_token", "nonce");
  if (typeof c.sub !== "string" || !c.sub) throw new OidcError("invalid_id_token", "sub");
  const authTime = typeof c.auth_time === "number" ? c.auth_time : now;
  const verified = c.email_verified === true || c.email_verified === "true";
  return {
    sub: c.sub,
    authTime,
    ...(typeof c.email === "string" && verified ? { email: c.email.toLowerCase() } : {}),
    ...(typeof c.name === "string" && c.name.trim() ? { name: c.name.trim().slice(0, 120) } : {}),
  };
}

/** Expiry of an access token (epoch seconds) from its payload, or now + expires_in. */
export function accessExpiry(t: TokenSet, now: number): number {
  const exp = decodeJwtPayload(t.access_token)?.exp;
  if (typeof exp === "number") return exp;
  return now + (typeof t.expires_in === "number" ? t.expires_in : 300);
}
