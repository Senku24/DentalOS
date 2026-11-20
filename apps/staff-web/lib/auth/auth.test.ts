import { describe, expect, test } from "bun:test";
import { type AuthConfig, readAuthConfig } from "./config";
import { chunkedCookies, parseCookies, readChunked } from "./cookies";
import { b64urlEncode, pkceChallenge, seal, unseal } from "./crypto";
import { guardMisconfigured, guardRequest } from "./guard";
import {
  type Deps,
  handleCallback,
  handleLogin,
  handleLogout,
  handleProxy,
  handleSessionGet,
  handleSessionPost,
  upstreamUrl,
} from "./handlers";
import { safeReturnTo, sameOriginHref } from "./return-to";
import {
  type LoginTx,
  type Session,
  csrfTokenFor,
  sessionCookies,
  txCookie,
} from "./session-store";

// ------------------------------------------------------------------------------------ fixtures

const ENV = {
  COGNITO_DOMAIN: "https://staff.auth.ap-south-1.amazoncognito.com",
  COGNITO_CLIENT_ID: "client-123",
  COGNITO_USER_POOL_ID: "ap-south-1_pool",
  COGNITO_REGION: "ap-south-1",
  APP_URL: "https://staff.dentalos.test",
  API_URL: "https://api.dentalos.test",
  SESSION_SECRET: "x".repeat(48),
};
const cfg = readAuthConfig(ENV) as AuthConfig;
const ISS = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_pool";
const NOW = 1_800_000_000;
const TENANT = "11111111-1111-4111-8111-111111111111";

const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
const jwt = (claims: Record<string, unknown>) => `${enc({ alg: "none" })}.${enc(claims)}.sig`;

/** Records calls and answers from a route table keyed by "METHOD url-prefix". */
function fakeFetch(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const calls: Request[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.clone());
    for (const [k, h] of Object.entries(routes)) {
      const [m, prefix] = k.split(" ");
      if (req.method === m && req.url.startsWith(prefix as string)) return h(req);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
const deps = (f: typeof fetch = fakeFetch({}).f, now = NOW): Deps => ({ fetch: f, now: () => now });

/** Turns Set-Cookie headers into the Cookie header a browser would send back. */
function cookieHeader(res: Response, prior = ""): string {
  const jar = parseCookies(prior);
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(";");
    const i = (pair as string).indexOf("=");
    const k = (pair as string).slice(0, i);
    const v = decodeURIComponent((pair as string).slice(i + 1));
    if (/Max-Age=0/.test(sc)) jar.delete(k);
    else jar.set(k, v);
  }
  return [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
}

const baseSession = (over: Partial<Session> = {}): Session => ({
  v: 1,
  sid: "sid-abc",
  at: jwt({ sub: "user-1", exp: NOW + 3600 }),
  rt: "refresh-1",
  exp: NOW + 3600,
  iat: NOW - 10,
  authTime: NOW - 10,
  sub: "user-1",
  tid: TENANT,
  ...over,
});

async function sessionCookieHeader(s: Session): Promise<string> {
  const sc = await sessionCookies(new Request(cfg.appUrl), cfg, s, NOW);
  return cookieHeader(new Response(null, { headers: sc.map((c) => ["Set-Cookie", c]) }));
}

// ------------------------------------------------------------------------------------ config

describe("config", () => {
  test("no COGNITO_DOMAIN = dev mode", () => {
    expect(readAuthConfig({})).toBeNull();
    expect(readAuthConfig({ COGNITO_CLIENT_ID: "x" })).toBeNull();
  });
  test("production build without COGNITO_DOMAIN fails closed unless explicitly opted in", () => {
    expect(() => readAuthConfig({ NODE_ENV: "production" })).toThrow(/misconfigured/);
    expect(() => readAuthConfig({ NODE_ENV: "production", COGNITO_DOMAIN: " " })).toThrow(
      /misconfigured/,
    );
    expect(() => readAuthConfig({ NODE_ENV: "production", DENTALOS_AUTH_MODE: "cognito" })).toThrow(
      /misconfigured/,
    );
    expect(readAuthConfig({ NODE_ENV: "production", DENTALOS_AUTH_MODE: "dev" })).toBeNull();
    expect(readAuthConfig({ NODE_ENV: "development" })).toBeNull();
    // Cognito config in production is unaffected; the opt-in cannot coexist with it.
    expect(readAuthConfig({ ...ENV, NODE_ENV: "production" })).not.toBeNull();
    expect(() => readAuthConfig({ ...ENV, DENTALOS_AUTH_MODE: "dev" })).toThrow(/conflicts/);
  });
  test("misconfigured middleware fails closed", () => {
    expect(guardMisconfigured(new URL("https://staff.example/api/auth/proxy/me"))).toEqual({
      type: "next",
    });
    expect(guardMisconfigured(new URL("https://staff.example/api/x"))).toEqual({
      type: "misconfigured",
    });
    expect(guardMisconfigured(new URL("https://staff.example/patients?x=1"))).toEqual({
      type: "redirect",
      location: "https://staff.example/sign-in",
    });
    expect(guardMisconfigured(new URL("https://staff.example/sign-in"))).toEqual({ type: "next" });
  });
  test("partial Cognito config fails loudly instead of falling back to dev", () => {
    expect(() => readAuthConfig({ COGNITO_DOMAIN: ENV.COGNITO_DOMAIN })).toThrow(/misconfigured/);
    expect(() => readAuthConfig({ ...ENV, SESSION_SECRET: "short" })).toThrow(/32/);
    expect(() => readAuthConfig({ ...ENV, APP_URL: "http://staff.example.com" })).toThrow(/https/);
  });
  test("derives issuer, redirect URI and secure cookies", () => {
    expect(cfg.issuer).toBe(ISS);
    expect(cfg.redirectUri).toBe("https://staff.dentalos.test/api/auth/callback");
    expect(cfg.secureCookies).toBe(true);
    const local = readAuthConfig({ ...ENV, APP_URL: "http://localhost:3000" }) as AuthConfig;
    expect(local.secureCookies).toBe(false);
  });
});

// ------------------------------------------------------------------------------------ redirects

describe("returnTo allow-list (no open redirects)", () => {
  test.each([
    ["/patients/1?tab=notes#x", "/patients/1?tab=notes#x"],
    ["/", "/"],
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["https://evil.com/x", "/"],
    ["javascript:alert(1)", "/"],
    ["evil.com", "/"],
    ["/api/auth/logout", "/"],
    ["/_next/static/x.js", "/"],
    ["/%0d%0aSet-Cookie:x", "/%0d%0aSet-Cookie:x"],
    ["/a\nb", "/"],
    ["", "/"],
    // dot segments collapsing into a protocol-relative "//host"
    ["/.//evil.com", "/"],
    ["/..//evil.com", "/"],
    ["/%2e//evil.com", "/"],
    ["/%2E%2E//evil.com", "/"],
    ["/a/..//evil.com", "/"],
    ["/a/b/../..//evil.com/x?y#z", "/"],
    ["/./api/auth/logout", "/"],
    ["/a/../api/x", "/"],
    ["/a/../patients", "/patients"],
  ])("%p -> %p", (input, out) => {
    expect(safeReturnTo(input)).toBe(out);
  });
  test("every accepted value resolves onto our origin", () => {
    for (const v of ["/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/a/..//evil.com", "/x"]) {
      expect(new URL(safeReturnTo(v), "https://app.example/sign-in").origin).toBe(
        "https://app.example",
      );
    }
  });
  test("sameOriginHref re-validates at client sinks", () => {
    expect(sameOriginHref("/.//evil.com", "https://app.example")).toBe("/");
    expect(sameOriginHref("https://evil.com", "https://app.example")).toBe("/");
    expect(sameOriginHref("/patients?x=1", "https://app.example")).toBe("/patients?x=1");
  });
  test("non-strings fall back", () => {
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo(["/x"])).toBe("/");
  });
});

// ------------------------------------------------------------------------------------ crypto

describe("crypto", () => {
  test("PKCE S256 matches RFC 7636 appendix B", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  test("sealed values reject tampering, other keys and other purposes", async () => {
    const t = await seal({ a: 1 }, cfg.sessionSecret, "p1");
    expect(await unseal(t, cfg.sessionSecret, "p1")).toEqual({ a: 1 });
    expect(await unseal(t, cfg.sessionSecret, "p2")).toBeNull();
    expect(await unseal(t, "y".repeat(48), "p1")).toBeNull();
    // Flip the second-to-last char (fully data-bearing in base64url) to a different value.
    const flipped = `${t.slice(0, -2)}${t.at(-2) === "A" ? "B" : "A"}${t.slice(-1)}`;
    expect(flipped).not.toBe(t);
    expect(await unseal(flipped, cfg.sessionSecret, "p1")).toBeNull();
    expect(await unseal("garbage!", cfg.sessionSecret, "p1")).toBeNull();
  });
  test("large session values are chunked and reassembled", () => {
    const big = "z".repeat(9000);
    const set = chunkedCookies("s", big, { secure: true }, new Map());
    const written = set.filter((c) => !c.includes("Max-Age=0"));
    expect(written).toHaveLength(3);
    const jar = new Map(
      written.map((c) => [c.split("=")[0] as string, c.split("=")[1]?.split(";")[0] as string]),
    );
    expect(readChunked(jar, "s")).toBe(big);
  });
  test("every unused chunk index is deleted, even ones the request did not carry (refresh race)", () => {
    const apply = (jar: Map<string, string>, set: string[]) => {
      for (const c of set) {
        const [k, rest] = [c.split("=")[0] as string, c.split("=")[1]?.split(";")[0] as string];
        if (c.includes("Max-Age=0")) jar.delete(k);
        else jar.set(k, rest);
      }
    };
    const browser = new Map<string, string>();
    // Both requests were sent with no session chunks; B (3 chunks) lands first, A (2 chunks) last.
    const a = "a".repeat(7000);
    const b = "b".repeat(9000);
    apply(browser, chunkedCookies("s", b, {}, new Map()));
    apply(browser, chunkedCookies("s", a, {}, new Map()));
    expect(browser.has("s.2")).toBe(false);
    expect(readChunked(browser, "s")).toBe(a);
  });
});

// ------------------------------------------------------------------------------------ login

describe("GET /api/auth/login", () => {
  test("redirects to Cognito with state, nonce and S256 PKCE; secrets stay in a sealed cookie", async () => {
    const res = await handleLogin(
      new Request(`${cfg.appUrl}/api/auth/login?returnTo=%2Fpatients`),
      cfg,
      deps(),
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.origin + loc.pathname).toBe(`${cfg.domain}/oauth2/authorize`);
    const q = loc.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("client-123");
    expect(q.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("state")?.length).toBeGreaterThanOrEqual(43);
    expect(q.get("nonce")?.length).toBeGreaterThanOrEqual(43);
    expect(q.get("prompt")).toBeNull();

    const sc = res.headers.getSetCookie();
    expect(sc).toHaveLength(1);
    expect(sc[0]).toMatch(/^__Host-dos_auth_tx=/);
    expect(sc[0]).toContain("HttpOnly");
    expect(sc[0]).toContain("Secure");
    expect(sc[0]).toContain("SameSite=Lax");
    expect(sc[0]).toContain("Path=/");
    // The verifier is never in the URL, and the cookie is opaque.
    expect(sc[0]).not.toContain(q.get("state") as string);
    const raw = parseCookies(cookieHeader(res)).get("__Host-dos_auth_tx") as string;
    const tx = (await unseal<LoginTx>(raw, cfg.sessionSecret, "dentalos.login-tx.v1")) as LoginTx;
    expect(tx.state).toBe(q.get("state") as string);
    expect(await pkceChallenge(tx.verifier)).toBe(q.get("code_challenge") as string);
    expect(tx.returnTo).toBe("/patients");
  });

  test("hostile returnTo is replaced; reauth forces prompt=login + max_age=0", async () => {
    const res = await handleLogin(
      new Request(`${cfg.appUrl}/api/auth/login?returnTo=https://evil.com&reauth=1`),
      cfg,
      deps(),
    );
    const q = new URL(res.headers.get("location") as string).searchParams;
    expect(q.get("prompt")).toBe("login");
    expect(q.get("max_age")).toBe("0");
    const raw = parseCookies(cookieHeader(res)).get("__Host-dos_auth_tx") as string;
    const tx = (await unseal<LoginTx>(raw, cfg.sessionSecret, "dentalos.login-tx.v1")) as LoginTx;
    expect(tx.returnTo).toBe("/");
    expect(tx.reauth).toBe(true);
  });
});

// ------------------------------------------------------------------------------------ callback

async function startLogin(query = `returnTo=%2Fschedule&tenantId=${TENANT}`) {
  const res = await handleLogin(new Request(`${cfg.appUrl}/api/auth/login?${query}`), cfg, deps());
  const q = new URL(res.headers.get("location") as string).searchParams;
  return {
    cookie: cookieHeader(res),
    state: q.get("state") as string,
    nonce: q.get("nonce") as string,
  };
}

function tokenEndpoint(
  nonce: string,
  over: Record<string, unknown> = {},
  at: Record<string, unknown> = {},
) {
  return fakeFetch({
    [`POST ${cfg.domain}/oauth2/token`]: async (req) => {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") !== "authorization_code" || !form.get("code_verifier"))
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: jwt({ sub: "user-1", exp: NOW + 3600, auth_time: NOW, ...at }),
        refresh_token: "refresh-1",
        id_token: jwt({
          iss: ISS,
          aud: "client-123",
          sub: "user-1",
          exp: NOW + 3600,
          token_use: "id",
          nonce,
          email: "Asha@Clinic.in",
          email_verified: true,
          name: "Asha",
          ...over,
        }),
        expires_in: 3600,
      });
    },
  });
}

describe("GET /api/auth/callback", () => {
  test("valid code + state: exchanges with the PKCE verifier and starts a sealed session", async () => {
    const { cookie, state, nonce } = await startLogin();
    const { f, calls } = tokenEndpoint(nonce);
    const res = await handleCallback(
      new Request(`${cfg.appUrl}/api/auth/callback?code=abc&state=${state}`, {
        headers: { cookie },
      }),
      cfg,
      deps(f),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${cfg.appUrl}/schedule`);
    const form = new URLSearchParams(await calls[0]?.text());
    expect(form.get("code")).toBe("abc");
    expect(form.get("redirect_uri")).toBe(cfg.redirectUri);

    const sc = res.headers.getSetCookie();
    const session = sc.find((c) => c.startsWith("__Host-dos_session.0=")) as string;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    // Tokens are not readable in the cookie (encrypted).
    expect(session).not.toContain("refresh-1");
    expect(sc.find((c) => c.startsWith("__Host-dos_csrf="))).not.toContain("HttpOnly");
    expect(sc.find((c) => c.startsWith("__Host-dos_auth_tx="))).toContain("Max-Age=0");
    expect(sc.find((c) => c.startsWith("__Host-dos_tenant="))).toContain(TENANT);
  });

  test("no tenant chosen: goes to the organisation picker, keeping returnTo", async () => {
    const { cookie, state, nonce } = await startLogin("returnTo=%2Fbilling");
    const res = await handleCallback(
      new Request(`${cfg.appUrl}/api/auth/callback?code=abc&state=${state}`, {
        headers: { cookie },
      }),
      cfg,
      deps(tokenEndpoint(nonce).f),
    );
    expect(res.headers.get("location")).toBe(
      `${cfg.appUrl}/select-organisation?returnTo=%2Fbilling`,
    );
  });

  const failsWith = async (
    code: string,
    mk: (s: { cookie: string; state: string; nonce: string }) => {
      url: string;
      cookie?: string;
      f?: typeof fetch;
    },
  ) => {
    const s = await startLogin();
    const r = mk(s);
    const res = await handleCallback(
      new Request(r.url, {
        headers: r.cookie === undefined ? { cookie: s.cookie } : { cookie: r.cookie },
      }),
      cfg,
      deps(r.f ?? tokenEndpoint(s.nonce).f),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${cfg.appUrl}/sign-in?error=${code}`);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-dos_session"))).toBe(false);
  };

  test("state mismatch is rejected", () =>
    failsWith("state_mismatch", () => ({
      url: `${cfg.appUrl}/api/auth/callback?code=a&state=forged`,
    })));
  test("missing transaction cookie (login CSRF / other browser) is rejected", () =>
    failsWith("login_expired", (s) => ({
      url: `${cfg.appUrl}/api/auth/callback?code=a&state=${s.state}`,
      cookie: "",
    })));
  test("nonce mismatch (replayed id_token) is rejected", () =>
    failsWith("invalid_id_token", (s) => ({
      url: `${cfg.appUrl}/api/auth/callback?code=a&state=${s.state}`,
      f: tokenEndpoint("other-nonce").f,
    })));
  test("wrong audience / issuer are rejected", async () => {
    await failsWith("invalid_id_token", (s) => ({
      url: `${cfg.appUrl}/api/auth/callback?code=a&state=${s.state}`,
      f: tokenEndpoint(s.nonce, { aud: "someone-else" }).f,
    }));
    await failsWith("invalid_id_token", (s) => ({
      url: `${cfg.appUrl}/api/auth/callback?code=a&state=${s.state}`,
      f: tokenEndpoint(s.nonce, { iss: "https://evil" }).f,
    }));
  });
  test("IdP errors are mapped, never reflected", () =>
    failsWith("idp_error", (s) => ({
      url: `${cfg.appUrl}/api/auth/callback?error=<script>&state=${s.state}`,
    })));
  test("expired transaction is rejected", async () => {
    const s = await startLogin();
    const res = await handleCallback(
      new Request(`${cfg.appUrl}/api/auth/callback?code=a&state=${s.state}`, {
        headers: { cookie: s.cookie },
      }),
      cfg,
      deps(tokenEndpoint(s.nonce).f, NOW + 3600),
    );
    expect(res.headers.get("location")).toContain("error=login_expired");
  });
  test("step-up: a token without a fresh auth_time does not satisfy reauth", async () => {
    const s = await startLogin(`reauth=1&tenantId=${TENANT}`);
    const res = await handleCallback(
      new Request(`${cfg.appUrl}/api/auth/callback?code=a&state=${s.state}`, {
        headers: { cookie: s.cookie },
      }),
      cfg,
      deps(tokenEndpoint(s.nonce, {}, { auth_time: NOW - 3600 }).f),
    );
    expect(res.headers.get("location")).toContain("error=reauth_failed");
  });
});

// ------------------------------------------------------------------------------------ CSRF + logout

describe("CSRF on state-changing BFF calls", () => {
  test("logout needs the double-submit token and our Origin", async () => {
    const s = baseSession();
    const cookie = await sessionCookieHeader(s);
    const token = await csrfTokenFor(s, cfg);
    const { f, calls } = fakeFetch({
      [`POST ${cfg.domain}/oauth2/revoke`]: () => new Response(""),
    });
    const post = (headers: Record<string, string>) =>
      handleLogout(
        new Request(`${cfg.appUrl}/api/auth/logout`, {
          method: "POST",
          headers: { cookie, accept: "application/json", ...headers },
        }),
        cfg,
        deps(f),
      );
    expect((await post({ origin: cfg.appUrl })).status).toBe(403);
    expect((await post({ origin: "https://evil.com", "x-csrf-token": token })).status).toBe(403);
    expect((await post({ "x-csrf-token": token })).status).toBe(403); // no Origin, no Sec-Fetch-Site
    expect(calls).toHaveLength(0);
    const ok = await post({ origin: cfg.appUrl, "x-csrf-token": token });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { redirect: string }).redirect).toStartWith(
      `${cfg.domain}/logout?`,
    );
    expect(calls).toHaveLength(1); // refresh token revoked
    expect(ok.headers.getSetCookie().find((c) => c.startsWith("__Host-dos_session.0="))).toContain(
      "Max-Age=0",
    );
  });

  test("organisation switch is CSRF-checked and membership-verified via GET /me", async () => {
    const s = baseSession({ tid: undefined });
    const cookie = await sessionCookieHeader(s);
    const token = await csrfTokenFor(s, cfg);
    const { f, calls } = fakeFetch({
      [`GET ${cfg.apiUrl}/me`]: (req) =>
        req.headers.get("x-tenant-id") === TENANT
          ? Response.json({
              userId: "user-1",
              tenantId: TENANT,
              roles: ["DENTIST"],
              orgWide: false,
              branchScope: [],
            })
          : Response.json({ error: "forbidden" }, { status: 403 }),
    });
    const post = (tenantId: string, headers: Record<string, string>) =>
      handleSessionPost(
        new Request(`${cfg.appUrl}/api/auth/session`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json", ...headers },
          body: JSON.stringify({ tenantId }),
        }),
        cfg,
        deps(f),
      );
    expect(
      (await post(TENANT, { "sec-fetch-site": "cross-site", "x-csrf-token": token })).status,
    ).toBe(403);
    const other = "22222222-2222-4222-8222-222222222222";
    expect((await post(other, { origin: cfg.appUrl, "x-csrf-token": token })).status).toBe(403);
    const ok = await post(TENANT, { "sec-fetch-site": "same-origin", "x-csrf-token": token });
    expect(ok.status).toBe(200);
    expect(calls.at(-1)?.headers.get("authorization")).toBe(`Bearer ${s.at}`);
  });
});

// ------------------------------------------------------------------------------------ session + proxy

describe("GET /api/auth/session", () => {
  test("resolves the principal from GET /me with the access token", async () => {
    const s = baseSession();
    const { f, calls } = fakeFetch({
      [`GET ${cfg.apiUrl}/me`]: () =>
        Response.json({
          userId: "user-1",
          tenantId: TENANT,
          roles: ["OWNER"],
          orgWide: true,
          branchScope: [],
        }),
    });
    const res = await handleSessionGet(
      new Request(`${cfg.appUrl}/api/auth/session`, {
        headers: { cookie: await sessionCookieHeader(s) },
      }),
      cfg,
      deps(f),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.authenticated).toBe(true);
    expect((body.principal as { roles: string[] }).roles).toEqual(["OWNER"]);
    expect(body.csrfToken).toBe(await csrfTokenFor(s, cfg));
    expect(JSON.stringify(body)).not.toContain(s.at); // tokens never reach the browser
    expect(calls[0]?.headers.get("x-tenant-id")).toBe(TENANT);
  });

  test("no session / beyond the absolute lifetime = unauthenticated", async () => {
    const r1 = await handleSessionGet(new Request(`${cfg.appUrl}/api/auth/session`), cfg, deps());
    expect(((await r1.json()) as { authenticated: boolean }).authenticated).toBe(false);
    const old = await sessionCookieHeader(baseSession());
    const r2 = await handleSessionGet(
      new Request(`${cfg.appUrl}/api/auth/session`, { headers: { cookie: old } }),
      cfg,
      deps(undefined, NOW + cfg.sessionMaxAge + 1),
    );
    expect(((await r2.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  test("a removed member (roles: []) needs a new organisation", async () => {
    const { f } = fakeFetch({
      [`GET ${cfg.apiUrl}/me`]: () =>
        Response.json({
          userId: "user-1",
          tenantId: TENANT,
          roles: [],
          orgWide: false,
          branchScope: [],
        }),
    });
    const res = await handleSessionGet(
      new Request(`${cfg.appUrl}/api/auth/session`, {
        headers: { cookie: await sessionCookieHeader(baseSession()) },
      }),
      cfg,
      deps(f),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.needsTenant).toBe(true);
    expect(body.error).toBe("not_a_member");
  });
});

describe("API proxy", () => {
  test("adds Bearer + X-Tenant-Id and refreshes an expiring access token", async () => {
    const s = baseSession({ exp: NOW + 10 });
    const fresh = jwt({ sub: "user-1", exp: NOW + 3600 });
    const { f, calls } = fakeFetch({
      [`POST ${cfg.domain}/oauth2/token`]: async (req) => {
        const form = new URLSearchParams(await req.text());
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("refresh-1");
        return Response.json({ access_token: fresh, expires_in: 3600 });
      },
      [`GET ${cfg.apiUrl}/patients`]: () => Response.json({ items: [] }),
    });
    const res = await handleProxy(
      new Request(`${cfg.appUrl}/api/auth/proxy/patients?q=a`, {
        headers: { cookie: await sessionCookieHeader(s) },
      }),
      cfg,
      deps(f),
    );
    expect(res.status).toBe(200);
    const upstream = calls.at(-1) as Request;
    expect(upstream.url).toBe(`${cfg.apiUrl}/patients?q=a`);
    expect(upstream.headers.get("authorization")).toBe(`Bearer ${fresh}`);
    expect(upstream.headers.get("x-tenant-id")).toBe(TENANT);
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-dos_session.0="))).toBe(
      true,
    );
  });

  test("refresh token rejected = session ends (401)", async () => {
    const { f } = fakeFetch({
      [`POST ${cfg.domain}/oauth2/token`]: () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const res = await handleProxy(
      new Request(`${cfg.appUrl}/api/auth/proxy/patients`, {
        headers: { cookie: await sessionCookieHeader(baseSession({ exp: NOW - 5 })) },
      }),
      cfg,
      deps(f),
    );
    expect(res.status).toBe(401);
  });

  test("unsafe methods need CSRF; reauth_required passes through for step-up", async () => {
    const s = baseSession();
    const cookie = await sessionCookieHeader(s);
    const { f } = fakeFetch({
      [`DELETE ${cfg.apiUrl}/staff/`]: () =>
        Response.json({ error: "reauth_required" }, { status: 401 }),
    });
    const del = (headers: Record<string, string>) =>
      handleProxy(
        new Request(`${cfg.appUrl}/api/auth/proxy/staff/x`, {
          method: "DELETE",
          headers: { cookie, ...headers },
        }),
        cfg,
        deps(f),
      );
    expect((await del({ origin: cfg.appUrl })).status).toBe(403);
    const r = await del({ origin: cfg.appUrl, "x-csrf-token": await csrfTokenFor(s, cfg) });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe("reauth_required");
  });

  test("path traversal and foreign targets are refused", () => {
    const api = "https://api.dentalos.test/v1";
    expect(upstreamUrl(`${cfg.appUrl}/api/auth/proxy/patients/1`, api)?.toString()).toBe(
      "https://api.dentalos.test/v1/patients/1",
    );
    expect(upstreamUrl(`${cfg.appUrl}/api/auth/proxy/%2e%2e/admin`, api)).toBeNull();
    // Encoded dot-segments are normalised by the URL parser first, so they can never climb out.
    expect(upstreamUrl(`${cfg.appUrl}/api/auth/proxy/a/%2E%2E/b`, api)?.toString()).toBe(
      "https://api.dentalos.test/v1/b",
    );
    // Double-encoded segments are forwarded verbatim (never decoded into a dot-segment).
    expect(upstreamUrl(`${cfg.appUrl}/api/auth/proxy/a/%252e%252e/b`, api)?.pathname).toBe(
      "/v1/a/%252e%252e/b",
    );
    expect(upstreamUrl(`${cfg.appUrl}/api/auth/proxy/a%5Cb`, api)).toBeNull();
    expect(upstreamUrl(`${cfg.appUrl}/api/auth/proxy//evil.com/x`, api)).toBeNull();
    expect(upstreamUrl(`${cfg.appUrl}/api/auth/other`, api)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------ middleware

describe("middleware guard", () => {
  const jar = (h: string) => parseCookies(h);
  test("dev mode lets everything through", async () => {
    expect(await guardRequest(new URL("http://localhost:3000/patients"), new Map(), null)).toEqual({
      type: "next",
    });
  });
  test("signed out: pages redirect to login with a safe returnTo; APIs get 401", async () => {
    const d = await guardRequest(new URL(`${cfg.appUrl}/patients/1?tab=x`), new Map(), cfg, NOW);
    expect(d).toEqual({
      type: "redirect",
      location: `${cfg.appUrl}/api/auth/login?returnTo=${encodeURIComponent("/patients/1?tab=x")}`,
    });
    expect(await guardRequest(new URL(`${cfg.appUrl}/api/upload`), new Map(), cfg, NOW)).toEqual({
      type: "unauthorized",
    });
  });
  test("auth routes and the sign-in page are public", async () => {
    for (const p of ["/api/auth/login", "/api/auth/callback", "/sign-in"])
      expect((await guardRequest(new URL(`${cfg.appUrl}${p}`), new Map(), cfg, NOW)).type).toBe(
        "next",
      );
    expect(
      (await guardRequest(new URL(`${cfg.appUrl}/sign-income`), new Map(), cfg, NOW)).type,
    ).toBe("redirect");
  });
  test("a valid session passes; a forged cookie does not", async () => {
    const good = jar(await sessionCookieHeader(baseSession()));
    expect((await guardRequest(new URL(`${cfg.appUrl}/`), good, cfg, NOW)).type).toBe("next");
    const forged = new Map([["__Host-dos_session.0", "AAAA"]]);
    expect((await guardRequest(new URL(`${cfg.appUrl}/`), forged, cfg, NOW)).type).toBe("redirect");
  });
  test("the transaction cookie cannot be replayed as a session", async () => {
    const tx = await txCookie(cfg, {
      state: "s",
      nonce: "n",
      verifier: "v",
      returnTo: "/",
      reauth: false,
      at: NOW,
    });
    const value = decodeURIComponent((tx.split(";")[0] as string).split("=")[1] as string);
    const replay = new Map([["__Host-dos_session.0", value]]);
    expect((await guardRequest(new URL(`${cfg.appUrl}/`), replay, cfg, NOW)).type).toBe("redirect");
  });
});
