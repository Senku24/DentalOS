import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { todayIn } from "./http";
import { type Harness, code, startHarness, uid } from "./test-harness";

let h: Harness;
let tA: string;
let tB: string;
let b1: string;
let b2: string;
let owner: string;
let manager: string;
let rec: string;
let dentist: string;
let ownerB: string;

beforeAll(async () => {
  h = await startHarness();
  tA = await h.tenant("Org-A");
  tB = await h.tenant("Org-B");
  b1 = await h.branch(tA);
  b2 = await h.branch(tA);
  owner = await h.member(tA, ["OWNER"], { orgWide: true });
  manager = await h.member(tA, ["MANAGER"], { branchScope: [b1] });
  rec = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
  dentist = await h.member(tA, ["DENTIST"], { branchScope: [b1] });
  ownerB = await h.member(tB, ["OWNER"], { orgWide: true });
});
afterAll(() => h.close());

const as = (user: string, tenant = tA) => ({
  get: (path: string) => h.call("GET", path, { user, tenant }),
  post: (path: string, body: unknown = {}) => h.call("POST", path, { user, tenant, body }),
  patch: (path: string, body: unknown) => h.call("PATCH", path, { user, tenant, body }),
});

describe("tenant settings + onboarding", () => {
  test("any member reads; only org-wide owner updates; settings merge and onboardedAt is set", async () => {
    expect((await as(rec).get("/org")).status).toBe(200);
    expect((await as(manager).patch("/org", { name: "x" })).status).toBe(403);

    const r1 = await as(owner).patch("/org", {
      settings: { displayName: "Smile Co", defaultTimeZone: "Asia/Kolkata" },
    });
    expect(r1.status).toBe(200);
    const r2 = await as(owner).patch("/org", {
      settings: { currency: "INR" },
      onboardingStatus: "COMPLETED",
    });
    expect(r2.status).toBe(200);
    expect(r2.body.settings).toEqual({
      displayName: "Smile Co",
      defaultTimeZone: "Asia/Kolkata",
      currency: "INR",
    });
    expect(r2.body.onboardingStatus).toBe("COMPLETED");
    expect(r2.body.onboardedAt).not.toBeNull();

    const audit = await h.admin.auditEvent.findMany({
      where: { tenantId: tA, action: "tenant.update" },
    });
    expect(audit.length).toBe(2);
    expect(audit[0]?.resourceId).toBe(tA);
  });

  test("unknown settings keys and bad time zones are 400", async () => {
    expect((await as(owner).patch("/org", { settings: { secret: "x" } })).status).toBe(400);
    expect(
      (await as(owner).patch("/org", { settings: { defaultTimeZone: "Mars/Base" } })).status,
    ).toBe(400);
  });

  test("onboarding checklist", async () => {
    const r = await as(owner).get("/org/onboarding");
    expect(r.status).toBe(200);
    expect(r.body.steps.branches).toBe(true);
    expect(r.body.steps.staff).toBe(true);
    expect(typeof r.body.complete).toBe("boolean");
  });

  test("tenant B never sees tenant A", async () => {
    const r = await as(ownerB, tB).get("/org");
    expect(r.body.id).toBe(tB);
  });
});

describe("branches", () => {
  test("owner creates (code upper-cased), duplicate code 409, validation 400", async () => {
    const c = code("n").toLowerCase();
    const r = await as(owner).post("/branches", {
      code: c,
      name: "New Branch",
      phone: "98765 43210",
      workingHours: { mon: [{ open: "09:00", close: "13:00" }] },
    });
    expect(r.status).toBe(201);
    expect(r.body.code).toBe(c.toUpperCase());
    expect(r.body.phone).toBe("+919876543210");
    expect(r.body.timezone).toBe("Asia/Kolkata");
    expect((await as(owner).post("/branches", { code: c, name: "Dup" })).status).toBe(409);
    expect((await as(owner).post("/branches", { code: "x", name: "" })).status).toBe(400);
    expect(
      (
        await as(owner).post("/branches", {
          code: code(),
          name: "Overlap",
          workingHours: {
            mon: [
              { open: "09:00", close: "13:00" },
              { open: "12:00", close: "14:00" },
            ],
          },
        })
      ).status,
    ).toBe(400);
  });

  test("manager (branch-scoped) cannot create or update branches", async () => {
    expect((await as(manager).post("/branches", { code: code(), name: "M" })).status).toBe(403);
    expect((await as(manager).patch(`/branches/${b1}`, { name: "M" })).status).toBe(403);
  });

  test("branch-scoped reads only show the caller's branches; others 404", async () => {
    const list = await as(manager).get("/branches");
    expect(list.status).toBe(200);
    expect(list.body.items.map((b: { id: string }) => b.id)).toEqual([b1]);
    expect((await as(manager).get(`/branches/${b1}`)).status).toBe(200);
    expect((await as(manager).get(`/branches/${b2}`)).status).toBe(404);
    const all = await as(owner).get("/branches");
    expect(all.body.items.length).toBeGreaterThanOrEqual(2);
  });

  test("PATCH only touches sent fields (timezone is not reset)", async () => {
    const id = await h.branch(tA);
    await h.admin.branch.update({ where: { id }, data: { timezone: "Asia/Dubai" } });
    const r = await as(owner).patch(`/branches/${id}`, { name: "Renamed" });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Renamed");
    expect(r.body.timezone).toBe("Asia/Dubai");
  });

  test("deactivate / activate, audited", async () => {
    const id = await h.branch(tA);
    const d = await as(owner).post(`/branches/${id}/deactivate`);
    expect(d.status).toBe(200);
    expect(d.body.active).toBe(false);
    expect(
      (await as(owner).get("/branches?active=false")).body.items.map((b: { id: string }) => b.id),
    ).toContain(id);
    expect((await as(owner).post(`/branches/${id}/activate`)).body.active).toBe(true);
    const audit = await h.admin.auditEvent.findMany({
      where: { tenantId: tA, resourceId: id, action: { startsWith: "branch." } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual(["branch.activate", "branch.deactivate"]);
  });

  test("cross-tenant ids are 404, bad ids 400", async () => {
    expect((await as(ownerB, tB).get(`/branches/${b1}`)).status).toBe(404);
    expect((await as(ownerB, tB).patch(`/branches/${b1}`, { name: "x" })).status).toBe(404);
    expect((await as(ownerB, tB).post(`/branches/${b1}/deactivate`)).status).toBe(404);
    expect((await as(owner).get("/branches/not-a-uuid")).status).toBe(400);
  });
});

describe("staff memberships", () => {
  const idOf = async (tenant: string, userId: string) =>
    (
      await h.admin.membership.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: tenant, userId } },
      })
    ).id;

  test("branch-scoped list only shows overlapping members and scope", async () => {
    const other = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b2] });
    const both = await h.member(tA, ["DENTIST"], { branchScope: [b1, b2] });
    const r = await as(manager).get("/staff");
    expect(r.status).toBe(200);
    const users = r.body.items.map((m: { userId: string }) => m.userId);
    expect(users).toContain(rec);
    expect(users).toContain(owner); // org-wide members work in every branch
    expect(users).not.toContain(other);
    const bothRow = r.body.items.find((m: { userId: string }) => m.userId === both);
    expect(bothRow.branchScope).toEqual([b1]);
    expect((await as(manager).get(`/staff/${await idOf(tA, other)}`)).status).toBe(404);
    // Owner sees everyone.
    const all = await as(owner).get("/staff");
    expect(all.body.items.map((m: { userId: string }) => m.userId)).toContain(other);
    // Receptionist has no staff:read.
    expect((await as(rec).get("/staff")).status).toBe(403);
  });

  test("owner updates roles/scope; unknown or foreign branch ids 400; manager 403", async () => {
    const u = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
    const id = await idOf(tA, u);
    const ok = await as(owner).patch(`/staff/${id}`, {
      roles: ["RECEPTIONIST", "ACCOUNTANT"],
      branchScope: [b1, b2],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.roles).toEqual(["RECEPTIONIST", "ACCOUNTANT"]);
    expect(ok.body.branchScope.sort()).toEqual([b1, b2].sort());
    const foreign = await h.branch(tB);
    expect(
      (await as(owner).patch(`/staff/${id}`, { roles: ["RECEPTIONIST"], branchScope: [foreign] }))
        .status,
    ).toBe(400);
    expect((await as(owner).patch(`/staff/${id}`, { roles: ["RECEPTIONIST"] })).status).toBe(400);
    expect(
      (await as(manager).patch(`/staff/${id}`, { roles: ["RECEPTIONIST"], branchScope: [b1] }))
        .status,
    ).toBe(403);
    expect(
      (
        await as(ownerB, tB).patch(`/staff/${id}`, {
          roles: ["RECEPTIONIST"],
          branchScope: [],
          orgWide: true,
        })
      ).status,
    ).toBe(404);
  });

  test("the last org-wide owner cannot be demoted or narrowed; a second owner unlocks it", async () => {
    const t = await h.tenant("LastOwner");
    const b = await h.branch(t);
    const o1 = await h.member(t, ["OWNER"], { orgWide: true });
    const id1 = await idOf(t, o1);
    const demote = await h.call("PATCH", `/staff/${id1}`, {
      user: o1,
      tenant: t,
      body: { roles: ["MANAGER"], branchScope: [b] },
    });
    expect(demote.status).toBe(409);
    expect(demote.body.error).toBe("last_owner");
    const narrow = await h.call("PATCH", `/staff/${id1}`, {
      user: o1,
      tenant: t,
      body: { roles: ["OWNER"], orgWide: false, branchScope: [b] },
    });
    expect(narrow.status).toBe(409);
    // Owner + dentist is fine (still an org-wide owner).
    const add = await h.call("PATCH", `/staff/${id1}`, {
      user: o1,
      tenant: t,
      body: { roles: ["OWNER", "DENTIST"], orgWide: true },
    });
    expect(add.status).toBe(200);
    await h.member(t, ["OWNER"], { orgWide: true });
    const ok = await h.call("PATCH", `/staff/${id1}`, {
      user: o1,
      tenant: t,
      body: { roles: ["MANAGER"], branchScope: [b] },
    });
    expect(ok.status).toBe(200);
  });
});

describe("dentist branch assignments", () => {
  const today = () => todayIn("Asia/Kolkata");
  const plusDays = (n: number) => {
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  test("assign, transfer (future only) and history is preserved", async () => {
    const doc = await h.member(tA, ["DENTIST"], { branchScope: [b1, b2] });
    // A historical row from last year must never be touched.
    const past = await h.admin.dentistBranchAssignment.create({
      data: {
        tenantId: tA,
        userId: doc,
        branchId: b2,
        effectiveFrom: new Date("2025-01-01T00:00:00Z"),
        effectiveTo: new Date("2025-06-01T00:00:00Z"),
        createdBy: owner,
      },
    });
    const a = await as(owner).post("/dentist-assignments", {
      userId: doc,
      branchId: b1,
      effectiveFrom: today(),
    });
    expect(a.status).toBe(201);
    expect(a.body.effectiveTo).toBeNull();

    // Open row already exists -> 409.
    expect(
      (
        await as(owner).post("/dentist-assignments", {
          userId: doc,
          branchId: b1,
          effectiveFrom: plusDays(3),
        })
      ).status,
    ).toBe(409);
    // Past start dates are rejected.
    expect(
      (
        await as(owner).post("/dentist-assignments", {
          userId: doc,
          branchId: b2,
          effectiveFrom: plusDays(-2),
        })
      ).status,
    ).toBe(400);
    // Transfer into the past rejected; on the start day rejected (would be zero-length).
    const tBody = { userId: doc, fromBranchId: b1, toBranchId: b2 };
    expect(
      (
        await as(owner).post("/dentist-assignments/transfer", {
          ...tBody,
          effectiveFrom: plusDays(-1),
        })
      ).status,
    ).toBe(400);
    expect(
      (await as(owner).post("/dentist-assignments/transfer", { ...tBody, effectiveFrom: today() }))
        .status,
    ).toBe(400);

    const tr = await as(owner).post("/dentist-assignments/transfer", {
      ...tBody,
      effectiveFrom: plusDays(7),
    });
    expect(tr.status).toBe(200);
    expect(tr.body.closed.id).toBe(a.body.id);
    expect(tr.body.closed.effectiveFrom).toBe(today());
    expect(tr.body.closed.effectiveTo).toBe(plusDays(7));
    expect(tr.body.opened.branchId).toBe(b2);
    expect(tr.body.opened.effectiveFrom).toBe(plusDays(7));

    const hist = await as(owner).get(`/dentist-assignments?userId=${doc}`);
    expect(hist.body.items.length).toBe(3);
    const pastNow = await h.admin.dentistBranchAssignment.findUniqueOrThrow({
      where: { id: past.id },
    });
    expect(pastNow).toEqual(past);

    const current = await as(owner).get(`/dentist-assignments?userId=${doc}&status=current`);
    expect(current.body.items.map((x: { id: string }) => x.id).sort()).toEqual(
      [a.body.id, tr.body.opened.id].sort(),
    );

    // Branch-scoped reader only sees b1 rows.
    const scoped = await as(manager).get(`/dentist-assignments?userId=${doc}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.items.every((x: { branchId: string }) => x.branchId === b1)).toBe(true);

    // End the new assignment; ending again is 409.
    const end = await as(owner).post(`/dentist-assignments/${tr.body.opened.id}/end`, {
      effectiveTo: plusDays(30),
    });
    expect(end.status).toBe(200);
    expect(end.body.effectiveTo).toBe(plusDays(30));
    expect(
      (
        await as(owner).post(`/dentist-assignments/${tr.body.opened.id}/end`, {
          effectiveTo: plusDays(31),
        })
      ).status,
    ).toBe(409);
    const audit = await h.admin.auditEvent.count({
      where: {
        tenantId: tA,
        resource: "DentistBranchAssignment",
        action: { startsWith: "dentist_assignment." },
      },
    });
    expect(audit).toBeGreaterThanOrEqual(4);
  });

  test("non-dentists are refused; managers cannot assign; cross-tenant 404", async () => {
    expect(
      (
        await as(owner).post("/dentist-assignments", {
          userId: rec,
          branchId: b1,
          effectiveFrom: today(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(manager).post("/dentist-assignments", {
          userId: dentist,
          branchId: b1,
          effectiveFrom: today(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(ownerB, tB).post("/dentist-assignments", {
          userId: dentist,
          branchId: b1,
          effectiveFrom: today(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(owner).post("/dentist-assignments", {
          userId: uid("ghost"),
          branchId: b1,
          effectiveFrom: today(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(owner).post("/dentist-assignments", {
          userId: dentist,
          branchId: b1,
          effectiveFrom: "nope",
        })
      ).status,
    ).toBe(400);
  });
});
