/**
 * Open-redirect guard for `returnTo`. Only same-origin, relative app paths are allowed:
 *   - must start with a single "/" (rejects "//evil", "/\evil", "https://evil", "javascript:")
 *   - no control characters or backslashes anywhere (browsers normalise "\" to "/")
 *   - must stay on our origin once resolved, and the RESOLVED path must not start with "//":
 *     dot segments collapse ("/.//evil.com", "/a/..//evil.com", "/%2e//evil.com" all resolve to
 *     "//evil.com", a protocol-relative URL), so every check runs on the resolved path
 *   - must not target the auth/API surface (e.g. "/api/auth/logout") — those are never a meaningful
 *     post-login destination.
 * Anything else falls back to "/".
 */
const BLOCKED_PREFIXES = ["/api/", "/_next/"];
const BASE = "https://staff.invalid";

export function safeReturnTo(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  let u: URL;
  try {
    u = new URL(value, BASE);
  } catch {
    return fallback;
  }
  if (u.origin !== BASE) return fallback;
  const path = u.pathname;
  if (!path.startsWith("/") || path.startsWith("//")) return fallback;
  if (path === "/api" || BLOCKED_PREFIXES.some((p) => path.startsWith(p))) return fallback;
  const out = `${path}${u.search}${u.hash}`;
  // Belt and braces: the result must itself resolve back onto our origin unchanged.
  try {
    if (new URL(out, BASE).origin !== BASE) return fallback;
  } catch {
    return fallback;
  }
  return out;
}

/**
 * Client-side sink guard: re-validates `returnTo` and resolves it against the current origin, so a
 * value can never navigate off-site even if it reached the component unvalidated.
 */
export function sameOriginHref(value: unknown, origin: string, fallback = "/"): string {
  const safe = safeReturnTo(value, fallback);
  try {
    const u = new URL(safe, origin);
    if (u.origin !== new URL(origin).origin) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}
