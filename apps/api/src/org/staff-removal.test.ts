import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dateFromDay, dayFromDate, todayIn } from "./http";
import { type Harness, startHarness, token, uid } from "./test-harness";

let h: Harness;
let tA: string;
let tB: string;
let b1: string;
let b2: string;
let owner: string;
let manager: string;
let ownerB: string;

beforeAll(async () => {
  h = await startHarness();
  tA = await h.tenant("Removal-A");
  tB = await h.tenant("Removal-B");
  b1 = await h.branch(tA);
  b2 = await h.branch(tA);
  owner = await h.member(tA, ["OWNER"], { orgWide: true });
  manager = await h.member(tA, ["MANAGER"], { branchScope: [b1] });
  ownerB = await h.member(tB, ["OWNER"], { orgWide: true });
});
afterAll(() => h.close());

const as = (user: string, tenant = tA) => ({
  get: (path: string) => h.call("GET", path, { user, tenant }),
  post: (path: string, body: unknown = {}) => h.call("POST", path, { user, tenant, body }),
  patch: (path: string, body: unknown) => h.call("PATCH", path, { user, tenant, body }),
  del: (path: string) => h.call("DELETE", path, { user, tenant }),
});

const idOf = async (tenant: string, userId: string) =>
  (
    await h.admin.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: tenant, userId } },
    })
  ).id;

const today = () => todayIn("Asia/Kolkata");
const plusDays = (n: number) => {
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("DELETE /staff/:id", () => {
  test("the last org-wide owner cannot be removed; a second owner unlocks it", async () => {
    const t = await h.tenant("Removal-LastOwner");
    const o1 = await h.member(t, ["OWNER"], { orgWide: true });
    const id1 = await idOf(t, o1);
    const r = await h.call("DELETE", `/staff/${id1}`, { user: o1, tenant: t });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("last_owner");
    // A branch-scoped OWNER does not count as an org-wide owner.
    await h.member(t, ["OWNER"], { branchScope: [await h.branch(t)] });
    expect((await h.call("DELETE", `/staff/${id1}`, { user: o1, tenant: t })).status).toBe(409);
    const o2 = await h.member(t, ["OWNER"], { orgWide: true });
    const ok = await h.call("DELETE", `/staff/${id1}`, { user: o2, tenant: t });
    expect(ok.status).toBe(200);
    expect(ok.body.roles).toEqual([]);
    // o2 is now the last org-wide owner.
    const last = await h.call("DELETE", `/staff/${await idOf(t, o2)}`, { user: o2, tenant: t });
    expect(last.body.error).toBe("last_owner");
  });

  test("ends running assignments at today, cancels future ones, keeps history and the row", async () => {
    const d = await h.member(tA, ["DENTIST"], { branchScope: [b1, b2] });
    await h.admin.membership.update({
      where: { tenantId_userId: { tenantId: tA, userId: d } },
      data: { displayName: "Dr. Leaving", email: "leaving@example.com" },
    });
    const mk = (branchId: string, from: string, to: string | null) =>
      h.admin.dentistBranchAssignment.create({
        data: {
          tenantId: tA,
          userId: d,
          branchId,
          effectiveFrom: dateFromDay(from),
          effectiveTo: to ? dateFromDay(to) : null,
          createdBy: owner,
        },
      });
    const history = await mk(b2, plusDays(-60), plusDays(-30)); // closed in the past
    const running = await mk(b1, plusDays(-29), null); // open, started in the past
    const future = await mk(b2, plusDays(5), null); // never took effect

    const id = await idOf(tA, d);
    const r = await as(owner).del(`/staff/${id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id,
      userId: d,
      roles: [],
      orgWide: false,
      branchScope: [],
      displayName: "Dr. Leaving",
      email: "leaving@example.com",
      endedAssignmentIds: [running.id],
      cancelledAssignmentIds: [future.id],
    });

    const rows = await h.admin.dentistBranchAssignment.findMany({
      where: { tenantId: tA, userId: d },
    });
    expect(rows.map((x) => x.id).sort()).toEqual([history.id, running.id].sort());
    const hist = rows.find((x) => x.id === history.id);
    expect(hist && dayFromDate(hist.effectiveTo as Date)).toBe(plusDays(-30)); // untouched
    const ran = rows.find((x) => x.id === running.id);
    expect(ran && dayFromDate(ran.effectiveFrom)).toBe(plusDays(-29));
    expect(ran && dayFromDate(ran.effectiveTo as Date)).toBe(today());

    // The membership row survives (assignment FK + attribution); no current assignment remains.
    const cur = await as(owner).get(`/dentist-assignments?userId=${d}&status=current`);
    expect(cur.body.items).toEqual([]);
    const all = await as(owner).get(`/dentist-assignments?userId=${d}&status=all`);
    expect(all.body.items.length).toBe(2);

    const audit = await h.admin.auditEvent.findMany({
      where: { tenantId: tA, resourceId: { in: [id, running.id, future.id] } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual(
      ["dentist_assignment.cancel", "dentist_assignment.close", "membership.remove"].sort(),
    );
  });

  test("an assignment that started today is kept as history and closed at tomorrow", async () => {
    const d = await h.member(tA, ["DENTIST"], { branchScope: [b1] });
    const started = await h.admin.dentistBranchAssignment.create({
      data: {
        tenantId: tA,
        userId: d,
        branchId: b1,
        effectiveFrom: dateFromDay(today()),
        createdBy: owner,
      },
    });
    const r = await as(owner).del(`/staff/${await idOf(tA, d)}`);
    expect(r.status).toBe(200);
    expect(r.body.endedAssignmentIds).toEqual([started.id]);
    expect(r.body.cancelledAssignmentIds).toEqual([]);
    const row = await h.admin.dentistBranchAssignment.findUniqueOrThrow({
      where: { id: started.id },
    });
    expect(dayFromDate(row.effectiveFrom)).toBe(today());
    expect(dayFromDate(row.effectiveTo as Date)).toBe(plusDays(1));
    const all = await as(owner).get(`/dentist-assignments?userId=${d}&status=all`);
    expect(all.body.items.map((a: { id: string }) => a.id)).toEqual([started.id]);
  });

  test("an assignment racing a removal waits on the membership lock and sees the removal", async () => {
    const d = await h.member(tA, ["DENTIST"], { branchScope: [b1] });
    const id = await idOf(tA, d);
    let settled = false;
    let pending: Promise<{ status: number; body: { error?: string } }> | undefined;
    // Simulate DELETE /staff/:id holding its FOR UPDATE lock while it clears the roles.
    await h.admin.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Membership" WHERE id = ${id}::uuid FOR UPDATE`;
        pending = as(owner)
          .post("/dentist-assignments", { userId: d, branchId: b1, effectiveFrom: plusDays(1) })
          .finally(() => {
            settled = true;
          });
        await new Promise((r) => setTimeout(r, 300));
        expect(settled).toBe(false); // blocked on FOR SHARE
        await tx.membership.update({
          where: { id },
          data: { roles: [], orgWide: false, branchScope: [] },
        });
      },
      { timeout: 10_000 },
    );
    const r = await (pending as Promise<{ status: number; body: { error?: string } }>);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("not_a_dentist");
    expect(
      await h.admin.dentistBranchAssignment.count({ where: { tenantId: tA, userId: d } }),
    ).toBe(0);
  });

  test("a removed member is hidden from lists, still resolvable by id, and loses access", async () => {
    const u = await h.member(tA, ["MANAGER"], { branchScope: [b1] });
    const id = await idOf(tA, u);
    expect((await as(u).get("/staff")).status).toBe(200);
    expect((await as(owner).del(`/staff/${id}`)).status).toBe(200);

    const list = await as(owner).get("/staff");
    expect(list.body.items.map((m: { id: string }) => m.id)).not.toContain(id);
    const one = await as(owner).get(`/staff/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.roles).toEqual([]);

    // No roles -> every @Can route is refused.
    expect((await as(u).get("/staff")).status).toBe(403);
    expect((await as(u).get("/branches")).status).toBe(403);
    // Already removed; access edits are refused (restore = new invitation).
    expect((await as(owner).del(`/staff/${id}`)).body.error).toBe("member_removed");
    const patch = await as(owner).patch(`/staff/${id}`, { roles: ["MANAGER"], branchScope: [b1] });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toBe("member_removed");
  });

  // KNOWN GAP (flagged for Wave 3): AuthGuard (src/auth/, not X1-owned) only rejects a missing
  // membership row, so the two member routes without `@Can` still answer a removed member. Flip to
  // `test` once the guard treats `roles.length === 0` as non-membership.
  test.todo("a removed member gets 403 on GET /me and GET /events", async () => {
    const u = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
    expect((await as(owner).del(`/staff/${await idOf(tA, u)}`)).status).toBe(200);
    expect((await as(u).get("/me")).status).toBe(403);
    const ev = await fetch(`${h.base}/events`, {
      headers: { authorization: `Bearer ${await token(u)}`, "x-tenant-id": tA },
    });
    expect(ev.status).toBe(403);
    await ev.body?.cancel();
  });

  test("permissions: manager 403, cross-tenant 404, bad id 400", async () => {
    const u = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
    const id = await idOf(tA, u);
    expect((await as(manager).del(`/staff/${id}`)).status).toBe(403);
    expect((await as(ownerB, tB).del(`/staff/${id}`)).status).toBe(404);
    expect((await as(owner).del("/staff/not-a-uuid")).status).toBe(400);
    const row = await h.admin.membership.findUniqueOrThrow({ where: { id } });
    expect(row.roles).toEqual(["RECEPTIONIST"]);
  });

  test("re-inviting a removed member restores access and records the verified e-mail", async () => {
    const u = uid("rejoin");
    await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1], userId: u });
    const id = await idOf(tA, u);
    expect((await as(owner).del(`/staff/${id}`)).status).toBe(200);

    const email = `${uid("rejoin")}@example.com`;
    const inv = await as(owner).post("/invitations", {
      email,
      roles: ["DENTIST"],
      branchScope: [b2],
    });
    expect(inv.status).toBe(201);
    const r = await fetch(`${h.base}/invitations/accept`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token(u, true, email.toUpperCase())}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: tA, token: inv.body.token }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ id, roles: ["DENTIST"], branchScope: [b2], email });
    expect((await as(u).get("/me")).body.roles).toEqual(["DENTIST"]);
    // Still one row for the user.
    expect(await h.admin.membership.count({ where: { tenantId: tA, userId: u } })).toBe(1);
  });
});

describe("staff display name / e-mail", () => {
  test("accepting an invitation stores the verified e-mail; lists return name + e-mail", async () => {
    const email = `${uid("named")}@example.com`;
    const inv = await as(owner).post("/invitations", {
      email,
      roles: ["RECEPTIONIST"],
      branchScope: [b1],
    });
    const u = uid("named");
    const r = await fetch(`${h.base}/invitations/accept`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await token(u, true, email)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId: tA, token: inv.body.token }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).email).toBe(email);
    const list = await as(owner).get("/staff");
    const row = list.body.items.find((m: { userId: string }) => m.userId === u);
    expect(row).toMatchObject({ email, displayName: null });
  });

  test("PATCH /staff/:id/profile: self or staff:manage; others 403; removed 409", async () => {
    const u = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
    const other = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
    const id = await idOf(tA, u);
    const self = await as(u).patch(`/staff/${id}/profile`, { displayName: "  Priya N  " });
    expect(self.status).toBe(200);
    expect(self.body.displayName).toBe("Priya N");
    expect((await as(other).patch(`/staff/${id}/profile`, { displayName: "X" })).status).toBe(403);
    // Branch-scoped manager has no staff:manage (org-wide permission).
    expect((await as(manager).patch(`/staff/${id}/profile`, { displayName: "X" })).status).toBe(
      403,
    );
    const byOwner = await as(owner).patch(`/staff/${id}/profile`, { displayName: null });
    expect(byOwner.body.displayName).toBeNull();
    expect((await as(owner).patch(`/staff/${id}/profile`, { displayName: "" })).status).toBe(400);
    expect((await as(owner).get(`/staff/${id}`)).body.displayName).toBeNull();
    await as(owner).del(`/staff/${id}`);
    expect((await as(owner).patch(`/staff/${id}/profile`, { displayName: "Y" })).status).toBe(409);
  });
});
