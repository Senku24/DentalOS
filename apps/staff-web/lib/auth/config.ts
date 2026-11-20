/**
 * Server-side auth configuration (never imported by client components: it reads secrets).
 *
 * Cognito mode is on when COGNITO_DOMAIN is set; the rest of the variables are then REQUIRED and a
 * missing one throws (a half-configured deployment must fail loudly, never fall back to the DEV
 * principal). Without COGNITO_DOMAIN the app runs in dev mode: no sign-in, DEV principal, mock data.
 * Dev mode FAILS CLOSED in production builds: with NODE_ENV=production and no COGNITO_DOMAIN this
 * throws unless DENTALOS_AUTH_MODE=dev opts in explicitly (local `next build && next start` smoke
 * tests). A production deployment that drops or misspells COGNITO_DOMAIN therefore answers
 * 500 auth_misconfigured instead of letting everyone in as the DEV principal.
 * Variables are documented in apps/staff-web/README.md.
 */

export interface AuthConfig {
  /** Cognito Hosted UI / managed login origin, e.g. https://dentalos-staging-staff.auth.ap-south-1.amazoncognito.com */
  domain: string;
  clientId: string;
  /** Confidential app client (Terraform `generate_secret = true`); sent as HTTP Basic to /oauth2/token. */
  clientSecret?: string;
  /** Expected `iss` of ID tokens: https://cognito-idp.<region>.amazonaws.com/<poolId> */
  issuer: string;
  scopes: string;
  /** Public origin of staff-web (redirect URIs are built from it, never from the Host header). */
  appUrl: string;
  redirectUri: string;
  logoutUri: string;
  /** API base the BFF calls server-side (internal URL allowed). */
  apiUrl: string;
  sessionSecret: string;
  /** Absolute session lifetime in seconds (default 12 h = Cognito staff refresh-token validity). */
  sessionMaxAge: number;
  /** Used when the user signs in without choosing an organisation and has none remembered. */
  defaultTenantId?: string;
  /** Secure + __Host- cookies (true unless APP_URL is plain http, i.e. local development). */
  secureCookies: boolean;
}

export type Env = Record<string, string | undefined>;

const trimSlash = (s: string) => s.replace(/\/+$/, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpUrl(name: string, v: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new Error(`${name} must use https (http is allowed for localhost only)`);
  return trimSlash(u.toString());
}

/** Opt-in that allows dev mode under NODE_ENV=production (never set it in a deployed environment). */
export const DEV_MODE_OPT_IN = "DENTALOS_AUTH_MODE";

/**
 * `null` = dev mode. Throws on partial/invalid Cognito configuration, and on a production build
 * without Cognito configuration unless `DENTALOS_AUTH_MODE=dev`.
 */
export function readAuthConfig(env: Env = process.env): AuthConfig | null {
  const rawDomain = env.COGNITO_DOMAIN?.trim();
  const mode = env[DEV_MODE_OPT_IN]?.trim().toLowerCase();
  if (!rawDomain) {
    if (env.NODE_ENV === "production" && mode !== "dev")
      throw new Error(
        `Cognito sign-in is misconfigured: COGNITO_DOMAIN is unset in a production build (set ${DEV_MODE_OPT_IN}=dev only for local smoke tests)`,
      );
    return null;
  }
  if (mode === "dev")
    throw new Error(
      `Cognito sign-in is misconfigured: ${DEV_MODE_OPT_IN}=dev conflicts with COGNITO_DOMAIN`,
    );
  const missing = ["COGNITO_CLIENT_ID", "APP_URL", "SESSION_SECRET"].filter((k) => !env[k]?.trim());
  const apiRaw = env.API_URL?.trim() || env.NEXT_PUBLIC_API_URL?.trim();
  if (!apiRaw) missing.push("API_URL");
  let issuer = env.COGNITO_ISSUER?.trim();
  if (!issuer) {
    const pool = env.COGNITO_USER_POOL_ID?.trim();
    const region = env.COGNITO_REGION?.trim() || env.AWS_REGION?.trim();
    if (pool && region) issuer = `https://cognito-idp.${region}.amazonaws.com/${pool}`;
    else missing.push("COGNITO_ISSUER (or COGNITO_USER_POOL_ID + COGNITO_REGION)");
  }
  if (missing.length)
    throw new Error(`Cognito sign-in is misconfigured: set ${missing.join(", ")}`);

  const sessionSecret = env.SESSION_SECRET as string;
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const domain = httpUrl(
    "COGNITO_DOMAIN",
    /^https?:\/\//.test(rawDomain) ? rawDomain : `https://${rawDomain}`,
  );
  const appUrl = new URL(httpUrl("APP_URL", env.APP_URL as string)).origin;
  const maxAge = Number(env.SESSION_MAX_AGE ?? 12 * 3600);
  const defaultTenantId = env.DEFAULT_TENANT_ID?.trim() || undefined;
  if (defaultTenantId && !UUID.test(defaultTenantId))
    throw new Error("DEFAULT_TENANT_ID must be a UUID");
  return {
    domain,
    clientId: (env.COGNITO_CLIENT_ID as string).trim(),
    clientSecret: env.COGNITO_CLIENT_SECRET?.trim() || undefined,
    issuer: trimSlash(issuer as string),
    scopes: env.COGNITO_SCOPES?.trim() || "openid email profile",
    appUrl,
    redirectUri: `${appUrl}/api/auth/callback`,
    logoutUri: env.COGNITO_LOGOUT_URI?.trim()
      ? httpUrl("COGNITO_LOGOUT_URI", env.COGNITO_LOGOUT_URI.trim())
      : `${appUrl}/sign-in?signed_out=1`,
    apiUrl: httpUrlOrInternal(apiRaw as string),
    sessionSecret,
    sessionMaxAge: Number.isFinite(maxAge) && maxAge >= 300 ? Math.floor(maxAge) : 12 * 3600,
    defaultTenantId,
    secureCookies: appUrl.startsWith("https://"),
  };
}

/** The API may be reached over an internal http address (e.g. service discovery inside the VPC). */
function httpUrlOrInternal(v: string): string {
  const u = new URL(v);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("API_URL must be http(s)");
  return trimSlash(u.toString());
}

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

let cached: { env: Env; value: AuthConfig | null } | undefined;
/** Memoised `readAuthConfig(process.env)` for route handlers and middleware. */
export function authConfig(): AuthConfig | null {
  if (!cached || cached.env !== process.env) cached = { env: process.env, value: readAuthConfig() };
  return cached.value;
}
