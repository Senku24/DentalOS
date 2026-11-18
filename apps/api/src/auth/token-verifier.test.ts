import { afterAll, beforeAll, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { CognitoTokenVerifier, DevTokenVerifier, createTokenVerifier } from "./token-verifier";

const region = "ap-south-1";
const poolId = "ap-south-1_TESTPOOL1";
const clientId = "client-abc";
const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;

let server: ReturnType<typeof Bun.serve>;
let verifier: CognitoTokenVerifier;
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let signKey: Key;
let otherKey: Key;
let jwksHits = 0;

beforeAll(async () => {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  signKey = good.privateKey;
  otherKey = other.privateKey;
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = Bun.serve({
    port: 0,
    fetch() {
      jwksHits++;
      return Response.json({ keys: [jwk] });
    },
  });
  verifier = new CognitoTokenVerifier({
    region,
    userPoolId: poolId,
    clientId,
    mfaEnforcedByPool: true,
    jwksUrl: new URL(`http://localhost:${server.port}/jwks.json`),
  });
});
afterAll(() => server.stop(true));

const mint = (
  claims: Record<string, unknown> = {},
  o: { key?: Key; iss?: string; exp?: string | number; kid?: string; alg?: string } = {},
) =>
  new SignJWT({ token_use: "access", client_id: clientId, auth_time: 1_800_000_000, ...claims })
    .setProtectedHeader({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1" })
    .setSubject("sub-123")
    .setIssuer(o.iss ?? issuer)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "5m")
    .sign(o.key ?? signKey);

test("accepts a valid access token and maps claims", async () => {
  const c = await verifier.verify(await mint());
  expect(c).toEqual({ sub: "sub-123", mfa: true, authTime: 1_800_000_000 });
});

test("maps email only when Cognito marks it verified", async () => {
  expect((await verifier.verify(await mint({ email: "A@X.in", email_verified: true }))).email).toBe(
    "a@x.in",
  );
  expect(
    (await verifier.verify(await mint({ email: "a@x.in", email_verified: "true" }))).email,
  ).toBe("a@x.in");
  expect(
    (await verifier.verify(await mint({ email: "a@x.in", email_verified: false }))).email,
  ).toBeUndefined();
  expect((await verifier.verify(await mint({ email: "a@x.in" }))).email).toBeUndefined();
});

test("rejects: wrong issuer, wrong client, id token, expired, foreign signature, unknown kid", async () => {
  const bad = [
    await mint({}, { iss: "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_OTHER" }),
    await mint({ client_id: "someone-else" }),
    await mint({ token_use: "id" }),
    await mint({}, { exp: Math.floor(Date.now() / 1000) - 600 }),
    await mint({}, { key: otherKey }), // signed by a key the pool never published
    await mint({}, { kid: "nope" }),
  ];
  for (const t of bad) await expect(verifier.verify(t)).rejects.toThrow();
});

test("rejects tokens without sub/auth_time, alg=none and HS256 confusion", async () => {
  await expect(verifier.verify(await mint({ auth_time: undefined }))).rejects.toThrow();
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
    JSON.stringify({
      sub: "x",
      iss: issuer,
      token_use: "access",
      client_id: clientId,
      auth_time: 1,
    }),
  ).toString("base64url")}.`;
  await expect(verifier.verify(none)).rejects.toThrow();
  const hs = await new SignJWT({ token_use: "access", client_id: clientId, auth_time: 1 })
    .setProtectedHeader({ alg: "HS256", kid: "k1" })
    .setSubject("x")
    .setIssuer(issuer)
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode("a".repeat(32)));
  await expect(verifier.verify(hs)).rejects.toThrow();
});

test("fails closed when the JWKS endpoint is unreachable", async () => {
  const dead = new CognitoTokenVerifier({
    region,
    userPoolId: poolId,
    clientId,
    mfaEnforcedByPool: true,
    jwksUrl: new URL("http://localhost:1/jwks.json"),
  });
  await expect(dead.verify(await mint())).rejects.toThrow();
});

test("JWKS is cached across verifications", async () => {
  const before = jwksHits;
  await verifier.verify(await mint());
  await verifier.verify(await mint());
  expect(jwksHits - before).toBeLessThanOrEqual(1);
});

test("mfa reflects pool configuration (patient pools do not force MFA)", async () => {
  const noMfa = new CognitoTokenVerifier({
    region,
    userPoolId: poolId,
    clientId,
    mfaEnforcedByPool: false,
    jwksUrl: new URL(`http://localhost:${server.port}/jwks.json`),
  });
  expect((await noMfa.verify(await mint())).mfa).toBe(false);
});

test("createTokenVerifier: Cognito when configured; dev secret refused in production", () => {
  expect(
    createTokenVerifier({
      COGNITO_USER_POOL_ID: poolId,
      COGNITO_CLIENT_ID: clientId,
      AWS_REGION: region,
    }),
  ).toBeInstanceOf(CognitoTokenVerifier);
  expect(() => createTokenVerifier({ COGNITO_USER_POOL_ID: poolId })).toThrow();
  expect(() =>
    createTokenVerifier({ NODE_ENV: "production", DEV_JWT_SECRET: "x".repeat(32) }),
  ).toThrow();
  expect(createTokenVerifier({ DEV_JWT_SECRET: "x".repeat(32) })).toBeInstanceOf(DevTokenVerifier);
  expect(() => createTokenVerifier({})).toThrow();
});

test("dev verifier maps email (lower-cased) when present", async () => {
  const secret = new TextEncoder().encode("y".repeat(32));
  const dev = new DevTokenVerifier(secret);
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
  expect((await dev.verify(await sign({ mfa: true, email: " Me@X.IN " }))).email).toBe("me@x.in");
  expect("email" in (await dev.verify(await sign({ mfa: true })))).toBe(false);
});
