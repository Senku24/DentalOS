import { createHmac } from "node:crypto";
import {
  PORTAL_ACCESS_TOKEN_TTL_SECONDS,
  PORTAL_SELECTION_TTL_SECONDS,
  PORTAL_TOKEN_AUDIENCE,
  PORTAL_TOKEN_ISSUER,
} from "@dentalos/validation";
import { SignJWT, jwtVerify } from "jose";

/**
 * Patient-portal tokens (ADR 0005 §1.3). A portal token can NEVER pass the staff guard and a staff token can never
 * pass the portal guard, by three independent barriers:
 *   1. KEY      portal tokens are signed with their own key (`PORTAL_JWT_SECRET`, or in development derived from
 *               DEV_JWT_SECRET with an HMAC label). The staff verifier checks DEV_JWT_SECRET / Cognito's JWKS.
 *   2. CLAIMS   portal tokens carry iss `dentalos-portal-api`, aud `dentalos-portal` and `typ` portal_access; this
 *               verifier requires all three, the staff `DevTokenVerifier` refuses any token with that audience.
 *   3. ALG      HS256 is pinned here; Cognito staff tokens are RS256 and pinned to RS256 on the staff side.
 * Production note: self-issued portal tokens are the V1 default; a Cognito patient pool can replace `signAccess` /
 * `verifyAccess` without touching callers (the guard only needs tenant, patient, account and session ids).
 */

export interface PortalAccessClaims {
  tenantId: string;
  /** Patient the ACCOUNT was created for (the guard resolves merge survivors itself). */
  patientId: string;
  accountId: string;
  sessionId: string;
  expiresAt: Date;
}

export interface PortalSelectionClaims {
  tenantId: string;
  otpId: string;
  accountIds: string[];
}

export class PortalSecrets {
  constructor(
    /** HS256 key of portal access / selection tokens. */
    readonly jwtKey: Uint8Array,
    /** HMAC pepper of OTP, destination and client-value hashes (`hashOtpCode`, `hashDestination`, `hashClientValue`). */
    readonly pepper: string,
  ) {}
}

const derive = (devSecret: string, label: string) =>
  createHmac("sha256", devSecret).update(label).digest();

/**
 * Production: PORTAL_JWT_SECRET and PORTAL_OTP_PEPPER are required (>= 32 chars each, different from DEV_JWT_SECRET).
 * Development: derived from DEV_JWT_SECRET so a local `.env` needs no extra values.
 */
export function createPortalSecrets(env: NodeJS.ProcessEnv = process.env): PortalSecrets {
  const prod = env.NODE_ENV === "production";
  const dev = env.DEV_JWT_SECRET;
  const jwt = env.PORTAL_JWT_SECRET;
  const pepper = env.PORTAL_OTP_PEPPER;
  if (prod && (!jwt || !pepper))
    throw new Error("PORTAL_JWT_SECRET and PORTAL_OTP_PEPPER are required in production");
  if (!prod && !dev && (!jwt || !pepper))
    throw new Error(
      "Set DEV_JWT_SECRET (or PORTAL_JWT_SECRET and PORTAL_OTP_PEPPER) for the portal",
    );
  for (const [name, v] of [
    ["PORTAL_JWT_SECRET", jwt],
    ["PORTAL_OTP_PEPPER", pepper],
  ] as const)
    if (v !== undefined && v.length < 32) throw new Error(`${name} must be at least 32 characters`);
  if (jwt && dev && jwt === dev)
    throw new Error(
      "PORTAL_JWT_SECRET must differ from DEV_JWT_SECRET (staff and portal tokens must not mix)",
    );
  return new PortalSecrets(
    jwt ? new TextEncoder().encode(jwt) : derive(dev as string, "dentalos:portal:jwt:v1"),
    pepper ?? derive(dev as string, "dentalos:portal:otp-pepper:v1").toString("hex"),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string => {
  if (typeof v !== "string" || !UUID.test(v)) throw new Error("bad claim");
  return v.toLowerCase();
};

export const PORTAL_TOKEN_SERVICE = Symbol("PORTAL_TOKEN_SERVICE");
/** Injects `PortalSecrets | null` (null = portal secrets are not configured: portal routes fail closed, staff API is unaffected). */
export const PORTAL_SECRETS = Symbol("PORTAL_SECRETS");

/** Like `createPortalSecrets` but returns null (after calling `onProblem`) instead of throwing, so a missing portal secret never stops the staff API from booting. */
export function createPortalSecretsOrNull(
  env: NodeJS.ProcessEnv = process.env,
  onProblem: (message: string) => void = () => {},
): PortalSecrets | null {
  try {
    return createPortalSecrets(env);
  } catch (e) {
    onProblem(e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** For services that hash OTPs / client values: the secrets or a 503-worthy error. */
export function requirePortalSecrets(secrets: PortalSecrets | null): PortalSecrets {
  if (!secrets) throw new Error("patient portal secrets are not configured");
  return secrets;
}

/** Signs and verifies portal access tokens (short-lived) and picker selection tokens. */
export class PortalTokenService {
  constructor(private readonly secretsOrNull: PortalSecrets | null) {}

  private get secrets(): PortalSecrets {
    return requirePortalSecrets(this.secretsOrNull);
  }

  /** Signed access token for a session; `ttlSeconds` defaults to 15 minutes. */
  async signAccess(
    c: Omit<PortalAccessClaims, "expiresAt">,
    ttlSeconds = PORTAL_ACCESS_TOKEN_TTL_SECONDS,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
    const token = await new SignJWT({
      typ: "portal_access",
      tid: c.tenantId,
      pid: c.patientId,
      aid: c.accountId,
      sid: c.sessionId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(PORTAL_TOKEN_ISSUER)
      .setAudience(PORTAL_TOKEN_AUDIENCE)
      .setSubject(`portal-account:${c.accountId}`)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(exp)
      .sign(this.secrets.jwtKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /** Throws on any defect (signature, alg, iss, aud, typ, expiry, claim shape). */
  async verifyAccess(token: string): Promise<PortalAccessClaims> {
    const { payload } = await jwtVerify(token, this.secrets.jwtKey, {
      algorithms: ["HS256"],
      issuer: PORTAL_TOKEN_ISSUER,
      audience: PORTAL_TOKEN_AUDIENCE,
      clockTolerance: 5,
    });
    if (payload.typ !== "portal_access") throw new Error("not a portal access token");
    return {
      tenantId: uuid(payload.tid),
      patientId: uuid(payload.pid),
      accountId: uuid(payload.aid),
      sessionId: uuid(payload.sid),
      expiresAt: new Date((payload.exp as number) * 1000),
    };
  }

  /** Short-lived proof that ONE verified OTP matched these accounts (the "which patient are you?" picker). */
  async signSelection(c: PortalSelectionClaims, now = new Date()): Promise<string> {
    return new SignJWT({ typ: "portal_select", tid: c.tenantId, oid: c.otpId, aids: c.accountIds })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(PORTAL_TOKEN_ISSUER)
      .setAudience(PORTAL_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + PORTAL_SELECTION_TTL_SECONDS)
      .sign(this.secrets.jwtKey);
  }

  async verifySelection(token: string): Promise<PortalSelectionClaims> {
    const { payload } = await jwtVerify(token, this.secrets.jwtKey, {
      algorithms: ["HS256"],
      issuer: PORTAL_TOKEN_ISSUER,
      audience: PORTAL_TOKEN_AUDIENCE,
      clockTolerance: 5,
    });
    if (payload.typ !== "portal_select" || !Array.isArray(payload.aids))
      throw new Error("not a selection token");
    return {
      tenantId: uuid(payload.tid),
      otpId: uuid(payload.oid),
      accountIds: payload.aids.map(uuid),
    };
  }
}
