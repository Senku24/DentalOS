import { type JWTPayload, type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from "jose";

export interface VerifiedClaims {
  sub: string;
  /** True when the IdP guarantees a second factor was completed for this session. */
  mfa: boolean;
  /** Epoch seconds of the user's last interactive authentication (drives step-up checks). */
  authTime: number;
}

/** Abstraction over the managed IdP (PRD 6.8). DentalOS stays authoritative for membership/roles. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedClaims>;
}

/** Dev/test verifier using a shared HS256 secret. Refused in production by createTokenVerifier(). */
export class DevTokenVerifier implements TokenVerifier {
  constructor(private readonly secret: Uint8Array) {}
  async verify(token: string): Promise<VerifiedClaims> {
    const { payload } = await jwtVerify(token, this.secret, { algorithms: ["HS256"] });
    if (!payload.sub) throw new Error("missing sub");
    return {
      sub: payload.sub,
      mfa: payload.mfa === true,
      authTime: numberClaim(payload, "auth_time") ?? payload.iat ?? 0,
    };
  }
}

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  /** App client id the access token must have been issued to. */
  clientId: string;
  /**
   * The pool must be configured with MFA = ON (Terraform `identity` module does this and exposes it
   * as an output). Cognito access tokens carry no reliable MFA claim, so a token from an
   * MFA-required pool is the evidence. Set false only for pools without mandatory MFA (patients).
   */
  mfaEnforcedByPool: boolean;
  /** Test seam: override the JWKS location / key resolver. */
  jwksUrl?: URL;
  keyResolver?: JWTVerifyGetKey;
}

const numberClaim = (p: JWTPayload, k: string) =>
  typeof p[k] === "number" ? (p[k] as number) : undefined;

/**
 * Verifies Cognito ACCESS tokens (signature via the pool's JWKS, issuer, expiry, token_use, client_id).
 * Fails closed on any error, including JWKS fetch failure. Algorithms are pinned to RS256 so
 * `none`/HS256 key-confusion tokens are rejected.
 */
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly issuer: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly cfg: CognitoConfig) {
    this.issuer = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
    this.keys =
      cfg.keyResolver ??
      createRemoteJWKSet(cfg.jwksUrl ?? new URL(`${this.issuer}/.well-known/jwks.json`), {
        cooldownDuration: 30_000, // do not hammer the JWKS endpoint on bad kids
        timeoutDuration: 3_000,
      });
  }

  async verify(token: string): Promise<VerifiedClaims> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.issuer,
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    if (payload.token_use !== "access") throw new Error("not an access token");
    if (payload.client_id !== this.cfg.clientId) throw new Error("wrong client");
    if (!payload.sub) throw new Error("missing sub");
    const authTime = numberClaim(payload, "auth_time");
    if (authTime === undefined) throw new Error("missing auth_time");
    return { sub: payload.sub, mfa: this.cfg.mfaEnforcedByPool, authTime };
  }
}

export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");

/**
 * Chooses the verifier from the environment. Production must use Cognito: the shared-secret dev
 * verifier is refused there, so a leaked/default secret can never mint production sessions.
 */
export function createTokenVerifier(env: NodeJS.ProcessEnv = process.env): TokenVerifier {
  if (env.COGNITO_USER_POOL_ID) {
    const { AWS_REGION: region, COGNITO_CLIENT_ID: clientId } = env;
    if (!region || !clientId)
      throw new Error("AWS_REGION and COGNITO_CLIENT_ID are required with COGNITO_USER_POOL_ID");
    return new CognitoTokenVerifier({
      region,
      userPoolId: env.COGNITO_USER_POOL_ID,
      clientId,
      mfaEnforcedByPool: env.COGNITO_MFA_ENFORCED !== "false",
    });
  }
  if (env.NODE_ENV === "production")
    throw new Error("COGNITO_USER_POOL_ID is required in production");
  if (!env.DEV_JWT_SECRET)
    throw new Error("Set COGNITO_USER_POOL_ID, or DEV_JWT_SECRET for local development");
  return new DevTokenVerifier(new TextEncoder().encode(env.DEV_JWT_SECRET));
}
