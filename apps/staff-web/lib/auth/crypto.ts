/**
 * WebCrypto-only primitives (run unchanged in the Edge middleware, Node route handlers and bun test).
 * Session cookies are sealed with AES-256-GCM; CSRF tokens are HMAC-SHA-256. Both keys are derived
 * from SESSION_SECRET with HKDF using distinct `info` labels, so one secret never serves two purposes.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** URL-safe random string with `bytes` of entropy (state, nonce, PKCE verifier, session id). */
export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 S256 code challenge. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

/** Constant-time string comparison (length is not secret here: tokens have fixed lengths). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface Keys {
  aes: CryptoKey;
  hmac: CryptoKey;
}
const keyCache = new Map<string, Promise<Keys>>();

async function deriveKeys(secret: string): Promise<Keys> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  const salt = enc.encode("dentalos-staff-web");
  const aes = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("session-cookie-v1") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const hmac = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("csrf-v1") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  return { aes, hmac };
}

const keys = (secret: string) => {
  let k = keyCache.get(secret);
  if (!k) {
    k = deriveKeys(secret);
    keyCache.set(secret, k);
  }
  return k;
};

/**
 * Encrypts + authenticates a JSON value. `purpose` is bound as AAD so a sealed login transaction can
 * never be replayed as a session cookie (or vice versa).
 */
export async function seal(value: unknown, secret: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(purpose) },
    (await keys(secret)).aes,
    enc.encode(JSON.stringify(value)),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return b64urlEncode(out);
}

/** Inverse of `seal`; `null` for anything tampered, truncated, foreign-keyed or mis-purposed. */
export async function unseal<T>(token: string, secret: string, purpose: string): Promise<T | null> {
  try {
    const raw = b64urlDecode(token);
    if (raw.length < 13 + 16) return null;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(purpose) },
      (await keys(secret)).aes,
      raw.slice(12),
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

export async function hmac(data: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", (await keys(secret)).hmac, enc.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

/** Decodes a JWT payload WITHOUT verifying it (see oidc.ts for when that is acceptable). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const v = JSON.parse(dec.decode(b64urlDecode(part)));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
