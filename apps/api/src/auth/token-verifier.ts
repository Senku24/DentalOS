import { jwtVerify } from "jose";

/** Abstraction over the managed IdP (provider not yet selected, PRD 6.8). */
export interface TokenVerifier {
  verify(token: string): Promise<{ sub: string; mfa: boolean }>;
}

/** Dev/test verifier using a shared HS256 secret. Replace with the IdP's JWKS verifier. */
export class DevTokenVerifier implements TokenVerifier {
  constructor(private readonly secret: Uint8Array) {}
  async verify(token: string) {
    const { payload } = await jwtVerify(token, this.secret, { algorithms: ["HS256"] });
    if (!payload.sub) throw new Error("missing sub");
    return { sub: payload.sub, mfa: payload.mfa === true };
  }
}

export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");
