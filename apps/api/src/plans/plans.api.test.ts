import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient, withTenant } from "@dentalos/db";
import { clinicalGuardError } from "../common/db-errors";
import {
  PLAN_ITEM_SESSION_TRANSITIONS,
  canTransitionSession,
  deriveSessionStatus,
} from "./session-status";
import {
  type World,
  seedAppointment,
  seedEncounter,
  seedPatient,
  seedService,
  setOverride,
  startWorld,
} from "./test-fixtures";

// Plans, items, frozen pricing, versions + diff, decisions, sessions, roles, tenancy.
// Fresh random tenants; never deletes shared rows.

let w: World;
let app: PrismaClient; // app role (RLS on), for DB-level guard checks
let patient: string;
let otherPatient: string;
let svcA: string; // base 50 000
let svcB: string; // base 120 000, a1 override 100 000

// biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON responses in tests
type Res = { status: number; body: any };
const as =
  (user: () => string, tenant?: () => string) =>
  (method: string, path: string, body?: unknown): Promise<Res> =>
    w.h.call(method, path, { user: user(), tenant: tenant ? tenant() : w.tA, body });

const dentist = as(() => w.users.dentist);
const dentistA2 = as(() => w.users.dentistA2);
const rec = as(() => w.users.rec);
const owner = as(() => w.users.owner);
const acct = as(() => w.users.acct);
const dentistB = as(
  () => w.users.dentistB,
  () => w.tB,
);
const ownerB = as(
  () => w.users.ownerB,
  () => w.tB,
);

beforeAll(async () => {
  w = await startWorld("PLANS");
  app = new PrismaClient({
    datasources: {
      db: { url: "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos" },
    },
  });
  patient = await seedPatient(w.h, w.tA, w.a1, "Asha");
  otherPatient = await seedPatient(w.h, w.tA, w.a1, "Ravi");
  svcA = await seedService(w.h, w.tA, 50_000);
  svcB = await seedService(w.h, w.tA, 120_000);
  await setOverride(w.h, w.tA, svcB, w.a1, 100_000);
});
afterAll(async () => {
  await app.$disconnect();
  await w.h.close();
});

async function newPlan(items: unknown[] = [{ serviceId: svcA }], who = dentist, pt = patient) {
  const r = await who("POST", "/plans", {
    patientId: pt,
    branchId: w.a1,
    title: "Restorative plan",
    items,
  });
  expect(r.status).toBe(201);
  return r.body;
}

async function presented(items: unknown[]) {
  const plan = await newPlan(items);
  const r = await dentist("POST", `/plans/${plan.id}/present`, {});
  expect(r.status).toBe(200);
  return r.body;
}

describe("pricing is frozen server-side", () => {
  test("estimates come from the branch effective price; client prices are ignored", async () => {
    const plan = await newPlan([
      { serviceId: svcA, quantity: 2, estimatePricePaise: 1, toothCode: 36, surfaces: ["M", "O"] },
      { serviceId: svcB, phase: 2 },
    ]);
    expect(plan.status).toBe("DRAFT");
    expect(plan.currentVersion).toBe(0);
    const [a, b] = plan.items;
    expect(a.estimatePricePaise).toBe(50_000);
    expect(a.priceSource).toBe("BASE");
    expect(a.lineTotalPaise).toBe(100_000);
    expect(a.toothCode).toBe(36);
    expect(a.surfaces).toEqual(["M", "O"]);
    expect(b.estimatePricePaise).toBe(100_000);
    expect(b.priceSource).toBe("OVERRIDE");
    expect(plan.totals).toEqual({
      estimatePaise: 200_000,
      acceptedPaise: 0,
      completedPaise: 0,
      pendingPaise: 200_000,
    });
    expect(plan.phaseTotals.map((p: { phase: number; estimatePaise: number }) => p)).toEqual([
      {
        phase: 1,
        estimatePaise: 100_000,
        acceptedPaise: 0,
        completedPaise: 0,
        pendingPaise: 100_000,
      },
      {
        phase: 2,
        estimatePaise: 100_000,
        acceptedPaise: 0,
        completedPaise: 0,
        pendingPaise: 100_000,
      },
    ]);
  });

  test("price stays frozen after catalogue and override changes; reprice re-freezes", async () => {
    const svc = await seedService(w.h, w.tA, 30_000);
    await setOverride(w.h, w.tA, svc, w.a1, 25_000);
    const plan = await presented([{ serviceId: svc }]);
    const itemId = plan.items[0].id;
    expect(plan.items[0].estimatePricePaise).toBe(25_000);

    await w.h.admin.service.update({ where: { id: svc }, data: { basePricePaise: 99_000 } });
    await setOverride(w.h, w.tA, svc, w.a1, 77_000);
    const again = await dentist("GET", `/plans/${plan.id}`);
    expect(again.body.items[0].estimatePricePaise).toBe(25_000);
    // The presented snapshot keeps the frozen price too.
    const v1 = await dentist("GET", `/plans/${plan.id}/versions/1`);
    expect(v1.body.snapshot.items[0].estimatePricePaise).toBe(25_000);
    expect(v1.body.snapshot.totals.estimatePaise).toBe(25_000);

    // A new item for the same service is priced now.
    const added = await dentist("POST", `/plans/${plan.id}/items`, { serviceId: svc });
    expect(added.status).toBe(201);
    expect(
      added.body.items.map((i: { estimatePricePaise: number }) => i.estimatePricePaise),
    ).toEqual([25_000, 77_000]);
    // Explicit reprice re-freezes the current effective price.
    const rp = await dentist("PATCH", `/plan-items/${itemId}`, { reprice: true });
    expect(rp.status).toBe(200);
    expect(rp.body.items.find((i: { id: string }) => i.id === itemId).estimatePricePaise).toBe(
      77_000,
    );
  });

  test("unknown / inactive services are refused", async () => {
    const inactive = await seedService(w.h, w.tA, 10_000);
    await w.h.admin.service.update({ where: { id: inactive }, data: { active: false } });
    const r1 = await dentist("POST", "/plans", {
      patientId: patient,
      branchId: w.a1,
      title: "x",
      items: [{ serviceId: inactive }],
    });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe("service_inactive");
    const r2 = await dentist("POST", "/plans", {
      patientId: patient,
      branchId: w.a1,
      title: "x",
      items: [{ serviceId: "00000000-0000-4000-8000-000000000000" }],
    });
    expect(r2.status).toBe(404);
    expect(r2.body.error).toBe("service_not_found");
  });
});

describe("items, FDI and sequencing", () => {
  test("FDI tooth / surface validation", async () => {
    const plan = await newPlan([]);
    const bad = [
      { serviceId: svcA, toothCode: 19 },
      { serviceId: svcA, toothCode: 11, surfaces: ["O"] }, // anterior: incisal, not occlusal
      { serviceId: svcA, surfaces: ["M"] }, // surfaces need a tooth
      { serviceId: svcA, toothCode: 36, surfaces: ["P"] }, // mandibular: lingual, not palatal
    ];
    for (const body of bad) {
      const r = await dentist("POST", `/plans/${plan.id}/items`, body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("validation_failed");
    }
    const ok = await dentist("POST", `/plans/${plan.id}/items`, {
      serviceId: svcA,
      toothCode: 55,
      surfaces: ["M", "O", "P"],
    });
    expect(ok.status).toBe(201);
    const itemId = ok.body.items[0].id;
    // Changing the tooth without surfaces resets them; invalid surfaces for the new tooth -> 400.
    const moved = await dentist("PATCH", `/plan-items/${itemId}`, { toothCode: 11 });
    expect(moved.body.items[0]).toMatchObject({ toothCode: 11, surfaces: [] });
    const wrong = await dentist("PATCH", `/plan-items/${itemId}`, { surfaces: ["O"] });
    expect(wrong.status).toBe(400);
    const cleared = await dentist("PATCH", `/plan-items/${itemId}`, { toothCode: null });
    expect(cleared.body.items[0]).toMatchObject({ toothCode: null, surfaces: [] });
  });

  test("insert at a sequence shifts the phase; reorder renumbers per phase", async () => {
    const plan = await newPlan([{ serviceId: svcA }, { serviceId: svcB }]);
    const [first, second] = plan.items;
    const ins = await dentist("POST", `/plans/${plan.id}/items`, {
      serviceId: svcA,
      sequence: 1,
      notes: "first",
    });
    const order = ins.body.items.map((i: { id: string; sequence: number }) => [i.sequence, i.id]);
    expect(order[1]).toEqual([2, first.id]);
    expect(order[2]).toEqual([3, second.id]);
    const inserted = order[0][1];

    const mismatch = await dentist("POST", `/plans/${plan.id}/items/reorder`, {
      items: [{ itemId: first.id }],
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toBe("reorder_mismatch");

    const r = await dentist("POST", `/plans/${plan.id}/items/reorder`, {
      items: [{ itemId: second.id }, { itemId: first.id, phase: 2 }, { itemId: inserted }],
    });
    expect(r.status).toBe(200);
    const pos = Object.fromEntries(
      r.body.items.map((i: { id: string; phase: number; sequence: number }) => [
        i.id,
        [i.phase, i.sequence],
      ]),
    );
    expect(pos[second.id]).toEqual([1, 1]);
    expect(pos[inserted]).toEqual([1, 2]);
    expect(pos[first.id]).toEqual([2, 1]);
    expect(r.body.currentVersion).toBe(0); // DRAFT: no versions
  });

  test("DRAFT items can be removed; presented ones never (service + DB trigger)", async () => {
    const plan = await newPlan([{ serviceId: svcA }, { serviceId: svcB }]);
    const del = await dentist("DELETE", `/plan-items/${plan.items[1].id}`);
    expect(del.status).toBe(200);
    expect(del.body.items).toHaveLength(1);

    await dentist("POST", `/plans/${plan.id}/present`, {});
    const keep = await dentist("DELETE", `/plan-items/${plan.items[0].id}`);
    expect(keep.status).toBe(409);
    expect(keep.body.error).toBe("plan_item_history");

    // The DB trigger refuses it too (app role, RLS on); clinicalGuardError maps it.
    const err = await withTenant(app, w.tA, (tx) =>
      tx.planItem.delete({ where: { id: plan.items[0].id } }),
    ).catch((e) => e);
    expect(clinicalGuardError(err)).toBe("plan_item_history");
  });
});

describe("present, versions and diff", () => {
  test("present takes v1; empty plan / second present refused", async () => {
    const empty = await newPlan([]);
    const r0 = await dentist("POST", `/plans/${empty.id}/present`, {});
    expect(r0.status).toBe(409);
    expect(r0.body.error).toBe("plan_empty");

    const plan = await presented([{ serviceId: svcA }]);
    expect(plan.status).toBe("PRESENTED");
    expect(plan.currentVersion).toBe(1);
    expect(plan.presentedBy).toBe(w.users.dentist);
    const again = await dentist("POST", `/plans/${plan.id}/present`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "invalid_transition", from: "PRESENTED" });
  });

  test("every change after presentation appends a snapshot; history is preserved", async () => {
    const plan = await presented([{ serviceId: svcA }, { serviceId: svcB }]);
    const [i1, i2] = plan.items;
    const steps: [string, string, unknown][] = [
      ["PATCH", `/plans/${plan.id}`, { title: "Revised plan", reason: "patient asked" }], // v2
      ["POST", `/plans/${plan.id}/items`, { serviceId: svcA, phase: 2 }], // v3
      ["PATCH", `/plan-items/${i1.id}`, { quantity: 3 }], // v4
      [
        "POST",
        `/plans/${plan.id}/decisions`,
        { decisions: [{ itemId: i2.id, decision: "DEFERRED", reason: "cost" }] },
      ], // v5
    ];
    for (const [m, path, body] of steps) {
      const r = await dentist(m, path, body);
      expect([200, 201]).toContain(r.status);
    }
    const vs = await dentist("GET", `/plans/${plan.id}/versions`);
    expect(vs.status).toBe(200);
    expect(vs.body.items.map((v: { version: number }) => v.version)).toEqual([1, 2, 3, 4, 5]);
    const [v1, v2, v3, v4, v5] = vs.body.items;
    expect(v1.snapshot.plan.title).toBe("Restorative plan");
    expect(v1.snapshot.items).toHaveLength(2);
    expect(v2.snapshot.plan.title).toBe("Revised plan");
    expect(v2.reason).toBe("patient asked");
    expect(v3.snapshot.items).toHaveLength(3);
    expect(v3.snapshot.items[0].serviceCode).toBeString();
    expect(v4.snapshot.items.find((i: { id: string }) => i.id === i1.id).quantity).toBe(3);
    expect(v4.snapshot.totals.estimatePaise).toBe(3 * 50_000 + 100_000 + 50_000);
    expect(v5.snapshot.items.find((i: { id: string }) => i.id === i2.id).status).toBe("DEFERRED");
    expect(v5.snapshot.items.find((i: { id: string }) => i.id === i2.id).decisionReason).toBe(
      "cost",
    );
    // No-op PATCH does not version.
    const noop = await dentist("PATCH", `/plans/${plan.id}`, { title: "Revised plan" });
    expect(noop.body.currentVersion).toBe(5);

    // Versions are append-only at the DB (app role has no UPDATE/DELETE).
    const upd = await withTenant(app, w.tA, (tx) =>
      tx.treatmentPlanVersion.updateMany({ where: { planId: plan.id }, data: { reason: "x" } }),
    ).catch((e) => e);
    expect(String(upd?.message ?? upd)).toMatch(/permission denied/i);
  });

  test("diff reports plan fields, added, removed and changed items", async () => {
    const plan = await presented([{ serviceId: svcA }, { serviceId: svcB }]);
    const [i1, i2] = plan.items;
    await dentist("PATCH", `/plans/${plan.id}`, { notes: "Needs X-ray first" }); // v2
    const add = await dentist("POST", `/plans/${plan.id}/items`, { serviceId: svcB }); // v3
    const i3 = add.body.items.find((i: { id: string }) => i.id !== i1.id && i.id !== i2.id).id;
    await dentist("PATCH", `/plan-items/${i1.id}`, { quantity: 2, toothCode: 46 }); // v4

    const d13 = await dentist("GET", `/plans/${plan.id}/versions/1/diff/3`);
    expect(d13.status).toBe(200);
    expect(d13.body).toEqual({
      fromVersion: 1,
      toVersion: 3,
      planFields: ["notes"],
      added: [i3],
      removed: [],
      changed: [],
    });
    const d34 = await dentist("GET", `/plans/${plan.id}/versions/3/diff/4`);
    expect(d34.body.added).toEqual([]);
    expect(d34.body.changed).toHaveLength(1);
    expect(d34.body.changed[0].itemId).toBe(i1.id);
    expect([...d34.body.changed[0].fields].sort()).toEqual(["quantity", "toothCode"]);
    const d41 = await dentist("GET", `/plans/${plan.id}/versions/4/diff/1`);
    expect(d41.body.removed).toEqual([i3]);
    expect(d41.body.changed.map((c: { itemId: string }) => c.itemId)).toEqual([i1.id]);

    const missing = await dentist("GET", `/plans/${plan.id}/versions/1/diff/99`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("plan_version_not_found");
  });

  test("concurrent edits are serialised into contiguous versions", async () => {
    const plan = await presented([{ serviceId: svcA }]);
    const rs = await Promise.all(
      [1, 2, 3, 4].map((n) => dentist("PATCH", `/plans/${plan.id}`, { title: `Title ${n}` })),
    );
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const vs = await dentist("GET", `/plans/${plan.id}/versions`);
    expect(vs.body.items.map((v: { version: number }) => v.version)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("decisions and derived plan status", () => {
  test("partial accept / defer / reject with reasons -> PARTIALLY_ACCEPTED", async () => {
    const plan = await presented([{ serviceId: svcA }, { serviceId: svcB }, { serviceId: svcA }]);
    const [i1, i2, i3] = plan.items.map((i: { id: string }) => i.id);

    const noReason = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId: i2, decision: "REJECTED" }],
    });
    expect(noReason.status).toBe(400);

    const r = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [
        { itemId: i1, decision: "ACCEPTED" },
        { itemId: i2, decision: "DEFERRED", reason: "next year" },
        { itemId: i3, decision: "REJECTED", reason: "second opinion" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("PARTIALLY_ACCEPTED");
    expect(r.body.currentVersion).toBe(2);
    const by = Object.fromEntries(
      r.body.items.map((i: { id: string; status: string }) => [i.id, i]),
    );
    expect(by[i1]).toMatchObject({ status: "ACCEPTED", decidedBy: w.users.dentist });
    expect(by[i2]).toMatchObject({ status: "DEFERRED", decisionReason: "next year" });
    expect(by[i3]).toMatchObject({ status: "REJECTED", decisionReason: "second opinion" });
    expect(r.body.totals).toEqual({
      estimatePaise: 150_000,
      acceptedPaise: 50_000,
      completedPaise: 0,
      pendingPaise: 100_000,
    });

    // ACCEPTED -> REJECTED is not in the item table.
    const bad = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId: i1, decision: "REJECTED", reason: "changed mind" }],
    });
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ error: "invalid_transition", from: "ACCEPTED", itemId: i1 });

    // Deferring the last accepted item sends the plan back to PRESENTED.
    const back = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId: i1, decision: "DEFERRED", reason: "travelling" }],
    });
    expect(back.body.status).toBe("PRESENTED");
    const all = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [
        { itemId: i1, decision: "ACCEPTED" },
        { itemId: i2, decision: "ACCEPTED" },
      ],
    });
    expect(all.body.status).toBe("PARTIALLY_ACCEPTED"); // i3 rejected
  });

  test("all accepted -> ACCEPTED; all rejected -> REJECTED; re-propose re-presents", async () => {
    const p1 = await presented([{ serviceId: svcA }, { serviceId: svcB }]);
    const acc = await dentist("POST", `/plans/${p1.id}/decisions`, {
      decisions: p1.items.map((i: { id: string }) => ({ itemId: i.id, decision: "ACCEPTED" })),
    });
    expect(acc.body.status).toBe("ACCEPTED");

    const p2 = await presented([{ serviceId: svcA }]);
    const rej = await dentist("POST", `/plans/${p2.id}/decisions`, {
      decisions: [{ itemId: p2.items[0].id, decision: "REJECTED", reason: "too costly" }],
    });
    expect(rej.body.status).toBe("REJECTED");
    const nothing = await dentist("POST", `/plans/${p2.id}/present`, {});
    expect(nothing.status).toBe(409);
    expect(nothing.body.error).toBe("nothing_to_present");
    // Re-propose (clinician) -> back to PRESENTED, price re-frozen.
    const rp = await dentist("POST", `/plan-items/${p2.items[0].id}/status`, { to: "PROPOSED" });
    expect(rp.status).toBe(200);
    expect(rp.body.status).toBe("PRESENTED");
    expect(rp.body.items[0]).toMatchObject({ status: "PROPOSED", decisionReason: null });
  });

  test("decisions need a presented plan", async () => {
    const plan = await newPlan([{ serviceId: svcA }]);
    const r = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId: plan.items[0].id, decision: "ACCEPTED" }],
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("plan_not_presented");
  });

  test("item progress to COMPLETED completes the plan (rejected items ignored)", async () => {
    const plan = await presented([{ serviceId: svcA }, { serviceId: svcB }]);
    const [i1, i2] = plan.items.map((i: { id: string }) => i.id);
    await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [
        { itemId: i1, decision: "ACCEPTED" },
        { itemId: i2, decision: "REJECTED", reason: "not needed" },
      ],
    });
    // Decisions are not allowed on the status endpoint; COMPLETED needs IN_PROGRESS first.
    const dec = await dentist("POST", `/plan-items/${i2}/status`, { to: "ACCEPTED" });
    expect(dec.status).toBe(409);
    expect(dec.body.error).toBe("invalid_transition");
    const skip = await dentist("POST", `/plan-items/${i1}/status`, { to: "COMPLETED" });
    expect(skip.status).toBe(409);
    expect(skip.body.allowed).toEqual(["SCHEDULED", "IN_PROGRESS", "CANCELLED"]);
    const noReason = await dentist("POST", `/plan-items/${i1}/status`, { to: "CANCELLED" });
    expect(noReason.status).toBe(400);

    expect((await dentist("POST", `/plan-items/${i1}/status`, { to: "IN_PROGRESS" })).status).toBe(
      200,
    );
    const done = await dentist("POST", `/plan-items/${i1}/status`, { to: "COMPLETED" });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("COMPLETED");
    expect(done.body.totals.completedPaise).toBe(50_000);
    const closed = await dentist("PATCH", `/plans/${plan.id}`, { title: "late edit" });
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe("plan_closed");
  });

  test("cancel needs a reason and freezes the plan", async () => {
    const plan = await presented([{ serviceId: svcA }]);
    expect((await dentist("POST", `/plans/${plan.id}/cancel`, {})).status).toBe(400);
    const c = await dentist("POST", `/plans/${plan.id}/cancel`, { reason: "patient moved" });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "CANCELLED", cancelReason: "patient moved" });
    expect(c.body.currentVersion).toBe(2);
    const add = await dentist("POST", `/plans/${plan.id}/items`, { serviceId: svcA });
    expect(add.status).toBe(409);
    expect(add.body.error).toBe("plan_closed");
  });
});

describe("sessions (server-derived status)", () => {
  async function acceptedItem() {
    const plan = await presented([{ serviceId: svcA }]);
    const itemId = plan.items[0].id;
    await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId, decision: "ACCEPTED" }],
    });
    return { plan, itemId };
  }

  test("pure table + derivation", () => {
    expect(PLAN_ITEM_SESSION_TRANSITIONS.COMPLETED).toEqual([]);
    expect(canTransitionSession("PLANNED", "SCHEDULED")).toBe(true);
    expect(canTransitionSession("COMPLETED", "PLANNED")).toBe(false);
    const f = { appointmentStatus: null, encounterSigned: false, procedureCompleted: false };
    expect(deriveSessionStatus("PLANNED", f)).toBe("PLANNED");
    expect(deriveSessionStatus("PLANNED", { ...f, appointmentStatus: "BOOKED" })).toBe("SCHEDULED");
    expect(deriveSessionStatus("SCHEDULED", { ...f, appointmentStatus: "CANCELLED" })).toBe(
      "PLANNED",
    );
    expect(deriveSessionStatus("SCHEDULED", { ...f, encounterSigned: true })).toBe("COMPLETED");
    expect(deriveSessionStatus("CANCELLED", { ...f, encounterSigned: true })).toBe("CANCELLED");
  });

  test("clients cannot set SCHEDULED / COMPLETED", async () => {
    const { itemId } = await acceptedItem();
    for (const status of ["COMPLETED", "SCHEDULED", "CANCELLED"]) {
      const r = await dentist("POST", `/plan-items/${itemId}/sessions`, { status });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("session_status_server_derived");
    }
    const s = await dentist("POST", `/plan-items/${itemId}/sessions`, {});
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ sessionNo: 1, status: "PLANNED" });
    for (const status of ["COMPLETED", "SCHEDULED", "PLANNED"]) {
      const r = await dentist("PATCH", `/plan-item-sessions/${s.body.id}`, { status });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("session_status_server_derived");
    }
    const still = await dentist("GET", `/plan-items/${itemId}/sessions`);
    expect(still.body.items[0].status).toBe("PLANNED");
  });

  test("appointment link -> SCHEDULED (item too); signed encounter -> COMPLETED", async () => {
    const { plan, itemId } = await acceptedItem();
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const s1 = await dentist("POST", `/plan-items/${itemId}/sessions`, { appointmentId: appt });
    expect(s1.status).toBe(201);
    expect(s1.body.status).toBe("SCHEDULED");
    let p = await dentist("GET", `/plans/${plan.id}`);
    expect(p.body.items[0].status).toBe("SCHEDULED");
    const linked = await w.h.admin.appointment.findUniqueOrThrow({ where: { id: appt } });
    expect(linked.planItemId).toBe(itemId);

    // Unlinking the appointment -> PLANNED; item undo SCHEDULED -> ACCEPTED.
    const un = await dentist("PATCH", `/plan-item-sessions/${s1.body.id}`, { appointmentId: null });
    expect(un.body.status).toBe("PLANNED");
    p = await dentist("GET", `/plans/${plan.id}`);
    expect(p.body.items[0].status).toBe("ACCEPTED");

    // A second session (multiple per item), completed by a signed encounter.
    const enc = await seedEncounter(w.h, w.tA, patient, w.a1, w.users.dentist, true);
    const s2 = await dentist("POST", `/plan-items/${itemId}/sessions`, {});
    expect(s2.body.sessionNo).toBe(2);
    const done = await dentist("PATCH", `/plan-item-sessions/${s2.body.id}`, { encounterId: enc });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("COMPLETED");
    p = await dentist("GET", `/plans/${plan.id}`);
    expect(p.body.items[0].status).toBe("IN_PROGRESS");
    // Closed sessions only take notes.
    const closed = await dentist("PATCH", `/plan-item-sessions/${s2.body.id}`, {
      encounterId: null,
    });
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe("session_closed");
    const notes = await dentist("PATCH", `/plan-item-sessions/${s2.body.id}`, { notes: "ok" });
    expect(notes.status).toBe(200);

    // Explicit complete / cancel of the first session.
    const c = await dentist("POST", `/plan-item-sessions/${s1.body.id}/complete`);
    expect(c.body.status).toBe("COMPLETED");
    const again = await dentist("POST", `/plan-item-sessions/${s1.body.id}/complete`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("invalid_transition");
    const s3 = await dentist("POST", `/plan-items/${itemId}/sessions`, { sessionNo: 2 });
    expect(s3.status).toBe(409);
    expect(s3.body.error).toBe("session_no_taken");
    const s4 = await dentist("POST", `/plan-items/${itemId}/sessions`, {});
    const cancelled = await dentist("PATCH", `/plan-item-sessions/${s4.body.id}`, {
      status: "CANCELLED",
    });
    expect(cancelled.body.status).toBe("CANCELLED");
  });

  test("links must be the same patient's; sessions only for accepted items", async () => {
    const { itemId } = await acceptedItem();
    const foreign = await seedAppointment(w.h, w.tA, otherPatient, w.a1);
    const r = await dentist("POST", `/plan-items/${itemId}/sessions`, { appointmentId: foreign });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "link_patient_mismatch", field: "appointmentId" });

    const proposed = await presented([{ serviceId: svcA }]);
    const r2 = await dentist("POST", `/plan-items/${proposed.items[0].id}/sessions`, {});
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe("item_not_schedulable");
  });
});

describe("roles, branch scope, tenancy, merged patients", () => {
  test("receptionist has plan:read only; owner / manager read but cannot write", async () => {
    const plan = await presented([{ serviceId: svcA }]);
    expect((await rec("GET", `/plans/${plan.id}`)).status).toBe(200);
    expect((await rec("GET", `/plans?patientId=${patient}`)).status).toBe(200);
    expect((await rec("GET", `/plans/${plan.id}/versions`)).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ["POST", "/plans", { patientId: patient, branchId: w.a1, title: "x" }],
      ["PATCH", `/plans/${plan.id}`, { title: "x" }],
      ["POST", `/plans/${plan.id}/items`, { serviceId: svcA }],
      ["POST", `/plans/${plan.id}/present`, {}],
      [
        "POST",
        `/plans/${plan.id}/decisions`,
        { decisions: [{ itemId: plan.items[0].id, decision: "ACCEPTED" }] },
      ],
      ["POST", `/plans/${plan.id}/approve`, {}],
      ["POST", `/plans/${plan.id}/cancel`, { reason: "nope" }],
      ["PATCH", `/plan-items/${plan.items[0].id}`, { quantity: 2 }],
      ["POST", `/plan-items/${plan.items[0].id}/status`, { to: "CANCELLED", reason: "nope" }],
      ["POST", `/plan-items/${plan.items[0].id}/sessions`, {}],
    ];
    for (const [m, path, body] of writes) {
      const r = await rec(m, path, body);
      expect(`${m} ${path} ${r.status}`).toBe(`${m} ${path} 403`);
    }
    // ADR 0003 §3.1: SCHEDULED needs plan:write OR appointment:write, so the front desk can mark
    // an accepted item booked (and undo it) — but never decide or complete it.
    await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId: plan.items[0].id, decision: "ACCEPTED" }],
    });
    const booked = await rec("POST", `/plan-items/${plan.items[0].id}/status`, { to: "SCHEDULED" });
    expect(booked.status).toBe(200);
    expect(booked.body.items[0].status).toBe("SCHEDULED");
    const progress = await rec("POST", `/plan-items/${plan.items[0].id}/status`, {
      to: "IN_PROGRESS",
    });
    expect(progress.status).toBe(403);
    const undo = await rec("POST", `/plan-items/${plan.items[0].id}/status`, { to: "ACCEPTED" });
    expect(undo.body.items[0].status).toBe("ACCEPTED");

    expect((await owner("GET", `/plans/${plan.id}`)).status).toBe(200);
    expect(
      (await owner("POST", "/plans", { patientId: patient, branchId: w.a1, title: "x" })).status,
    ).toBe(403);
    expect((await acct("GET", `/plans/${plan.id}`)).status).toBe(403);
    expect((await acct("GET", "/plans")).status).toBe(403);
  });

  test("branch scope: other-branch dentist cannot see (404) or create (403)", async () => {
    const plan = await newPlan([{ serviceId: svcA }]);
    expect((await dentistA2("GET", `/plans/${plan.id}`)).status).toBe(404);
    expect((await dentistA2("PATCH", `/plans/${plan.id}`, { title: "x" })).status).toBe(404);
    expect(
      (await dentistA2("PATCH", `/plan-items/${plan.items[0].id}`, { quantity: 2 })).status,
    ).toBe(404);
    const list = await dentistA2("GET", `/plans?patientId=${patient}`);
    expect(list.body.items.map((x: { id: string }) => x.id)).not.toContain(plan.id);
    const create = await dentistA2("POST", "/plans", {
      patientId: patient,
      branchId: w.a1,
      title: "x",
    });
    expect(create.status).toBe(403);
  });

  test("cross-tenant ids answer 404", async () => {
    const plan = await presented([{ serviceId: svcA }]);
    const item = plan.items[0].id;
    expect((await ownerB("GET", `/plans/${plan.id}`)).status).toBe(404);
    expect((await ownerB("GET", `/plans/${plan.id}/versions`)).status).toBe(404);
    expect((await ownerB("GET", `/plans/${plan.id}/versions/1/diff/1`)).status).toBe(404);
    expect((await dentistB("PATCH", `/plans/${plan.id}`, { title: "x" })).status).toBe(404);
    expect((await dentistB("PATCH", `/plan-items/${item}`, { quantity: 2 })).status).toBe(404);
    expect((await dentistB("GET", `/plan-items/${item}/sessions`)).status).toBe(404);
    const create = await dentistB("POST", "/plans", {
      patientId: patient,
      branchId: w.b1,
      title: "x",
    });
    expect(create.status).toBe(404);
    expect((await dentistB("GET", "/plans")).body.items).toEqual([]);
  });

  test("list pages with a cursor", async () => {
    const pt = await seedPatient(w.h, w.tA, w.a1, "Paged");
    for (let i = 0; i < 3; i++) await newPlan([{ serviceId: svcA }], dentist, pt);
    const p1 = await dentist("GET", `/plans?patientId=${pt}&limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeString();
    const p2 = await dentist("GET", `/plans?patientId=${pt}&limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect(p1.body.items[0].totals.estimatePaise).toBe(50_000);
  });

  test("merged patients: lineage reads, writes refused with patient_merged", async () => {
    const survivor = await seedPatient(w.h, w.tA, w.a1, "Survivor");
    const merged = await seedPatient(w.h, w.tA, w.a1, "Merged");
    const plan = await newPlan([{ serviceId: svcA }], dentist, merged);
    await w.h.admin.patient.update({
      where: { id: merged },
      data: { mergedIntoId: survivor, mergedAt: new Date() },
    });
    const list = await dentist("GET", `/plans?patientId=${survivor}`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(plan.id);
    const create = await dentist("POST", "/plans", {
      patientId: merged,
      branchId: w.a1,
      title: "x",
    });
    expect(create.status).toBe(409);
    expect(create.body).toMatchObject({ error: "patient_merged", survivorId: survivor });
    const edit = await dentist("PATCH", `/plans/${plan.id}`, { title: "x" });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe("patient_merged");
  });

  test("validation: bad ids and bodies are 400", async () => {
    expect((await dentist("GET", "/plans/not-a-uuid")).status).toBe(400);
    expect((await dentist("POST", "/plans", { patientId: patient, title: "x" })).status).toBe(400);
    const plan = await newPlan([]);
    expect((await dentist("GET", `/plans/${plan.id}/versions/0`)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// Wave 1 review regressions (cross-branch links, closed plans / items, decisions, audit, cursor)
// ---------------------------------------------------------------------------------------------

describe("review regressions", () => {
  async function acceptedItem(items: unknown[] = [{ serviceId: svcA }]) {
    const plan = await presented(items);
    const ids = plan.items.map((i: { id: string }) => i.id);
    const d = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: ids.map((itemId: string) => ({ itemId, decision: "ACCEPTED" })),
    });
    expect(d.status).toBe(200);
    return { plan: d.body, itemId: ids[0] as string, ids: ids as string[] };
  }
  const planRow = (id: string) => w.h.admin.treatmentPlan.findUniqueOrThrow({ where: { id } });
  const itemRow = (id: string) => w.h.admin.planItem.findUniqueOrThrow({ where: { id } });

  test("session links to an out-of-scope appointment answer 404 and never write it", async () => {
    const { itemId } = await acceptedItem();
    const apptA2 = await seedAppointment(w.h, w.tA, patient, w.a2);
    const r = await dentist("POST", `/plan-items/${itemId}/sessions`, { appointmentId: apptA2 });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("appointment_not_found");
    const s = await dentist("POST", `/plan-items/${itemId}/sessions`, {});
    const u = await dentist("PATCH", `/plan-item-sessions/${s.body.id}`, { appointmentId: apptA2 });
    expect(u.status).toBe(404);
    expect(u.body.error).toBe("appointment_not_found");
    const appt = await w.h.admin.appointment.findUniqueOrThrow({ where: { id: apptA2 } });
    expect(appt.planItemId).toBeNull();
    expect((await itemRow(itemId)).status).toBe("ACCEPTED");
    // Out-of-scope appointment of ANOTHER patient: same 404 (no existence / patient oracle).
    const foreignA2 = await seedAppointment(w.h, w.tA, otherPatient, w.a2);
    const f = await dentist("POST", `/plan-items/${itemId}/sessions`, { appointmentId: foreignA2 });
    expect(f.status).toBe(404);
    expect(f.body.error).toBe("appointment_not_found");
  });

  test("session links to an out-of-scope encounter answer 404 and never move the item", async () => {
    const { plan, itemId } = await acceptedItem();
    const encA2 = await seedEncounter(w.h, w.tA, patient, w.a2, w.users.dentistA2, true);
    const r = await dentist("POST", `/plan-items/${itemId}/sessions`, { encounterId: encA2 });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("encounter_not_found");
    const s = await dentist("POST", `/plan-items/${itemId}/sessions`, {});
    const u = await dentist("PATCH", `/plan-item-sessions/${s.body.id}`, { encounterId: encA2 });
    expect(u.status).toBe(404);
    expect(u.body.error).toBe("encounter_not_found");
    expect((await itemRow(itemId)).status).toBe("ACCEPTED");
    expect((await planRow(plan.id)).currentVersion).toBe(plan.currentVersion);
  });

  test("POST /plans: out-of-scope encounter is 404 whatever its patient", async () => {
    const encA2 = await seedEncounter(w.h, w.tA, patient, w.a2, w.users.dentistA2);
    const encA2Other = await seedEncounter(w.h, w.tA, otherPatient, w.a2, w.users.dentistA2);
    for (const encounterId of [encA2, encA2Other]) {
      const r = await dentist("POST", "/plans", {
        patientId: patient,
        branchId: w.a1,
        title: "x",
        encounterId,
      });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("encounter_not_found");
    }
    const encA1 = await seedEncounter(w.h, w.tA, patient, w.a1, w.users.dentist);
    const ok = await dentist("POST", "/plans", {
      patientId: patient,
      branchId: w.a1,
      title: "x",
      encounterId: encA1,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.encounterId).toBe(encA1);
  });

  test("notes-only PATCH on a cancelled plan never re-derives, moves the item or versions", async () => {
    // Appointment variant.
    const a = await acceptedItem();
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const s = await dentist("POST", `/plan-items/${a.itemId}/sessions`, { appointmentId: appt });
    expect(s.body.status).toBe("SCHEDULED");
    const c = await dentist("POST", `/plans/${a.plan.id}/cancel`, { reason: "patient moved" });
    expect(c.status).toBe(200);
    const before = await planRow(a.plan.id);
    const itemBefore = (await itemRow(a.itemId)).status;
    await w.h.admin.appointment.update({
      where: { id: appt },
      data: { status: "CANCELLED", cancelReason: "test" },
    });
    const n = await dentist("PATCH", `/plan-item-sessions/${s.body.id}`, { notes: "just a note" });
    expect(n.status).toBe(200);
    expect(n.body.notes).toBe("just a note");
    const after = await planRow(a.plan.id);
    expect(after.status).toBe("CANCELLED");
    expect(after.currentVersion).toBe(before.currentVersion);
    expect((await itemRow(a.itemId)).status).toBe(itemBefore);

    // Encounter variant: the open encounter is signed after the plan is cancelled.
    const b = await acceptedItem();
    const enc = await seedEncounter(w.h, w.tA, patient, w.a1, w.users.dentist);
    const s2 = await dentist("POST", `/plan-items/${b.itemId}/sessions`, { encounterId: enc });
    expect(s2.body.status).toBe("PLANNED");
    await dentist("POST", `/plans/${b.plan.id}/cancel`, { reason: "patient moved" });
    const v = (await planRow(b.plan.id)).currentVersion;
    await w.h.admin.encounter.update({
      where: { id: enc },
      data: { status: "SIGNED", signedAt: new Date(), signedBy: w.users.dentist },
    });
    const n2 = await dentist("PATCH", `/plan-item-sessions/${s2.body.id}`, { notes: "n" });
    expect(n2.status).toBe(200);
    expect(n2.body.status).not.toBe("COMPLETED");
    expect((await planRow(b.plan.id)).currentVersion).toBe(v);
    expect((await itemRow(b.itemId)).status).toBe("ACCEPTED");
  });

  test("cancelling a plan cancels its open sessions", async () => {
    const { plan, itemId } = await acceptedItem();
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const s1 = await dentist("POST", `/plan-items/${itemId}/sessions`, { appointmentId: appt });
    const s2 = await dentist("POST", `/plan-items/${itemId}/sessions`, {});
    await dentist("POST", `/plans/${plan.id}/cancel`, { reason: "patient moved" });
    const list = await dentist("GET", `/plan-items/${itemId}/sessions`);
    expect(list.body.items.map((x: { status: string }) => x.status)).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);
    expect([s1.body.id, s2.body.id]).toEqual(list.body.items.map((x: { id: string }) => x.id));
  });

  test("decisions cannot move a SCHEDULED item (no undo through the decisions endpoint)", async () => {
    const { plan, itemId } = await acceptedItem();
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    await dentist("POST", `/plan-items/${itemId}/sessions`, { appointmentId: appt });
    expect((await itemRow(itemId)).status).toBe("SCHEDULED");
    for (const decision of ["ACCEPTED", "DEFERRED", "REJECTED"]) {
      const r = await dentist("POST", `/plans/${plan.id}/decisions`, {
        decisions: [{ itemId, decision, reason: "patient changed mind" }],
      });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: "invalid_transition", from: "SCHEDULED" });
      expect(r.body.allowed).toEqual([]);
    }
    expect((await itemRow(itemId)).status).toBe("SCHEDULED");
    // ACCEPTED -> DEFERRED stays a valid patient decision.
    const other = await acceptedItem();
    const d = await dentist("POST", `/plans/${other.plan.id}/decisions`, {
      decisions: [{ itemId: other.itemId, decision: "DEFERRED", reason: "later" }],
    });
    expect(d.status).toBe(200);
    expect(d.body.items[0].status).toBe("DEFERRED");
  });

  test("cancelling an item cancels its open sessions; closed items refuse session progress", async () => {
    // A third accepted item keeps the plan open (not derived COMPLETED) throughout.
    const { ids } = await acceptedItem([
      { serviceId: svcA },
      { serviceId: svcB },
      { serviceId: svcA },
    ]);
    const [i1, i2] = ids as [string, string];
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const s1 = await dentist("POST", `/plan-items/${i1}/sessions`, { appointmentId: appt });
    expect(s1.body.status).toBe("SCHEDULED");
    const cx = await dentist("POST", `/plan-items/${i1}/status`, {
      to: "CANCELLED",
      reason: "withdrawn",
    });
    expect(cx.status).toBe(200);
    const list = await dentist("GET", `/plan-items/${i1}/sessions`);
    expect(list.body.items[0].status).toBe("CANCELLED");
    const done = await dentist("POST", `/plan-item-sessions/${s1.body.id}/complete`);
    expect(done.status).toBe(409);

    // A COMPLETED item: its leftover PLANNED session is withdrawn with it; notes only after that.
    const s2 = await dentist("POST", `/plan-items/${i2}/sessions`, {});
    await dentist("POST", `/plan-items/${i2}/status`, { to: "IN_PROGRESS" });
    expect((await dentist("POST", `/plan-items/${i2}/status`, { to: "COMPLETED" })).status).toBe(
      200,
    );
    const c2 = await dentist("POST", `/plan-item-sessions/${s2.body.id}/complete`);
    expect(c2.status).toBe(409);
    expect(c2.body).toMatchObject({ error: "invalid_transition", from: "CANCELLED" });
    const appt2 = await seedAppointment(w.h, w.tA, patient, w.a1);
    const l2 = await dentist("PATCH", `/plan-item-sessions/${s2.body.id}`, {
      appointmentId: appt2,
    });
    expect(l2.status).toBe(409);
    expect(l2.body.error).toBe("session_closed");
    expect(
      (await w.h.admin.appointment.findUniqueOrThrow({ where: { id: appt2 } })).planItemId,
    ).toBeNull();
    const n = await dentist("PATCH", `/plan-item-sessions/${s2.body.id}`, { notes: "ok" });
    expect(n.status).toBe(200);
    expect(n.body.status).toBe("CANCELLED");
  });

  test("an appointment bound to one item cannot be linked from another item's session", async () => {
    // A third accepted item keeps the plan open throughout.
    const { ids } = await acceptedItem([
      { serviceId: svcA },
      { serviceId: svcB },
      { serviceId: svcA },
    ]);
    const [iA, iB] = ids as [string, string];
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const sA = await dentist("POST", `/plan-items/${iA}/sessions`, { appointmentId: appt });
    expect(sA.status).toBe(201);
    expect(sA.body.status).toBe("SCHEDULED");

    const create = await dentist("POST", `/plan-items/${iB}/sessions`, { appointmentId: appt });
    expect(create.status).toBe(409);
    expect(create.body).toMatchObject({
      error: "appointment_linked_elsewhere",
      field: "appointmentId",
    });
    const sB = await dentist("POST", `/plan-items/${iB}/sessions`, {});
    expect(sB.status).toBe(201);
    const patch = await rec("PATCH", `/plan-item-sessions/${sB.body.id}`, { appointmentId: appt });
    expect(patch.status).toBe(403); // receptionist has no plan:write (unchanged)
    const patch2 = await dentist("PATCH", `/plan-item-sessions/${sB.body.id}`, {
      appointmentId: appt,
    });
    expect(patch2.status).toBe(409);
    expect(patch2.body.error).toBe("appointment_linked_elsewhere");

    // Booked for item A from the scheduling side (Appointment.planItemId only): same refusal.
    const booked = await seedAppointment(w.h, w.tA, patient, w.a1);
    await w.h.admin.appointment.update({ where: { id: booked }, data: { planItemId: iA } });
    const viaScheduling = await dentist("POST", `/plan-items/${iB}/sessions`, {
      appointmentId: booked,
    });
    expect(viaScheduling.status).toBe(409);
    expect(viaScheduling.body.error).toBe("appointment_linked_elsewhere");

    expect(
      (await w.h.admin.appointment.findUniqueOrThrow({ where: { id: appt } })).planItemId,
    ).toBe(iA);
    expect((await itemRow(iB)).status).toBe("ACCEPTED");
    const list = await dentist("GET", `/plan-items/${iB}/sessions`);
    expect(list.body.items.map((x: { status: string }) => x.status)).toEqual(["PLANNED"]);
    // Two sessions of the SAME item may share the appointment.
    const sA2 = await dentist("POST", `/plan-items/${iA}/sessions`, { appointmentId: appt });
    expect(sA2.status).toBe(201);
  });

  test("booking undo and patient defer are refused while the item is still booked", async () => {
    const { plan, ids } = await acceptedItem([{ serviceId: svcA }, { serviceId: svcB }]);
    const [i1, i2] = ids as [string, string];
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const s = await dentist("POST", `/plan-items/${i1}/sessions`, { appointmentId: appt });
    expect(s.body.status).toBe("SCHEDULED");
    expect((await itemRow(i1)).status).toBe("SCHEDULED");

    const undo = await rec("POST", `/plan-items/${i1}/status`, { to: "ACCEPTED" });
    expect(undo.status).toBe(409);
    expect(undo.body).toMatchObject({
      error: "item_still_scheduled",
      scheduledSessions: 1,
      activeAppointments: 1,
    });
    expect((await itemRow(i1)).status).toBe("SCHEDULED");
    const v = (await planRow(plan.id)).currentVersion;

    // The appointment is cancelled in scheduling; the stale SCHEDULED session still blocks the
    // undo until it is re-derived (any PATCH), which itself moves the item back to ACCEPTED.
    await w.h.admin.appointment.update({
      where: { id: appt },
      data: { status: "CANCELLED", cancelReason: "test" },
    });
    const stale = await rec("POST", `/plan-items/${i1}/status`, { to: "ACCEPTED" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ scheduledSessions: 1, activeAppointments: 0 });
    expect((await planRow(plan.id)).currentVersion).toBe(v);
    const re = await dentist("PATCH", `/plan-item-sessions/${s.body.id}`, { notes: "re-derive" });
    expect(re.body.status).toBe("PLANNED");
    expect((await itemRow(i1)).status).toBe("ACCEPTED");
    const defer = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId: i1, decision: "DEFERRED", reason: "later" }],
    });
    expect(defer.status).toBe(200);

    // ACCEPTED item with an active appointment bound from scheduling: defer refused.
    const booked = await seedAppointment(w.h, w.tA, patient, w.a1);
    await w.h.admin.appointment.update({ where: { id: booked }, data: { planItemId: i2 } });
    const d2 = await dentist("POST", `/plans/${plan.id}/decisions`, {
      decisions: [{ itemId: i2, decision: "DEFERRED", reason: "later" }],
    });
    expect(d2.status).toBe(409);
    expect(d2.body).toMatchObject({ error: "item_still_scheduled", activeAppointments: 1 });
    expect((await itemRow(i2)).status).toBe("ACCEPTED");

    // Nothing booked any more -> the undo itself still works.
    await w.h.admin.appointment.update({
      where: { id: booked },
      data: { status: "CANCELLED", cancelReason: "test" },
    });
    await w.h.admin.planItem.update({ where: { id: i2 }, data: { status: "SCHEDULED" } });
    const ok = await rec("POST", `/plan-items/${i2}/status`, { to: "ACCEPTED" });
    expect(ok.status).toBe(200);
    expect((await itemRow(i2)).status).toBe("ACCEPTED");
  });

  test("completing an item: refused while a session is SCHEDULED; PLANNED ones are withdrawn", async () => {
    const { plan, itemId } = await acceptedItem();
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const s1 = await dentist("POST", `/plan-items/${itemId}/sessions`, { appointmentId: appt });
    const s2 = await dentist("POST", `/plan-items/${itemId}/sessions`, {});
    expect([s1.body.status, s2.body.status]).toEqual(["SCHEDULED", "PLANNED"]);
    expect(
      (await dentist("POST", `/plan-items/${itemId}/status`, { to: "IN_PROGRESS" })).status,
    ).toBe(200);
    const since = new Date(Date.now() - 1000);
    const early = await dentist("POST", `/plan-items/${itemId}/status`, { to: "COMPLETED" });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      error: "item_has_scheduled_sessions",
      scheduledSessions: 1,
    });
    expect((await itemRow(itemId)).status).toBe("IN_PROGRESS");

    expect((await dentist("POST", `/plan-item-sessions/${s1.body.id}/complete`)).status).toBe(200);
    const done = await dentist("POST", `/plan-items/${itemId}/status`, { to: "COMPLETED" });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("COMPLETED");
    const list = await dentist("GET", `/plan-items/${itemId}/sessions`);
    expect(list.body.items.map((x: { status: string }) => x.status)).toEqual([
      "COMPLETED",
      "CANCELLED",
    ]);
    expect(
      await w.h.admin.auditEvent.count({
        where: {
          tenantId: w.tA,
          action: "plan_item_session.cancel",
          resourceId: s2.body.id,
          createdAt: { gte: since },
        },
      }),
    ).toBe(1);
    expect((await planRow(plan.id)).status).toBe("COMPLETED");
  });

  test("unlinking, replacing or cancelling a session frees Appointment.planItemId", async () => {
    const { ids } = await acceptedItem([
      { serviceId: svcA },
      { serviceId: svcB },
      { serviceId: svcA },
    ]);
    const [iA, iB] = ids as [string, string];
    const apptRow = (id: string) => w.h.admin.appointment.findUniqueOrThrow({ where: { id } });
    const appt = await seedAppointment(w.h, w.tA, patient, w.a1);
    const s = await dentist("POST", `/plan-items/${iA}/sessions`, { appointmentId: appt });
    expect(s.body.status).toBe("SCHEDULED");
    const s2 = await dentist("POST", `/plan-items/${iA}/sessions`, { appointmentId: appt });

    // Another open session of the item still uses it -> stays bound.
    const un1 = await dentist("PATCH", `/plan-item-sessions/${s.body.id}`, { appointmentId: null });
    expect(un1.body.status).toBe("PLANNED");
    expect((await apptRow(appt)).planItemId).toBe(iA);
    expect((await itemRow(iA)).status).toBe("SCHEDULED");
    // Last one lets go -> freed; item back to ACCEPTED.
    const un2 = await dentist("PATCH", `/plan-item-sessions/${s2.body.id}`, {
      appointmentId: null,
    });
    expect(un2.body.status).toBe("PLANNED");
    expect((await apptRow(appt)).planItemId).toBeNull();
    expect((await itemRow(iA)).status).toBe("ACCEPTED");

    // The freed appointment can now serve another item.
    const sB = await dentist("POST", `/plan-items/${iB}/sessions`, { appointmentId: appt });
    expect(sB.status).toBe(201);
    expect(sB.body.status).toBe("SCHEDULED");
    expect((await apptRow(appt)).planItemId).toBe(iB);

    // Replace: the old appointment is freed, the new one bound.
    const appt2 = await seedAppointment(w.h, w.tA, patient, w.a1);
    const rep = await dentist("PATCH", `/plan-item-sessions/${sB.body.id}`, {
      appointmentId: appt2,
    });
    expect(rep.status).toBe(200);
    expect(rep.body.status).toBe("SCHEDULED");
    expect((await apptRow(appt)).planItemId).toBeNull();
    expect((await apptRow(appt2)).planItemId).toBe(iB);

    // Cancel: the session keeps its appointment id (history), the appointment is freed.
    const cx = await dentist("PATCH", `/plan-item-sessions/${sB.body.id}`, { status: "CANCELLED" });
    expect(cx.body).toMatchObject({ status: "CANCELLED", appointmentId: appt2 });
    expect((await apptRow(appt2)).planItemId).toBeNull();
    expect((await itemRow(iB)).status).toBe("ACCEPTED");
  });

  test("session list, plan consents and unfiltered plan list are audited (ids only)", async () => {
    const { plan, itemId } = await acceptedItem();
    const since = new Date(Date.now() - 1000);
    const count = (action: string, resourceId: string | null) =>
      w.h.admin.auditEvent.count({
        where: {
          tenantId: w.tA,
          actorId: w.users.dentist,
          action,
          resourceId,
          createdAt: { gte: since },
        },
      });
    expect((await dentist("GET", `/plan-items/${itemId}/sessions`)).status).toBe(200);
    expect(await count("plan_item_session.list", itemId)).toBe(1);
    expect((await dentist("GET", `/plans/${plan.id}/consents`)).status).toBe(200);
    expect(await count("plan.consents.read", plan.id)).toBe(1);
    expect((await dentist("GET", "/plans")).status).toBe(200);
    expect(await count("plan.list", null)).toBeGreaterThanOrEqual(1);
    const ev = await w.h.admin.auditEvent.findFirstOrThrow({
      where: { tenantId: w.tA, action: "plan_item_session.list", resourceId: itemId },
    });
    expect(ev.branchId).toBe(w.a1);
  });

  test("a crafted cursor with a non-uuid id is 400, not 500", async () => {
    const bad = Buffer.from("2020-01-01T00:00:00.000Z|not-a-uuid").toString("base64url");
    const r = await dentist("GET", `/plans?cursor=${bad}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("validation_failed");
  });
});
