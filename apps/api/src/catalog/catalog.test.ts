import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Harness, code, startHarness, uid } from "../org/test-harness";

let h: Harness;
let tA: string;
let tB: string;
let b1: string;
let b2: string;
let owner: string;
let manager: string;
let rec: string;
let ownerB: string;

beforeAll(async () => {
  h = await startHarness();
  tA = await h.tenant("Cat-A");
  tB = await h.tenant("Cat-B");
  b1 = await h.branch(tA);
  b2 = await h.branch(tA);
  owner = await h.member(tA, ["OWNER"], { orgWide: true });
  manager = await h.member(tA, ["MANAGER"], { branchScope: [b1] });
  rec = await h.member(tA, ["RECEPTIONIST"], { branchScope: [b1] });
  ownerB = await h.member(tB, ["OWNER"], { orgWide: true });
});
afterAll(() => h.close());

const as = (user: string, tenant = tA) => ({
  get: (path: string) => h.call("GET", path, { user, tenant }),
  post: (path: string, body: unknown = {}) => h.call("POST", path, { user, tenant, body }),
  put: (path: string, body: unknown) => h.call("PUT", path, { user, tenant, body }),
  patch: (path: string, body: unknown) => h.call("PATCH", path, { user, tenant, body }),
  del: (path: string) => h.call("DELETE", path, { user, tenant }),
});

const newService = async (extra: Record<string, unknown> = {}) => {
  const r = await as(owner).post("/catalog/services", {
    code: code("S"),
    name: `Service ${uid("n")}`,
    durationMin: 30,
    basePricePaise: 150_000,
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; code: string; name: string };
};

describe("categories", () => {
  test("CRUD, permissions, in-use guard, cross-tenant 404", async () => {
    const c = await as(owner).post("/catalog/categories", { name: "Endodontics", sortOrder: 2 });
    expect(c.status).toBe(201);
    expect((await as(owner).post("/catalog/categories", { name: "Endodontics" })).status).toBe(409);
    expect((await as(manager).post("/catalog/categories", { name: "X" })).status).toBe(403);
    expect((await as(owner).post("/catalog/categories", { name: "" })).status).toBe(400);
    expect(
      (await as(rec).get("/catalog/categories")).body.items.map((x: { id: string }) => x.id),
    ).toContain(c.body.id);

    const up = await as(owner).patch(`/catalog/categories/${c.body.id}`, { active: false });
    expect(up.status).toBe(200);
    expect(up.body.sortOrder).toBe(2); // not reset to the default
    expect(up.body.active).toBe(false);

    await newService({ categoryId: c.body.id });
    expect((await as(owner).del(`/catalog/categories/${c.body.id}`)).status).toBe(409);
    const unused = await as(owner).post("/catalog/categories", { name: `Tmp ${uid("c")}` });
    expect((await as(owner).del(`/catalog/categories/${unused.body.id}`)).status).toBe(204);
    expect((await as(owner).get(`/catalog/categories/${unused.body.id}`)).status).toBe(404);
    expect((await as(ownerB, tB).get(`/catalog/categories/${c.body.id}`)).status).toBe(404);
    expect((await as(ownerB, tB).del(`/catalog/categories/${c.body.id}`)).status).toBe(404);
  });
});

describe("services", () => {
  test("create, upper-case code, duplicates, foreign category, validation", async () => {
    const s = await newService({ code: "rct-molar-x" });
    expect(s.code).toBe("RCT-MOLAR-X");
    const dup = await as(owner).post("/catalog/services", {
      code: "RCT-MOLAR-X",
      name: "Dup",
      durationMin: 30,
      basePricePaise: 1,
    });
    expect(dup.status).toBe(409);
    const foreignCat = await as(ownerB, tB).post("/catalog/categories", { name: uid("fc") });
    const bad = await as(owner).post("/catalog/services", {
      code: code("S"),
      name: "Bad cat",
      durationMin: 30,
      basePricePaise: 1,
      categoryId: foreignCat.body.id,
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await as(owner).post("/catalog/services", {
          code: code(),
          name: "Rupees?",
          durationMin: 30,
          basePricePaise: 12.5,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(manager).post("/catalog/services", {
          code: code(),
          name: "M",
          durationMin: 30,
          basePricePaise: 1,
        })
      ).status,
    ).toBe(403);
  });

  test("PATCH keeps unsent fields; activate/deactivate; cross-tenant 404", async () => {
    const s = await newService({ taxable: true });
    const r = await as(owner).patch(`/catalog/services/${s.id}`, { name: "Renamed service" });
    expect(r.status).toBe(200);
    expect(r.body.taxable).toBe(true);
    expect((await as(owner).post(`/catalog/services/${s.id}/deactivate`)).body.active).toBe(false);
    expect((await as(owner).post(`/catalog/services/${s.id}/activate`)).body.active).toBe(true);
    expect((await as(ownerB, tB).get(`/catalog/services/${s.id}`)).status).toBe(404);
    expect((await as(ownerB, tB).patch(`/catalog/services/${s.id}`, { name: "x" })).status).toBe(
      404,
    );
  });

  test("search by name fragment / code prefix with keyset pagination", async () => {
    const tag = uid("zir").replace("-", "");
    for (let i = 0; i < 3; i++) await newService({ name: `Zirconia crown ${tag} ${i}` });
    const p1 = await as(rec).get(`/catalog/services?q=${tag}&limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.items.length).toBe(2);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await as(rec).get(`/catalog/services?q=${tag}&limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.length).toBe(1);
    expect(p2.body.nextCursor).toBeNull();
    const names = [...p1.body.items, ...p2.body.items].map((x: { name: string }) => x.name);
    expect(names).toEqual([0, 1, 2].map((i) => `Zirconia crown ${tag} ${i}`));
    const s = await newService({ code: `QQ${tag.toUpperCase()}` });
    const byCode = await as(rec).get(`/catalog/services?q=qq${tag}`);
    expect(byCode.body.items.map((x: { id: string }) => x.id)).toEqual([s.id]);
    expect((await as(ownerB, tB).get(`/catalog/services?q=${tag}`)).body.items).toEqual([]);
  });
});

describe("branch price overrides", () => {
  test("set/replace/clear keep full history, effective price follows, audited", async () => {
    const s = await newService({ basePricePaise: 100_000 });
    const path = `/catalog/services/${s.id}/overrides`;
    const set1 = await as(manager).put(path, {
      branchId: b1,
      pricePaise: 90_000,
      reason: "Local competition",
    });
    expect(set1.status).toBe(200);
    expect(set1.body.closed).toBeNull();
    let price = await as(rec).get(`/catalog/services/${s.id}/price?branchId=${b1}`);
    expect(price.body).toMatchObject({
      pricePaise: 90_000,
      source: "OVERRIDE",
      overrideId: set1.body.override.id,
    });
    // Other branches keep the central price.
    price = await as(rec).get(`/catalog/services/${s.id}/price?branchId=${b2}`);
    expect(price.body).toMatchObject({ pricePaise: 100_000, source: "BASE", overrideId: null });

    const set2 = await as(manager).put(path, {
      branchId: b1,
      pricePaise: 95_000,
      reason: "Revised",
    });
    expect(set2.status).toBe(200);
    expect(set2.body.closed.id).toBe(set1.body.override.id);
    expect(set2.body.closed.pricePaise).toBe(90_000); // history row unchanged except its end
    price = await as(rec).get(`/catalog/services/${s.id}/price?branchId=${b1}`);
    expect(price.body.pricePaise).toBe(95_000);

    const list = await as(rec).get(
      `/catalog/services?q=${encodeURIComponent(s.name)}&branchId=${b1}`,
    );
    expect(list.body.items[0].effectivePricePaise).toBe(95_000);
    const pl = await as(rec).get(`/catalog/price-list?branchId=${b1}`);
    expect(pl.body.items.find((x: { id: string }) => x.id === s.id)).toMatchObject({
      pricePaise: 95_000,
      source: "OVERRIDE",
    });

    const clr = await as(manager).post(`${path}/clear`, {
      branchId: b1,
      reason: "Back to central",
    });
    expect(clr.status).toBe(200);
    expect(clr.body.effectiveTo).not.toBeNull();
    price = await as(rec).get(`/catalog/services/${s.id}/price?branchId=${b1}`);
    expect(price.body).toMatchObject({ pricePaise: 100_000, source: "BASE" });
    expect(
      (await as(manager).post(`${path}/clear`, { branchId: b1, reason: "Again" })).status,
    ).toBe(404);

    const hist = await as(owner).get(path);
    expect(hist.body.items.length).toBe(2);
    expect(hist.body.items.map((o: { pricePaise: number }) => o.pricePaise).sort()).toEqual([
      90_000, 95_000,
    ]);
    expect(
      hist.body.items.every((o: { effectiveTo: string | null }) => o.effectiveTo !== null),
    ).toBe(true);
    expect(hist.body.items.find((o: { id: string }) => o.id === set1.body.override.id).reason).toBe(
      "Local competition",
    );

    const audit = await h.admin.auditEvent.findMany({
      where: {
        tenantId: tA,
        resource: "BranchPriceOverride",
        resourceId: { in: [set1.body.override.id, set2.body.override.id] },
      },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      "price_override.clear",
      "price_override.close",
      "price_override.set",
      "price_override.set",
    ]);
    expect(audit.every((a) => a.branchId === b1 && a.actorId === manager)).toBe(true);

    // Delete is blocked once the service has price history.
    expect((await as(owner).del(`/catalog/services/${s.id}`)).status).toBe(409);
    const unused = await newService();
    expect((await as(owner).del(`/catalog/services/${unused.id}`)).status).toBe(204);
  });

  test("branch scope, role, reason and date rules", async () => {
    const s = await newService();
    const path = `/catalog/services/${s.id}/overrides`;
    expect(
      (await as(manager).put(path, { branchId: b2, pricePaise: 1, reason: "Out of scope" })).status,
    ).toBe(403);
    expect(
      (await as(rec).put(path, { branchId: b1, pricePaise: 1, reason: "Receptionist" })).status,
    ).toBe(403);
    expect((await as(manager).put(path, { branchId: b1, pricePaise: 1 })).status).toBe(400);
    expect((await as(manager).put(path, { branchId: b1, pricePaise: 1, reason: "x" })).status).toBe(
      400,
    );
    expect(
      (await as(manager).put(path, { branchId: b1, pricePaise: -5, reason: "Negative" })).status,
    ).toBe(400);
    expect(
      (
        await as(manager).put(path, {
          branchId: b1,
          pricePaise: 1,
          reason: "Backdated",
          effectiveFrom: "2020-01-01T00:00:00Z",
        })
      ).status,
    ).toBe(400);
    // Owner override at b2 is visible to the owner but not in the b1 manager's history.
    expect(
      (await as(owner).put(path, { branchId: b2, pricePaise: 7_000, reason: "Owner b2" })).status,
    ).toBe(200);
    const scoped = await as(manager).get(path);
    expect(scoped.body.items.every((o: { branchId: string }) => o.branchId === b1)).toBe(true);
    expect((await as(owner).get(path)).body.items.length).toBe(1);
  });

  test("scheduled override: current price until it starts, then replaced", async () => {
    const s = await newService({ basePricePaise: 50_000 });
    const path = `/catalog/services/${s.id}/overrides`;
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const r = await as(owner).put(path, {
      branchId: b1,
      pricePaise: 60_000,
      reason: "Next week price",
      effectiveFrom: later,
    });
    expect(r.status).toBe(200);
    const now = await as(rec).get(`/catalog/services/${s.id}/price?branchId=${b1}`);
    expect(now.body).toMatchObject({ pricePaise: 50_000, source: "BASE" });
    // A replacement starting before the scheduled row would overlap it.
    expect(
      (await as(owner).put(path, { branchId: b1, pricePaise: 1, reason: "Overlap" })).status,
    ).toBe(409);
    expect(
      (await as(owner).post(`${path}/clear`, { branchId: b1, reason: "Cancel schedule" })).status,
    ).toBe(200);
  });

  test("cross-tenant service or branch ids are 404", async () => {
    const s = await newService();
    const bB = await h.branch(tB);
    expect(
      (
        await as(ownerB, tB).put(`/catalog/services/${s.id}/overrides`, {
          branchId: bB,
          pricePaise: 1,
          reason: "Cross",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(owner).put(`/catalog/services/${s.id}/overrides`, {
          branchId: bB,
          pricePaise: 1,
          reason: "Cross",
        })
      ).status,
    ).toBe(404);
    expect((await as(owner).get(`/catalog/services/${s.id}/price?branchId=${bB}`)).status).toBe(
      404,
    );
    expect((await as(owner).get(`/catalog/price-list?branchId=${bB}`)).status).toBe(404);
    expect((await as(owner).get(`/catalog/services/${s.id}/price`)).status).toBe(400);
  });
});
