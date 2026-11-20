/**
 * Minimal cookie helpers on plain Web `Request`/`Headers` (no next/headers), so handlers are testable.
 * The session value can exceed the ~4 KB per-cookie limit (Cognito access + refresh tokens), so it is
 * split into numbered chunks: `<name>.0`, `<name>.1`, …
 */

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict";
  path?: string;
  /** Seconds; 0 deletes. */
  maxAge?: number;
}

const CHUNK = 3800;
const MAX_CHUNKS = 5;

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || out.has(k)) continue;
    const v = part.slice(i + 1).trim();
    try {
      out.set(k, decodeURIComponent(v));
    } catch {
      out.set(k, v);
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/"}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAge))}`);
  if (o.maxAge === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (o.httpOnly !== false) parts.push("HttpOnly");
  if (o.secure) parts.push("Secure");
  parts.push(`SameSite=${o.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** Reassembles a chunked value; `undefined` when absent or a chunk is missing. */
export function readChunked(cookies: Map<string, string>, name: string): string | undefined {
  let out = "";
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const v = cookies.get(`${name}.${i}`);
    if (v === undefined) break;
    out += v;
  }
  return out || undefined;
}

/**
 * Set-Cookie values writing `value` as chunks and deleting every higher-numbered chunk the browser
 * may hold. `value: null` deletes every chunk. `present` is kept for call-site compatibility.
 */
export function chunkedCookies(
  name: string,
  value: string | null,
  o: CookieOptions,
  _present?: Map<string, string>,
): string[] {
  const out: string[] = [];
  const chunks: string[] = [];
  if (value) for (let i = 0; i < value.length; i += CHUNK) chunks.push(value.slice(i, i + CHUNK));
  if (chunks.length > MAX_CHUNKS) throw new Error("session cookie too large");
  chunks.forEach((c, i) => {
    out.push(serializeCookie(`${name}.${i}`, c, o));
  });
  // Delete EVERY unused chunk index, not only those this request carried: two concurrent refreshes
  // can each write a different chunk count, and the response that lands last must not leave a stale
  // higher chunk from the other behind (A.0 + A.1 + B.2 would not unseal and would sign the user out).
  for (let i = chunks.length; i < MAX_CHUNKS; i++)
    out.push(serializeCookie(`${name}.${i}`, "", { ...o, maxAge: 0 }));
  return out;
}
