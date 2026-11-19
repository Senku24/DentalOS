import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PrismaClient, withTenant } from "@dentalos/db";
import { clinicalContextResponse, encounterDetailResponse } from "@dentalos/validation";
import { clinicalGuardError } from "../common/db-errors";
import { type Harness, code, startHarness, uid } from "../org/test-harness";

// C1 clinical records API. Fresh random tenants per run; never deletes shared rows.
let h: Harness;
let app: PrismaClient; // app role (RLS + triggers + grants), for the DB-trigger paths
let tA: string;
let tB: string;
let a1: string;
let a2: string;
let b1: string;
let DENT1: string;
let DENT2: string;
let DENT_A2: string;
let DENT_NONE: string;
let REC: string;
let ACCT: string;
let OWNER: string;
let MANAGER: string;
let OWNER_B: string;
let DENT_B: string;

type Opts = { body?: unknown; tenant?: string };
const as = (user: string, method: string, path: string, o: Opts = {}) =>
  h.call(method, path, { user, tenant: o.tenant ?? tA, body: o.body });

const newPatient = async (tenantId = tA, branchId = a1) =>
  (
    await h.admin.patient.create({
      data: {
        tenantId,
        originBranchId: branchId,
        firstName: "Test",
        lastName: uid("p"),
        nameNormalized: `test ${randomUUID().slice(0, 8)}`,
        intakeType: "WALK_IN",
        createdBy: "seed",
      },
    })
  ).id;

let apptSeq = 0;
const newAppointment = async (patientId: string, branchId: string, status = "CHECKED_IN") => {
  const start = new Date(Date.UTC(2026, 10, 19, 3, 0) + apptSeq++ * 3_600_000);
  return (
    await h.admin.appointment.create({
      data: {
        tenantId: tA,
        patientId,
        branchId,
        appointmentType: "CHECKUP",
        startsAt: start,
        endsAt: new Date(start.getTime() + 30 * 60_000),
        status: status as "CHECKED_IN",
        checkedInAt: status === "CHECKED_IN" ? new Date() : null,
        createdBy: "seed",
      },
    })
  ).id;
};

const newDocument = async (patientId: string, branchId = a1) =>
  (
    await h.admin.patientDocument.create({
      data: {
        tenantId: tA,
        patientId,
        branchId,
        storageKey: `${tA}/test/${randomUUID()}`,
        fileName: "xray.png",
        contentType: "image/png",
        sizeBytes: 10,
        category: "XRAY",
        status: "AVAILABLE",
        uploadedBy: "seed",
      },
    })
  ).id;

const openWalkIn = async (patientId: string, user = DENT1, branchId = a1) => {
  const r = await as(user, "POST", "/encounters", { body: { patientId, branchId } });
  if (r.status !== 201) throw new Error(`open failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};

const sign = (id: string, user = DENT1) =>
  as(user, "POST", `/encounters/${id}/sign`, { body: { attest: true } });

const auditCount = (action: string, resourceId: string) =>
  h.admin.auditEvent.count({ where: { tenantId: tA, action, resourceId } });

beforeAll(async () => {
  h = await startHarness();
  app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  tA = await h.tenant("C1-A");
  tB = await h.tenant("C1-B");
  a1 = await h.branch(tA, code("CA"));
  a2 = await h.branch(tA, code("CB"));
  b1 = await h.branch(tB, code("CC"));
  DENT1 = await h.member(tA, ["DENTIST"], { branchScope: [a1] });
  DENT2 = await h.member(tA, ["DENTIST"], { branchScope: [a1] });
  DENT_A2 = await h.member(tA, ["DENTIST"], { branchScope: [a2] });
  DENT_NONE = await h.member(tA, ["DENTIST"], { branchScope: [] });
  REC = await h.member(tA, ["RECEPTIONIST"], { branchScope: [a1] });
  ACCT = await h.member(tA, ["ACCOUNTANT"], { branchScope: [a1] });
  OWNER = await h.member(tA, ["OWNER"], { orgWide: true });
  MANAGER = await h.member(tA, ["MANAGER"], { orgWide: true });
  OWNER_B = await h.member(tB, ["OWNER"], { orgWide: true });
  DENT_B = await h.member(tB, ["DENTIST"], { branchScope: [b1] });
});

afterAll(async () => {
  await app.$disconnect();
  await h.close();
});

describe("open encounters", () => {
  test("walk-in: treating dentist defaults to the opener, audited", async () => {
    const pt = await newPatient();
    const r = await as(DENT1, "POST", "/encounters", { body: { patientId: pt, branchId: a1 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      patientId: pt,
      branchId: a1,
      appointmentId: null,
      treatingDentistUserId: DENT1,
      openedBy: DENT1,
      status: "OPEN",
      signedAt: null,
    });
    expect(await auditCount("clinical.encounter.open", r.body.id)).toBe(1);
  });

  test("from a CHECKED_IN appointment: moves it to IN_CHAIR and writes an event", async () => {
    const pt = await newPatient();
    const appt = await newAppointment(pt, a1);
    const r = await as(DENT1, "POST", "/encounters", {
      body: { patientId: pt, branchId: a1, appointmentId: appt },
    });
    expect(r.status).toBe(201);
    expect(r.body.appointmentId).toBe(appt);
    const row = await h.admin.appointment.findUniqueOrThrow({ where: { id: appt } });
    expect(row.status).toBe("IN_CHAIR");
    const events = await h.admin.appointmentEvent.findMany({ where: { appointmentId: appt } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: "CHECKED_IN",
      toStatus: "IN_CHAIR",
      actorId: DENT1,
    });

    const again = await as(DENT1, "POST", "/encounters", {
      body: { patientId: pt, branchId: a1, appointmentId: appt },
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "encounter_exists", encounterId: r.body.id });
  });

  test("appointment of another branch is rejected (branch mismatch)", async () => {
    const pt = await newPatient();
    const appt = await newAppointment(pt, a2);
    const r = await as(DENT1, "POST", "/encounters", {
      body: { patientId: pt, branchId: a1, appointmentId: appt },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("appointment_branch_mismatch");
    const row = await h.admin.appointment.findUniqueOrThrow({ where: { id: appt } });
    expect(row.status).toBe("CHECKED_IN");
  });

  test("appointment of another patient / cancelled appointment are rejected", async () => {
    const pt = await newPatient();
    const other = await newPatient();
    const appt = await newAppointment(other, a1);
    const r = await as(DENT1, "POST", "/encounters", {
      body: { patientId: pt, branchId: a1, appointmentId: appt },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("appointment_patient_mismatch");

    const cancelled = await h.admin.appointment.create({
      data: {
        tenantId: tA,
        patientId: pt,
        branchId: a1,
        appointmentType: "CHECKUP",
        startsAt: new Date("2026-11-20T05:00:00Z"),
        endsAt: new Date("2026-11-20T05:30:00Z"),
        status: "CANCELLED",
        cancelReason: "patient called",
        createdBy: "seed",
      },
    });
    const c = await as(DENT1, "POST", "/encounters", {
      body: { patientId: pt, branchId: a1, appointmentId: cancelled.id },
    });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ error: "appointment_not_active", status: "CANCELLED" });
  });

  test("treating dentist must be a DENTIST member covering the branch", async () => {
    const pt = await newPatient();
    const cases: [string, string][] = [
      [REC, "not_a_dentist"],
      [DENT_A2, "dentist_not_in_branch"],
      ["nobody-here", "not_a_member"],
    ];
    for (const [user, error] of cases) {
      const r = await as(DENT1, "POST", "/encounters", {
        body: { patientId: pt, branchId: a1, treatingDentistUserId: user },
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(error);
    }
    // A DentistBranchAssignment alone does not count: the Principal (Membership.branchScope)
    // would give that dentist 403 on reading and signing the encounter, stranding it OPEN.
    await h.admin.dentistBranchAssignment.create({
      data: {
        tenantId: tA,
        userId: DENT_A2,
        branchId: a1,
        effectiveFrom: new Date("2020-01-01T00:00:00Z"),
        createdBy: "seed",
      },
    });
    const viaAssignment = await as(DENT1, "POST", "/encounters", {
      body: { patientId: pt, branchId: a1, treatingDentistUserId: DENT_A2 },
    });
    expect(viaAssignment.status).toBe(400);
    expect(viaAssignment.body.error).toBe("dentist_not_in_branch");
    const enc = await openWalkIn(pt);
    const handOver = await as(DENT1, "PATCH", `/encounters/${enc}`, {
      body: { treatingDentistUserId: DENT_A2 },
    });
    expect(handOver.status).toBe(400);
    expect(handOver.body.error).toBe("dentist_not_in_branch");
    expect(
      (await h.admin.encounter.findUniqueOrThrow({ where: { id: enc } })).treatingDentistUserId,
    ).toBe(DENT1);
    // An accepted treating dentist can always read and sign the encounter.
    const ok = await as(DENT1, "POST", "/encounters", {
      body: { patientId: await newPatient(), branchId: a1, treatingDentistUserId: DENT2 },
    });
    expect(ok.status).toBe(201);
    expect((await as(DENT2, "GET", `/encounters/${ok.body.id}`)).status).toBe(200);
    expect((await sign(ok.body.id, DENT2)).status).toBe(200);
  });

  test("merged patient takes no new encounter; lineage reads include it", async () => {
    const survivor = await newPatient();
    const merged = await newPatient();
    const enc = await openWalkIn(merged);
    await h.admin.patient.update({
      where: { id: merged },
      data: { mergedIntoId: survivor, mergedAt: new Date() },
    });
    const r = await as(DENT1, "POST", "/encounters", { body: { patientId: merged, branchId: a1 } });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "patient_merged", survivorId: survivor });

    const list = await as(DENT1, "GET", `/encounters?patientId=${survivor}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((e: { id: string }) => e.id)).toContain(enc);
  });
});

describe("permissions and tenancy", () => {
  let enc: string;
  beforeAll(async () => {
    enc = await openWalkIn(await newPatient());
  });

  test("receptionist and accountant get 403 on clinical reads and writes", async () => {
    const pt = await newPatient();
    for (const user of [REC, ACCT]) {
      expect((await as(user, "GET", `/encounters/${enc}`)).status).toBe(403);
      expect((await as(user, "GET", "/encounters")).status).toBe(403);
      expect((await as(user, "GET", `/patients/${pt}/odontogram`)).status).toBe(403);
      expect((await as(user, "GET", `/patients/${pt}/clinical-context`)).status).toBe(403);
      expect(
        (await as(user, "POST", "/encounters", { body: { patientId: pt, branchId: a1 } })).status,
      ).toBe(403);
      expect(
        (
          await as(user, "POST", `/encounters/${enc}/notes`, {
            body: { body: "x" },
          })
        ).status,
      ).toBe(403);
    }
  });

  test("owner/manager read but cannot write; out-of-branch dentist gets 403", async () => {
    for (const user of [OWNER, MANAGER]) {
      expect((await as(user, "GET", `/encounters/${enc}`)).status).toBe(200);
      expect(
        (await as(user, "POST", `/encounters/${enc}/notes`, { body: { body: "x" } })).status,
      ).toBe(403);
    }
    expect((await as(DENT_A2, "GET", `/encounters/${enc}`)).status).toBe(403);
    expect(
      (await as(DENT_A2, "POST", `/encounters/${enc}/notes`, { body: { body: "x" } })).status,
    ).toBe(403);
    expect(
      (
        await as(DENT_A2, "POST", "/encounters", {
          body: { patientId: await newPatient(), branchId: a1 },
        })
      ).status,
    ).toBe(403);
    // Lists only show the caller's branches.
    const list = await as(DENT_A2, "GET", "/encounters");
    expect(list.body.items.map((e: { id: string }) => e.id)).not.toContain(enc);
  });

  test("cross-tenant ids answer 404", async () => {
    const opts = { tenant: tB };
    expect((await as(OWNER_B, "GET", `/encounters/${enc}`, opts)).status).toBe(404);
    const w = await as(DENT_B, "POST", `/encounters/${enc}/notes`, {
      ...opts,
      body: { body: "x" },
    });
    expect(w.status).toBe(404);
    expect(w.body.error).toBe("encounter_not_found");
    const pt = await newPatient();
    expect((await as(OWNER_B, "GET", `/patients/${pt}/odontogram`, opts)).status).toBe(404);
    expect((await as(OWNER_B, "GET", `/patients/${pt}/clinical-context`, opts)).status).toBe(404);
  });
});

describe("notes, sign and amendments", () => {
  test("sign by a non-treating dentist is 403; treating dentist signs once", async () => {
    const enc = await openWalkIn(await newPatient());
    const n = await as(DENT1, "POST", `/encounters/${enc}/notes`, {
      body: { kind: "SUBJECTIVE", body: "Pain lower left" },
    });
    expect(n.status).toBe(201);
    const other = await sign(enc, DENT2);
    expect(other.status).toBe(403);
    expect(other.body.error).toBe("not_treating_dentist");
    expect((await as(DENT1, "POST", `/encounters/${enc}/sign`, { body: {} })).status).toBe(400);
    const s = await sign(enc);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: "SIGNED", signedBy: DENT1 });
    expect(await auditCount("clinical.encounter.sign", enc)).toBe(1);
    const again = await sign(enc);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("encounter_signed");
  });

  test("hand-over while OPEN changes who may sign", async () => {
    const enc = await openWalkIn(await newPatient());
    const u = await as(DENT1, "PATCH", `/encounters/${enc}`, {
      body: { treatingDentistUserId: DENT2 },
    });
    expect(u.status).toBe(200);
    expect(u.body.treatingDentistUserId).toBe(DENT2);
    expect((await sign(enc, DENT1)).status).toBe(403);
    expect((await sign(enc, DENT2)).status).toBe(200);
    const late = await as(DENT2, "PATCH", `/encounters/${enc}`, {
      body: { treatingDentistUserId: DENT1 },
    });
    expect(late.status).toBe(409);
  });

  test("editing a note after sign is 409 (service check and DB trigger)", async () => {
    const enc = await openWalkIn(await newPatient());
    const n = await as(DENT1, "POST", `/encounters/${enc}/notes`, { body: { body: "Draft" } });
    const u = await as(DENT1, "PATCH", `/encounters/${enc}/notes/${n.body.id}`, {
      body: { body: "Draft v2", kind: "ASSESSMENT" },
    });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ body: "Draft v2", kind: "ASSESSMENT" });
    expect((await sign(enc)).status).toBe(200);

    const after = await as(DENT1, "PATCH", `/encounters/${enc}/notes/${n.body.id}`, {
      body: { body: "sneaky" },
    });
    expect(after.status).toBe(409);
    expect(after.body.error).toBe("encounter_signed");
    expect(
      (await as(DENT1, "POST", `/encounters/${enc}/notes`, { body: { body: "late" } })).status,
    ).toBe(409);
    expect((await as(DENT1, "DELETE", `/encounters/${enc}/notes/${n.body.id}`)).status).toBe(409);

    // The DB trigger is the backstop even if a service skipped the check.
    let err: unknown;
    try {
      await withTenant(app, tA, (tx) =>
        tx.clinicalNote.update({ where: { id: n.body.id }, data: { body: "direct" } }),
      );
    } catch (e) {
      err = e;
    }
    expect(clinicalGuardError(err)).toBe("encounter_signed");
    const row = await h.admin.clinicalNote.findUniqueOrThrow({ where: { id: n.body.id } });
    expect(row.body).toBe("Draft v2");
  });

  test("amendment chain: append-only, reason required, only on SIGNED", async () => {
    const enc = await openWalkIn(await newPatient());
    const n = await as(DENT1, "POST", `/encounters/${enc}/notes`, {
      body: { body: "Dx: caries 36" },
    });
    const early = await as(DENT1, "POST", `/encounters/${enc}/amendments`, {
      body: { noteId: n.body.id, body: "x", reason: "typo" },
    });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe("encounter_not_signed");
    expect((await sign(enc)).status).toBe(200);

    expect(
      (
        await as(DENT1, "POST", `/encounters/${enc}/amendments`, {
          body: { noteId: n.body.id, body: "no reason" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as(OWNER, "POST", `/encounters/${enc}/amendments`, {
          body: { body: "x", reason: "owner" },
        })
      ).status,
    ).toBe(403);

    const a1r = await as(DENT2, "POST", `/encounters/${enc}/amendments`, {
      body: { noteId: n.body.id, body: "Dx: caries 37 (not 36)", reason: "wrong tooth" },
    });
    expect(a1r.status).toBe(201);
    expect(a1r.body).toMatchObject({ noteId: n.body.id, authorId: DENT2, reason: "wrong tooth" });
    const a2r = await as(DENT1, "POST", `/encounters/${enc}/amendments`, {
      body: { noteId: n.body.id, body: "Also mesial surface", reason: "omission" },
    });
    expect(a2r.status).toBe(201);
    const whole = await as(DENT1, "POST", `/encounters/${enc}/amendments`, {
      body: { body: "Diagnosis withdrawn", reason: "second opinion" },
    });
    expect(whole.status).toBe(201);
    expect(whole.body.noteId).toBeNull();
    const badNote = await as(DENT1, "POST", `/encounters/${enc}/amendments`, {
      body: { noteId: randomUUID(), body: "x", reason: "bad note" },
    });
    expect(badNote.status).toBe(404);

    const d = await as(DENT1, "GET", `/encounters/${enc}`);
    expect(d.status).toBe(200);
    expect(encounterDetailResponse.safeParse(d.body).success).toBe(true);
    expect(d.body.notes[0].body).toBe("Dx: caries 36");
    expect(d.body.notes[0].amendments.map((a: { id: string }) => a.id)).toEqual([
      a1r.body.id,
      a2r.body.id,
    ]);
    expect(d.body.amendments.map((a: { id: string }) => a.id)).toEqual([whole.body.id]);
    const list = await as(DENT1, "GET", `/encounters/${enc}/amendments`);
    expect(list.body.items).toHaveLength(3);
    expect(await auditCount("clinical.encounter.read", enc)).toBeGreaterThanOrEqual(1);

    // Amendments are append-only for the app role (no UPDATE grant).
    let err: unknown;
    try {
      await withTenant(app, tA, (tx) =>
        tx.clinicalNoteAmendment.update({ where: { id: a1r.body.id }, data: { body: "edit" } }),
      );
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/permission denied/i);
  });
});

describe("diagnoses and procedures", () => {
  test("diagnosis CRUD while OPEN, immutable after sign; FDI validated", async () => {
    const enc = await openWalkIn(await newPatient());
    const bad = await as(DENT1, "POST", `/encounters/${enc}/diagnoses`, {
      body: { code: "K02.1", label: "Caries", toothCode: 19 },
    });
    expect(bad.status).toBe(400);
    const badSurface = await as(DENT1, "POST", `/encounters/${enc}/diagnoses`, {
      body: { code: "K02.1", label: "Caries", toothCode: 11, surfaces: ["O"] },
    });
    expect(badSurface.status).toBe(400);
    const d = await as(DENT1, "POST", `/encounters/${enc}/diagnoses`, {
      body: { code: "K02.1", label: "Dentine caries", toothCode: 36, surfaces: ["O", "D"] },
    });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ toothCode: 36, surfaces: ["O", "D"], diagnosedBy: DENT1 });
    // Moving to an anterior tooth drops the old surfaces unless new valid ones are given.
    const moved = await as(DENT1, "PATCH", `/encounters/${enc}/diagnoses/${d.body.id}`, {
      body: { toothCode: 11 },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ toothCode: 11, surfaces: [] });
    const invalid = await as(DENT1, "PATCH", `/encounters/${enc}/diagnoses/${d.body.id}`, {
      body: { surfaces: ["O"] },
    });
    expect(invalid.status).toBe(400);
    const d2 = await as(DENT1, "POST", `/encounters/${enc}/diagnoses`, {
      body: { code: "K05", label: "Gingivitis" },
    });
    expect((await as(DENT1, "DELETE", `/encounters/${enc}/diagnoses/${d2.body.id}`)).status).toBe(
      204,
    );
    expect((await sign(enc)).status).toBe(200);
    const late = await as(DENT1, "PATCH", `/encounters/${enc}/diagnoses/${d.body.id}`, {
      body: { label: "x" },
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("encounter_signed");
  });

  test("procedure status table: IN_PROGRESS -> COMPLETED | ABANDONED, terminal otherwise", async () => {
    const enc = await openWalkIn(await newPatient());
    const ab = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { description: "Scaling", status: "ABANDONED" },
    });
    expect(ab.status).toBe(400);
    expect(ab.body.error).toBe("invalid_initial_status");
    expect(
      (await as(DENT1, "POST", `/encounters/${enc}/procedures`, { body: { toothCode: 36 } }))
        .status,
    ).toBe(400); // serviceId or description required
    const pr = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { description: "RCT", toothCode: 36, status: "IN_PROGRESS" },
    });
    expect(pr.status).toBe(201);
    const done = await as(DENT1, "PATCH", `/encounters/${enc}/procedures/${pr.body.id}`, {
      body: { status: "COMPLETED" },
    });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("COMPLETED");
    const back = await as(DENT1, "PATCH", `/encounters/${enc}/procedures/${pr.body.id}`, {
      body: { status: "ABANDONED" },
    });
    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({
      error: "invalid_transition",
      from: "COMPLETED",
      allowed: [],
    });
  });

  test("procedure on a plan item moves ACCEPTED -> IN_PROGRESS and versions the plan", async () => {
    const pt = await newPatient();
    const svc = await h.admin.service.create({
      data: {
        tenantId: tA,
        code: code("SV"),
        name: "Composite",
        durationMin: 30,
        basePricePaise: 150000,
      },
    });
    const plan = await h.admin.treatmentPlan.create({
      data: {
        tenantId: tA,
        patientId: pt,
        branchId: a1,
        title: "Restorations",
        status: "ACCEPTED",
        currentVersion: 1,
        presentedAt: new Date(),
        presentedBy: DENT1,
        createdBy: DENT1,
      },
    });
    const item = await h.admin.planItem.create({
      data: {
        tenantId: tA,
        planId: plan.id,
        patientId: pt,
        serviceId: svc.id,
        toothCode: 36,
        estimatePricePaise: 150000,
        priceSource: "BASE",
        status: "ACCEPTED",
        createdBy: DENT1,
      },
    });
    await h.admin.treatmentPlanVersion.create({
      data: {
        tenantId: tA,
        planId: plan.id,
        patientId: pt,
        version: 1,
        snapshot: {},
        createdBy: DENT1,
      },
    });
    const enc = await openWalkIn(pt);
    const other = await newPatient();
    const foreign = await as(DENT1, "POST", `/encounters/${await openWalkIn(other)}/procedures`, {
      body: { serviceId: svc.id, planItemId: item.id },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("invalid_plan_item");

    const pr = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { serviceId: svc.id, planItemId: item.id, toothCode: 36, surfaces: ["O"] },
    });
    expect(pr.status).toBe(201);
    expect(pr.body).toMatchObject({ planItemId: item.id, status: "COMPLETED" });
    const it = await h.admin.planItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(it.status).toBe("IN_PROGRESS");
    const pl = await h.admin.treatmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(pl.currentVersion).toBe(2);
    expect(pl.status).toBe("ACCEPTED");
    const v2 = await h.admin.treatmentPlanVersion.findFirstOrThrow({
      where: { planId: plan.id, version: 2 },
    });
    const snap = v2.snapshot as { items: { id: string; status: string }[] };
    expect(snap.items.find((i) => i.id === item.id)?.status).toBe("IN_PROGRESS");

    // A second completed procedure leaves an IN_PROGRESS item alone (never COMPLETED here).
    await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { serviceId: svc.id, planItemId: item.id },
    });
    expect((await h.admin.planItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      "IN_PROGRESS",
    );
    expect(
      (await h.admin.treatmentPlan.findUniqueOrThrow({ where: { id: plan.id } })).currentVersion,
    ).toBe(2);
  });
});

describe("odontogram", () => {
  test("charting supersedes history; snapshot shows CURRENT, history on request", async () => {
    const pt = await newPatient();
    const enc = await openWalkIn(pt);
    const c1 = await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: {
        encounterId: enc,
        records: [
          { toothCode: 36, condition: "CARIES", surfaces: ["O", "D"] },
          { toothCode: 55, condition: "SOUND" },
        ],
      },
    });
    expect(c1.status).toBe(201);
    expect(c1.body.items).toHaveLength(2);
    const old = c1.body.items[0];
    expect(old).toMatchObject({ dentition: "PERMANENT", status: "CURRENT", encounterId: enc });
    expect(c1.body.items[1].dentition).toBe("PRIMARY");

    const c2 = await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: {
        records: [
          { toothCode: 36, condition: "FILLED", surfaces: ["O", "D"], supersedesId: old.id },
        ],
      },
    });
    expect(c2.status).toBe(201);
    const mid = new Date().toISOString();

    const snap = await as(DENT1, "GET", `/patients/${pt}/odontogram`);
    expect(snap.status).toBe(200);
    const t36 = snap.body.records.filter((r: { toothCode: number }) => r.toothCode === 36);
    expect(t36).toHaveLength(1);
    expect(t36[0]).toMatchObject({ condition: "FILLED", status: "CURRENT" });

    const hist = await as(DENT1, "GET", `/patients/${pt}/odontogram?includeHistory=true`);
    const h36 = hist.body.records.filter((r: { toothCode: number }) => r.toothCode === 36);
    expect(h36).toHaveLength(2);
    const retired = h36.find((r: { id: string }) => r.id === old.id);
    expect(retired).toMatchObject({ status: "HISTORICAL", supersededBy: DENT1 });
    expect(retired.supersededAt).not.toBeNull();

    const asOfOld = await as(
      DENT1,
      "GET",
      `/patients/${pt}/odontogram?asOf=${encodeURIComponent(old.recordedAt)}`,
    );
    expect(
      asOfOld.body.records.filter((r: { toothCode: number }) => r.toothCode === 36)[0].condition,
    ).toBe("CARIES");
    const asOfNow = await as(
      DENT1,
      "GET",
      `/patients/${pt}/odontogram?asOf=${encodeURIComponent(mid)}`,
    );
    expect(
      asOfNow.body.records.filter((r: { toothCode: number }) => r.toothCode === 36)[0].condition,
    ).toBe("FILLED");

    // Superseding an already-retired row conflicts; wrong tooth is a 400.
    const twice = await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: { records: [{ toothCode: 36, condition: "CROWN", supersedesId: old.id }] },
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe("tooth_record_not_current");
    const wrongTooth = await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: { records: [{ toothCode: 37, condition: "CROWN", supersedesId: c2.body.items[0].id }] },
    });
    expect(wrongTooth.status).toBe(400);
    expect(wrongTooth.body.error).toBe("supersede_tooth_mismatch");

    // Retire without replacement.
    const sup = await as(DENT1, "POST", `/patients/${pt}/odontogram/supersede`, {
      body: { recordIds: [c1.body.items[1].id], reason: "charted in error" },
    });
    expect(sup.status).toBe(200);
    expect(sup.body.items[0].status).toBe("HISTORICAL");
    expect(await auditCount("clinical.odontogram.chart", pt)).toBe(2);
    expect(await auditCount("clinical.odontogram.read", pt)).toBeGreaterThanOrEqual(3);

    // Rows can only be superseded — the DB refuses any other edit.
    let err: unknown;
    try {
      await withTenant(app, tA, (tx) =>
        tx.toothRecord.update({ where: { id: c2.body.items[0].id }, data: { condition: "CROWN" } }),
      );
    } catch (e) {
      err = e;
    }
    expect(clinicalGuardError(err)).toBe("tooth_record_immutable");
  });

  test("invalid FDI codes and surfaces are 400", async () => {
    const pt = await newPatient();
    const bodies = [
      { toothCode: 19, condition: "CARIES" },
      { toothCode: 56, condition: "SOUND" },
      { toothCode: 11, condition: "CARIES", surfaces: ["O"] },
      { toothCode: 16, condition: "CARIES", surfaces: ["L"] },
      { toothCode: 36, condition: "MISSING", surfaces: ["O"] },
      { toothCode: 36, condition: "NOT_A_CONDITION" },
    ];
    for (const rec of bodies) {
      const r = await as(DENT1, "POST", `/patients/${pt}/odontogram`, { body: { records: [rec] } });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("validation_failed");
    }
  });

  test("never charts into a signed encounter or another patient's encounter", async () => {
    const pt = await newPatient();
    const enc = await openWalkIn(pt);
    expect((await sign(enc)).status).toBe(200);
    const r = await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: {
        encounterId: enc,
        records: [{ toothCode: 21, condition: "VENEER", surfaces: ["F"] }],
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("encounter_signed");
    const other = await openWalkIn(await newPatient());
    const m = await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: { encounterId: other, records: [{ toothCode: 21, condition: "SOUND" }] },
    });
    expect(m.status).toBe(400);
    expect(m.body.error).toBe("encounter_patient_mismatch");
  });
});

describe("encounter documents", () => {
  test("attach/detach a document of the same patient to an OPEN encounter only", async () => {
    const pt = await newPatient();
    const enc = await openWalkIn(pt);
    const doc = await newDocument(pt);
    const foreignDoc = await newDocument(await newPatient());

    const r = await as(DENT1, "POST", `/encounters/${enc}/documents`, {
      body: { documentId: doc },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: doc, encounterId: enc, patientId: pt });
    const list = await as(DENT1, "GET", `/encounters/${enc}/documents`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((d: { id: string }) => d.id)).toEqual([doc]);

    const wrong = await as(DENT1, "POST", `/encounters/${enc}/documents`, {
      body: { documentId: foreignDoc },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("document_patient_mismatch");
    expect(
      (await h.admin.patientDocument.findUniqueOrThrow({ where: { id: foreignDoc } })).encounterId,
    ).toBeNull();

    // Accountant: no clinical read. Receptionist: document:read but no clinical:read.
    expect((await as(ACCT, "GET", `/encounters/${enc}/documents`)).status).toBe(403);
    expect((await as(REC, "GET", `/encounters/${enc}/documents`)).status).toBe(403);

    expect((await as(DENT1, "DELETE", `/encounters/${enc}/documents/${doc}`)).status).toBe(204);
    expect((await as(DENT1, "GET", `/encounters/${enc}/documents`)).body.items).toHaveLength(0);
    expect(
      (await as(DENT1, "POST", `/encounters/${enc}/documents`, { body: { documentId: doc } }))
        .status,
    ).toBe(200);
  });

  test("attach to a signed encounter is 409 encounter_signed", async () => {
    const pt = await newPatient();
    const enc = await openWalkIn(pt);
    expect((await sign(enc)).status).toBe(200);
    const doc = await newDocument(pt);
    const r = await as(DENT1, "POST", `/encounters/${enc}/documents`, {
      body: { documentId: doc },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("encounter_signed");
    expect(
      (await h.admin.patientDocument.findUniqueOrThrow({ where: { id: doc } })).encounterId,
    ).toBeNull();
  });
});

describe("clinical context", () => {
  test("workspace context shape, lineage and gating", async () => {
    const pt = await newPatient();
    await h.admin.patientAllergy.create({
      data: {
        tenantId: tA,
        patientId: pt,
        substance: "Penicillin",
        severity: "CRITICAL",
        notedBy: "seed",
      },
    });
    await h.admin.patientAllergy.create({
      data: { tenantId: tA, patientId: pt, substance: "Latex", active: false, notedBy: "seed" },
    });
    await h.admin.patientAlert.create({
      data: {
        tenantId: tA,
        patientId: pt,
        title: "Anticoagulants",
        severity: "HIGH",
        createdBy: "seed",
      },
    });
    for (const version of [1, 2])
      await h.admin.patientMedicalHistory.create({
        data: { tenantId: tA, patientId: pt, version, recordedBy: "seed", notes: `v${version}` },
      });
    const signed = await openWalkIn(pt);
    expect((await sign(signed)).status).toBe(200);
    const open = await openWalkIn(pt);
    await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: { encounterId: open, records: [{ toothCode: 46, condition: "CROWN" }] },
    });
    const plan = await h.admin.treatmentPlan.create({
      data: { tenantId: tA, patientId: pt, branchId: a1, title: "Phase 1", createdBy: DENT1 },
    });

    const r = await as(DENT1, "GET", `/patients/${pt}/clinical-context?branchId=${a1}`);
    expect(r.status).toBe(200);
    const parsed = clinicalContextResponse.safeParse(r.body);
    expect(parsed.success).toBe(true);
    expect(r.body.patient.id).toBe(pt);
    expect(r.body.allergies.map((a: { substance: string }) => a.substance)).toEqual(["Penicillin"]);
    expect(r.body.alerts).toHaveLength(1);
    expect(r.body.latestMedicalHistory.version).toBe(2);
    expect(r.body.openEncounters.map((e: { id: string }) => e.id)).toEqual([open]);
    expect(r.body.recentEncounters.map((e: { id: string }) => e.id)).toEqual([signed]);
    expect(r.body.activePlans).toEqual([{ id: plan.id, title: "Phase 1", status: "DRAFT" }]);
    expect(r.body.odontogram.map((t: { toothCode: number }) => t.toothCode)).toEqual([46]);
    expect(await auditCount("clinical.context.read", pt)).toBe(1);

    // Owner reads (clinical:read org-wide); out-of-branch filter is a 403.
    expect((await as(OWNER, "GET", `/patients/${pt}/clinical-context`)).status).toBe(200);
    expect((await as(DENT1, "GET", `/patients/${pt}/clinical-context?branchId=${a2}`)).status).toBe(
      403,
    );
    // A dentist of another branch sees no encounters from a1.
    const otherBranch = await as(DENT_A2, "GET", `/patients/${pt}/clinical-context`);
    expect(otherBranch.status).toBe(200);
    expect(otherBranch.body.openEncounters).toHaveLength(0);
    expect(otherBranch.body.odontogram).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Verifier round: sign races, procedure/plan rules, authorship, hand-over, odontogram scope
// ---------------------------------------------------------------------------------------------

/**
 * Holds an uncommitted sign of `enc` on the admin connection while `during` runs; returns
 * whether `during`'s request finished before the sign committed, and its response.
 */
const withHeldSign = async <T>(enc: string, during: () => Promise<T>) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let held!: () => void;
  const isHeld = new Promise<void>((r) => {
    held = r;
  });
  const signer = h.admin.$transaction(
    async (tx) => {
      await tx.$executeRaw`UPDATE "Encounter" SET "status" = 'SIGNED', "signedAt" = now(),
        "signedBy" = "treatingDentistUserId" WHERE "id" = ${enc}::uuid`;
      held();
      await gate;
    },
    { timeout: 30_000 },
  );
  await isHeld;
  let finishedEarly = false;
  const req = during().then((r) => {
    finishedEarly = true;
    return r;
  });
  try {
    await Bun.sleep(500);
  } finally {
    release();
  }
  const early = finishedEarly;
  await signer;
  return { early, res: await req };
};

const newAcceptedPlanItem = async (pt: string) => {
  const svc = await h.admin.service.create({
    data: {
      tenantId: tA,
      code: code("SV"),
      name: "Crown",
      durationMin: 30,
      basePricePaise: 500000,
    },
  });
  const plan = await h.admin.treatmentPlan.create({
    data: {
      tenantId: tA,
      patientId: pt,
      branchId: a1,
      title: "Crowns",
      status: "ACCEPTED",
      currentVersion: 0,
      createdBy: DENT1,
    },
  });
  const item = await h.admin.planItem.create({
    data: {
      tenantId: tA,
      planId: plan.id,
      patientId: pt,
      serviceId: svc.id,
      estimatePricePaise: 500000,
      priceSource: "BASE",
      status: "ACCEPTED",
      createdBy: DENT1,
    },
  });
  return { svc: svc.id, item: item.id };
};

const itemStatus = async (id: string) =>
  (await h.admin.planItem.findUniqueOrThrow({ where: { id } })).status;

describe("verifier round", () => {
  test("attach waits for a concurrent sign, then answers 409 encounter_signed", async () => {
    const pt = await newPatient();
    const enc = await openWalkIn(pt);
    const doc = await newDocument(pt);
    const { early, res } = await withHeldSign(enc, () =>
      as(DENT1, "POST", `/encounters/${enc}/documents`, { body: { documentId: doc } }),
    );
    expect(early).toBe(false);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("encounter_signed");
    expect(
      (await h.admin.patientDocument.findUniqueOrThrow({ where: { id: doc } })).encounterId,
    ).toBeNull();
  });

  test("detach waits for a concurrent sign, then answers 409; the document stays attached", async () => {
    const pt = await newPatient();
    const enc = await openWalkIn(pt);
    const doc = await newDocument(pt);
    const a = await as(DENT1, "POST", `/encounters/${enc}/documents`, {
      body: { documentId: doc },
    });
    expect(a.status).toBe(200);
    const { early, res } = await withHeldSign(enc, () =>
      as(DENT1, "DELETE", `/encounters/${enc}/documents/${doc}`),
    );
    expect(early).toBe(false);
    expect(res.status).toBe(409);
    expect(
      (await h.admin.patientDocument.findUniqueOrThrow({ where: { id: doc } })).encounterId,
    ).toBe(enc);
  });

  test("procedure PATCH to its current status is 409 invalid_transition", async () => {
    const enc = await openWalkIn(await newPatient());
    const pr = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { description: "RCT", status: "IN_PROGRESS" },
    });
    const same = await as(DENT1, "PATCH", `/encounters/${enc}/procedures/${pr.body.id}`, {
      body: { status: "IN_PROGRESS" },
    });
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ error: "invalid_transition", from: "IN_PROGRESS" });
    const done = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { description: "Scaling" },
    });
    const again = await as(DENT1, "PATCH", `/encounters/${enc}/procedures/${done.body.id}`, {
      body: { status: "COMPLETED", notes: "x" },
    });
    expect(again.status).toBe(409);
    // A PATCH without status is still fine.
    const notes = await as(DENT1, "PATCH", `/encounters/${enc}/procedures/${done.body.id}`, {
      body: { notes: "uneventful" },
    });
    expect(notes.status).toBe(200);
  });

  test("only COMPLETED procedures start a plan item; those cannot be deleted", async () => {
    const pt = await newPatient();
    const { svc, item } = await newAcceptedPlanItem(pt);
    const enc = await openWalkIn(pt);

    // Started (IN_PROGRESS) work leaves the item alone, and may be deleted or abandoned.
    const started = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { serviceId: svc, planItemId: item, status: "IN_PROGRESS" },
    });
    expect(started.status).toBe(201);
    expect(await itemStatus(item)).toBe("ACCEPTED");
    expect(
      (await as(DENT1, "DELETE", `/encounters/${enc}/procedures/${started.body.id}`)).status,
    ).toBe(204);
    expect(await itemStatus(item)).toBe("ACCEPTED");
    const s2 = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { serviceId: svc, planItemId: item, status: "IN_PROGRESS" },
    });
    expect(
      (
        await as(DENT1, "PATCH", `/encounters/${enc}/procedures/${s2.body.id}`, {
          body: { status: "ABANDONED" },
        })
      ).status,
    ).toBe(200);
    expect(await itemStatus(item)).toBe("ACCEPTED");

    // Completing it moves the item; the completed procedure is then not deletable.
    const s3 = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { serviceId: svc, planItemId: item, status: "IN_PROGRESS" },
    });
    expect(
      (
        await as(DENT1, "PATCH", `/encounters/${enc}/procedures/${s3.body.id}`, {
          body: { status: "COMPLETED" },
        })
      ).status,
    ).toBe(200);
    expect(await itemStatus(item)).toBe("IN_PROGRESS");
    const del = await as(DENT1, "DELETE", `/encounters/${enc}/procedures/${s3.body.id}`);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: "procedure_linked_to_plan", planItemId: item });
  });

  test("planItemId must be linkable: readable plan branch, open plan, startable item", async () => {
    const pt = await newPatient();
    const svc = (await newAcceptedPlanItem(pt)).svc;
    const planItem = async (branchId: string, planStatus: string, itemStatus: string) => {
      const plan = await h.admin.treatmentPlan.create({
        data: {
          tenantId: tA,
          patientId: pt,
          branchId,
          title: "Linkable?",
          status: planStatus as "ACCEPTED",
          cancelReason: planStatus === "CANCELLED" ? "patient moved" : null,
          currentVersion: 0,
          createdBy: DENT1,
        },
      });
      return (
        await h.admin.planItem.create({
          data: {
            tenantId: tA,
            planId: plan.id,
            patientId: pt,
            serviceId: svc,
            estimatePricePaise: 1000,
            priceSource: "BASE",
            status: itemStatus as "ACCEPTED",
            createdBy: DENT1,
          },
        })
      ).id;
    };
    const enc = await openWalkIn(pt); // a1, DENT1
    const cases: [string, string, string, string][] = [
      [a1, "PRESENTED", "PROPOSED", "item_not_startable"],
      [a1, "ACCEPTED", "CANCELLED", "item_not_startable"],
      [a1, "CANCELLED", "ACCEPTED", "plan_closed"],
      [a2, "ACCEPTED", "ACCEPTED", "not_found"], // DENT1 has no plan:read at a2
    ];
    for (const [branchId, planStatus, initial, reason] of cases) {
      const item = await planItem(branchId, planStatus, initial);
      const r = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
        body: { serviceId: svc, planItemId: item },
      });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: "invalid_plan_item", reason });
      expect(String(await itemStatus(item))).toBe(initial);
      expect(await h.admin.procedureRecord.count({ where: { planItemId: item } })).toBe(0);
    }
  });

  test("a completed procedure blocks deletion only while it is the item's sole evidence", async () => {
    const pt = await newPatient();
    const { svc, item } = await newAcceptedPlanItem(pt);
    const enc = await openWalkIn(pt);
    const add = (status = "COMPLETED") =>
      as(DENT1, "POST", `/encounters/${enc}/procedures`, {
        body: { serviceId: svc, planItemId: item, status },
      });
    const first = await add();
    expect(await itemStatus(item)).toBe("IN_PROGRESS");
    // Multi-visit: a second completed procedure may link the IN_PROGRESS item.
    const second = await add();
    expect(second.status).toBe(201);
    expect(
      (await as(DENT1, "DELETE", `/encounters/${enc}/procedures/${second.body.id}`)).status,
    ).toBe(204);
    const del = await as(DENT1, "DELETE", `/encounters/${enc}/procedures/${first.body.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe("procedure_linked_to_plan");

    // The item never moved (cancelled before completion): the draft stays deletable.
    const pt2 = await newPatient();
    const p2 = await newAcceptedPlanItem(pt2);
    const enc2 = await openWalkIn(pt2);
    const started = await as(DENT1, "POST", `/encounters/${enc2}/procedures`, {
      body: { serviceId: p2.svc, planItemId: p2.item, status: "IN_PROGRESS" },
    });
    expect(started.status).toBe(201);
    await h.admin.planItem.update({ where: { id: p2.item }, data: { status: "CANCELLED" } });
    const done = await as(DENT1, "PATCH", `/encounters/${enc2}/procedures/${started.body.id}`, {
      body: { status: "COMPLETED" },
    });
    expect(done.status).toBe(200);
    expect(await itemStatus(p2.item)).toBe("CANCELLED");
    expect(
      (await as(DENT1, "DELETE", `/encounters/${enc2}/procedures/${started.body.id}`)).status,
    ).toBe(204);
  });

  test("only the author edits a draft; the author or treating dentist deletes it", async () => {
    const enc = await openWalkIn(await newPatient()); // DENT1 treating
    const note = await as(DENT1, "POST", `/encounters/${enc}/notes`, { body: { body: "D1" } });
    const rewrite = await as(DENT2, "PATCH", `/encounters/${enc}/notes/${note.body.id}`, {
      body: { body: "D2 rewrote" },
    });
    expect(rewrite.status).toBe(403);
    expect(rewrite.body.error).toBe("not_author");
    expect((await as(DENT2, "DELETE", `/encounters/${enc}/notes/${note.body.id}`)).status).toBe(
      403,
    );
    const row = await h.admin.clinicalNote.findUniqueOrThrow({ where: { id: note.body.id } });
    expect(row).toMatchObject({ body: "D1", authorId: DENT1 });

    const dx = await as(DENT1, "POST", `/encounters/${enc}/diagnoses`, {
      body: { code: "K02.1", label: "Caries of dentine" },
    });
    const dxEdit = await as(DENT2, "PATCH", `/encounters/${enc}/diagnoses/${dx.body.id}`, {
      body: { label: "changed" },
    });
    expect(dxEdit.status).toBe(403);
    const pr = await as(DENT1, "POST", `/encounters/${enc}/procedures`, {
      body: { description: "Scaling", status: "IN_PROGRESS" },
    });
    const prEdit = await as(DENT2, "PATCH", `/encounters/${enc}/procedures/${pr.body.id}`, {
      body: { status: "COMPLETED" },
    });
    expect(prEdit.status).toBe(403);
    expect(prEdit.body.error).toBe("not_author");

    // DENT2's own draft: DENT2 edits it; DENT1 (treating) may delete it but not edit it.
    const d2 = await as(DENT2, "POST", `/encounters/${enc}/notes`, { body: { body: "D2" } });
    expect(
      (
        await as(DENT2, "PATCH", `/encounters/${enc}/notes/${d2.body.id}`, {
          body: { body: "D2b" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await as(DENT1, "PATCH", `/encounters/${enc}/notes/${d2.body.id}`, { body: { body: "x" } }))
        .status,
    ).toBe(403);
    expect((await as(DENT1, "DELETE", `/encounters/${enc}/notes/${d2.body.id}`)).status).toBe(204);
  });

  test("hand-over only by the treating dentist or the opener", async () => {
    const enc = await openWalkIn(await newPatient()); // opened and treated by DENT1
    const grab = await as(DENT2, "PATCH", `/encounters/${enc}`, {
      body: { treatingDentistUserId: DENT2 },
    });
    expect(grab.status).toBe(403);
    expect(grab.body.error).toBe("not_treating_dentist");
    expect((await sign(enc, DENT2)).status).toBe(403);
    expect(
      (await h.admin.encounter.findUniqueOrThrow({ where: { id: enc } })).treatingDentistUserId,
    ).toBe(DENT1);

    // Opened by OWNER-less path: DENT2 opens for DENT1; the opener may still hand over.
    const pt = await newPatient();
    const o = await as(DENT2, "POST", "/encounters", {
      body: { patientId: pt, branchId: a1, treatingDentistUserId: DENT1 },
    });
    expect(o.status).toBe(201);
    const back = await as(DENT2, "PATCH", `/encounters/${o.body.id}`, {
      body: { treatingDentistUserId: DENT2 },
    });
    expect(back.status).toBe(200);
  });

  test("odontogram: other-branch encounter rows redacted; no-branch dentist gets 403", async () => {
    const pt = await newPatient();
    const enc = await openWalkIn(pt); // a1
    const c = await as(DENT1, "POST", `/patients/${pt}/odontogram`, {
      body: {
        encounterId: enc,
        records: [{ toothCode: 16, condition: "CARIES", surfaces: ["O"], notes: "SECRET-A1" }],
      },
    });
    expect(c.status).toBe(201);
    const rowId = c.body.items[0].id;

    // In scope: full row.
    const own = await as(DENT1, "GET", `/patients/${pt}/odontogram`);
    expect(own.body.records[0]).toMatchObject({ id: rowId, encounterId: enc, notes: "SECRET-A1" });

    // Other branch: the condition is visible (patient-level), the encounter detail is not.
    expect((await as(DENT_A2, "GET", `/encounters/${enc}`)).status).toBe(403);
    const other = await as(DENT_A2, "GET", `/patients/${pt}/odontogram`);
    expect(other.status).toBe(200);
    expect(other.body.records[0]).toMatchObject({
      id: rowId,
      condition: "CARIES",
      encounterId: null,
      notes: null,
    });
    const ctx = await as(DENT_A2, "GET", `/patients/${pt}/clinical-context`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.odontogram[0]).toMatchObject({ id: rowId, encounterId: null, notes: null });
    expect(ctx.body.openEncounters).toHaveLength(0);

    // Writes: charting inside the a1 encounter is checked at a1 (403); encounter-less charting
    // is patient-level (flagged for ADR 0003) and its rows carry no encounter.
    const intoA1 = await as(DENT_A2, "POST", `/patients/${pt}/odontogram`, {
      body: { encounterId: enc, records: [{ toothCode: 17, condition: "FILLED" }] },
    });
    expect(intoA1.status).toBe(403);
    const loose = await as(DENT_A2, "POST", `/patients/${pt}/odontogram`, {
      body: { records: [{ toothCode: 18, condition: "MISSING" }] },
    });
    expect(loose.status).toBe(201);
    expect(loose.body.items[0]).toMatchObject({ toothCode: 18, encounterId: null });
    const encA2Sup = await as(DENT_A2, "POST", `/patients/${pt}/odontogram/supersede`, {
      body: { encounterId: enc, recordIds: [rowId], reason: "charted in error" },
    });
    expect(encA2Sup.status).toBe(403);
    // Retiring a row charted inside the a1 encounter is checked at a1 too, with or without an
    // encounter of the caller's own, and by plain supersede or by a replacing chart row.
    const encA2 = await openWalkIn(pt, DENT_A2, a2);
    for (const encounterId of [undefined, encA2]) {
      const sup = await as(DENT_A2, "POST", `/patients/${pt}/odontogram/supersede`, {
        body: { encounterId, recordIds: [rowId], reason: "charted in error" },
      });
      expect(sup.status).toBe(403);
      const replace = await as(DENT_A2, "POST", `/patients/${pt}/odontogram`, {
        body: {
          encounterId,
          records: [{ toothCode: 16, condition: "SOUND", supersedesId: rowId }],
        },
      });
      expect(replace.status).toBe(403);
    }
    expect(await h.admin.toothRecord.count({ where: { patientId: pt, toothCode: 16 } })).toBe(1);
    // Encounter-less rows stay patient-level: an a1 dentist may retire the a2 dentist's row.
    const looseSup = await as(DENT1, "POST", `/patients/${pt}/odontogram/supersede`, {
      body: { recordIds: [loose.body.items[0].id], reason: "charted in error" },
    });
    expect(looseSup.status).toBe(200);
    expect(looseSup.body.items[0]).toMatchObject({ status: "HISTORICAL", supersededBy: DENT1 });

    // Org-wide reader sees it all.
    expect((await as(OWNER, "GET", `/patients/${pt}/odontogram`)).body.records[0].notes).toBe(
      "SECRET-A1",
    );

    // No branch at all: 403 on read, chart and supersede; empty chart in the context.
    expect((await as(DENT_NONE, "GET", `/patients/${pt}/odontogram`)).status).toBe(403);
    expect(
      (
        await as(DENT_NONE, "POST", `/patients/${pt}/odontogram`, {
          body: { records: [{ toothCode: 16, condition: "FILLED", supersedesId: rowId }] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(DENT_NONE, "POST", `/patients/${pt}/odontogram/supersede`, {
          body: { recordIds: [rowId], reason: "charted in error" },
        })
      ).status,
    ).toBe(403);
    const noneCtx = await as(DENT_NONE, "GET", `/patients/${pt}/clinical-context`);
    expect(noneCtx.status).toBe(200);
    expect(noneCtx.body.odontogram).toHaveLength(0);
    const still = await h.admin.toothRecord.findUniqueOrThrow({ where: { id: rowId } });
    expect(still.status).toBe("CURRENT");
  });
});
