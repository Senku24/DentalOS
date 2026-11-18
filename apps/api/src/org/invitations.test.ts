import { afterAll, beforeAll, expect, test } from "bun:test";
import { hashToken } from "./invitations.controller";
import { type Harness, startHarness, token, uid } from "./test-harness";

let h: Harness;
let tA: string;
let tB: string;
let b1: string;
let owner: string;
let manager: string;
let ownerB: string;

beforeAll(async () => {
  h = await startHarness();
  tA = await h.tenant("Inv-A");
  tB = await h.tenant("Inv-B");
  b1 = await h.branch(tA);
  owner = await h.member(tA, ["OWNER"], { orgWide: true });
  manager = await h.member(tA, ["MANAGER"], { branchScope: [b1] });
  ownerB = await h.member(tB, ["OWNER"], { orgWide: true });
});
afterAll(() => h.close());

const email = () => `${uid("staff")}@Example.com`;
const invite = (body: Record<string, unknown>, user = owner, tenant = tA) =>
  h.call("POST", "/invitations", { user, tenant, body });

/**
 * Accept is called by a signed-in user with NO membership in the tenant (no X-Tenant-Id header).
 * `email` is the IdP-verified address on the token; it must match the invitation.
 */
const accept = async (user: string, body: unknown, email?: string, mfa = true) =>
  fetch(`${h.base}/invitations/accept`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await token(user, mfa, email)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

test("create stores only the hash, lower-cases email, returns the raw token once", async () => {
  const e = email();
  const r = await invite({ email: e, roles: ["RECEPTIONIST"], branchScope: [b1] });
  expect(r.status).toBe(201);
  expect(r.body.email).toBe(e.toLowerCase());
  expect(r.body.status).toBe("PENDING");
  expect(typeof r.body.token).toBe("string");
  const row = await h.admin.staffInvitation.findUniqueOrThrow({ where: { id: r.body.id } });
  expect(row.tokenHash).toBe(hashToken(r.body.token));
  expect(JSON.stringify(row)).not.toContain(r.body.token);
  // One pending invite per email.
  expect((await invite({ email: e, roles: ["DENTIST"], branchScope: [b1] })).status).toBe(409);
  const list = await h.call("GET", "/invitations?status=PENDING", { user: owner, tenant: tA });
  expect(list.body.items.map((i: { id: string }) => i.id)).toContain(r.body.id);
  expect(list.body.items[0].token).toBeUndefined();
});

test("validation and permissions", async () => {
  expect((await invite({ email: "nope", roles: ["DENTIST"], orgWide: true })).status).toBe(400);
  expect((await invite({ email: email(), roles: ["DENTIST"] })).status).toBe(400); // no scope
  expect((await invite({ email: email(), roles: ["PATIENT"], orgWide: true })).status).toBe(400);
  const foreign = await h.branch(tB);
  expect(
    (await invite({ email: email(), roles: ["DENTIST"], branchScope: [foreign] })).status,
  ).toBe(400);
  expect(
    (await invite({ email: email(), roles: ["DENTIST"], branchScope: [b1] }, manager)).status,
  ).toBe(403);
  expect((await h.call("GET", "/invitations", { user: manager, tenant: tA })).status).toBe(403);
});

test("accept creates the membership; the token is single-use", async () => {
  const e = email();
  const r = await invite({ email: e, roles: ["DENTIST", "RECEPTIONIST"], branchScope: [b1] });
  const newUser = uid("new");
  // The token's verified email is compared case-insensitively.
  const a = await accept(newUser, { tenantId: tA, token: r.body.token }, e.toUpperCase());
  expect(a.status).toBe(200);
  const m = await a.json();
  expect(m.userId).toBe(newUser);
  expect(m.roles).toEqual(["DENTIST", "RECEPTIONIST"]);
  expect(m.branchScope).toEqual([b1]);
  // The new member can now use the normal guarded API.
  expect((await h.call("GET", "/org", { user: newUser, tenant: tA })).status).toBe(200);
  // Reuse by anyone -> 410.
  const again = await accept(uid("other"), { tenantId: tA, token: r.body.token }, e);
  expect(again.status).toBe(410);
  expect((await again.json()).error).toBe("invitation_accepted");
  const audit = await h.admin.auditEvent.findFirst({
    where: { tenantId: tA, action: "invitation.accept", resourceId: r.body.id },
  });
  expect(audit?.actorId).toBe(newUser);
});

test("accept: expiry, revocation, wrong tenant, existing member, auth + MFA", async () => {
  // Expired.
  const exEmail = email().toLowerCase();
  const ex = await invite({ email: exEmail, roles: ["DENTIST"], branchScope: [b1] });
  await h.admin.staffInvitation.update({
    where: { id: ex.body.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const listed = await h.call("GET", "/invitations", { user: owner, tenant: tA });
  expect(listed.body.items.find((i: { id: string }) => i.id === ex.body.id).status).toBe("EXPIRED");
  const e1 = await accept(uid("late"), { tenantId: tA, token: ex.body.token }, exEmail);
  expect(e1.status).toBe(410);
  expect((await e1.json()).error).toBe("invitation_expired");
  expect(
    (await h.admin.staffInvitation.findUniqueOrThrow({ where: { id: ex.body.id } })).status,
  ).toBe("EXPIRED");

  // Resend revives it with a new token; the old token stops working.
  const rs = await h.call("POST", `/invitations/${ex.body.id}/resend`, {
    user: owner,
    tenant: tA,
    body: { expiresInDays: 2 },
  });
  expect(rs.status).toBe(200);
  expect(rs.body.status).toBe("PENDING");
  expect(rs.body.token).not.toBe(ex.body.token);
  expect((await accept(uid("x"), { tenantId: tA, token: ex.body.token }, exEmail)).status).toBe(
    404,
  );

  // Revoked.
  const rv = await h.call("POST", `/invitations/${ex.body.id}/revoke`, { user: owner, tenant: tA });
  expect(rv.status).toBe(200);
  expect(rv.body.status).toBe("REVOKED");
  expect(
    (await h.call("POST", `/invitations/${ex.body.id}/revoke`, { user: owner, tenant: tA })).status,
  ).toBe(409);
  const r2 = await accept(uid("y"), { tenantId: tA, token: rs.body.token }, exEmail);
  expect(r2.status).toBe(410);
  expect((await r2.json()).error).toBe("invitation_revoked");

  // Right token, wrong tenant -> 404 (bound to the issuing tenant).
  const okEmail = email().toLowerCase();
  const ok = await invite({ email: okEmail, roles: ["DENTIST"], branchScope: [b1] });
  expect((await accept(uid("z"), { tenantId: tB, token: ok.body.token }, okEmail)).status).toBe(
    404,
  );
  // Existing member -> 409, invitation stays usable.
  expect((await accept(manager, { tenantId: tA, token: ok.body.token }, okEmail)).status).toBe(
    409,
  );
  // No token / no MFA / bad body.
  const noAuth = await fetch(`${h.base}/invitations/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId: tA, token: ok.body.token }),
  });
  expect(noAuth.status).toBe(401);
  expect(
    (await accept(uid("nomfa"), { tenantId: tA, token: ok.body.token }, okEmail, false)).status,
  ).toBe(403);
  expect((await accept(uid("bad"), { tenantId: "x", token: "short" }, okEmail)).status).toBe(400);
  expect(
    (await h.admin.staffInvitation.findUniqueOrThrow({ where: { id: ok.body.id } })).status,
  ).toBe("PENDING");
});

test("accept: the token's verified email must match the invitation (403 email_mismatch)", async () => {
  const e = email().toLowerCase();
  const r = await invite({ email: e, roles: ["DENTIST"], branchScope: [b1] });
  const body = { tenantId: tA, token: r.body.token };
  const wrong = await accept(uid("intruder"), body, "someone-else@example.com");
  expect(wrong.status).toBe(403);
  expect((await wrong.json()).error).toBe("email_mismatch");
  // No verified email on the token at all -> same refusal.
  const none = await accept(uid("anon"), body);
  expect(none.status).toBe(403);
  expect((await none.json()).error).toBe("email_mismatch");
  // Nothing was consumed: the invited address can still accept.
  expect((await h.admin.staffInvitation.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe(
    "PENDING",
  );
  expect((await accept(uid("invitee"), body, e)).status).toBe(200);
});

test("cross-tenant revoke/resend are 404", async () => {
  const r = await invite({ email: email(), roles: ["DENTIST"], branchScope: [b1] });
  expect(
    (await h.call("POST", `/invitations/${r.body.id}/revoke`, { user: ownerB, tenant: tB })).status,
  ).toBe(404);
  expect(
    (
      await h.call("POST", `/invitations/${r.body.id}/resend`, {
        user: ownerB,
        tenant: tB,
        body: {},
      })
    ).status,
  ).toBe(404);
});
