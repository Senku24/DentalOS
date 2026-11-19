import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { zonedToUtc } from "@dentalos/validation";
import { type Harness, code, startHarness } from "../org/test-harness";
import { type DomainEvent, EventBus } from "../realtime/event-bus";
import { todayIn } from "./scheduling-common";

// S1 scheduling API against the real Postgres (app role, RLS). Fresh random tenants; never deletes
// shared rows. Each test books on its own future day so tests never collide with each other.

const TZ = "Asia/Kolkata";
let h: Harness;
let tA: string;
let tB: string;
let a1: string;
let a2: string;
let b1: string;
let OWNER: string;
let MANAGER: string;
let REC: string;
let REC2: string;
let DENT: string;
let DENT2: string;
let OWNER_B: string;
let chair1: string;
let chair2: string;
let patients: string[] = [];
const events: DomainEvent[] = [];

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const today = () => todayIn(TZ);
/** Branch-local wall clock on today + `offset` days -> ISO instant. */
const at = (offset: number, hh: number, mm = 0) =>
  zonedToUtc(addDays(today(), offset), hh * 60 + mm, TZ).toISOString();

/**
 * Check-in is same-day only, so tests that check in book today, inside a1's 09:00–18:00 hours, at
 * an hour at least four hours from now (walk-ins in this file use DENT at "now").
 */
const quietHour = () => {
  const local = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(
      new Date(),
    ),
  );
  return local >= 13 ? 9 : 17;
};

type Opts = { tenant?: string };
const api = (user: string, method: string, path: string, body?: unknown, o: Opts = {}) =>
  h.call(method, path, { user, tenant: o.tenant ?? tA, body });

async function patient(tenantId = tA, branchId = a1): Promise<string> {
  const p = await h.admin.patient.create({
    data: {
      tenantId,
      originBranchId: branchId,
      firstName: `Pat${code("")}`,
      nameNormalized: "pat",
      intakeType: "APPOINTMENT",
      createdBy: "seed",
    },
  });
  return p.id;
}

let nextPatient = 0;
const pat = () => {
  const p = patients[nextPatient++ % patients.length];
  if (!p) throw new Error("no patients");
  return p;
};

const book = (user: string, body: Record<string, unknown>, o: Opts = {}) =>
  api(user, "POST", "/appointments", { branchId: a1, durationMin: 30, ...body }, o);

beforeAll(async () => {
  h = await startHarness();
  h.app.get(EventBus).stream.subscribe((e) => events.push(e));
  tA = await h.tenant("S1-A");
  tB = await h.tenant("S1-B");
  a1 = await h.branch(tA);
  a2 = await h.branch(tA);
  b1 = await h.branch(tB);
  OWNER = await h.member(tA, ["OWNER"], { orgWide: true });
  MANAGER = await h.member(tA, ["MANAGER"], { branchScope: [a1] });
  REC = await h.member(tA, ["RECEPTIONIST"], { branchScope: [a1] });
  REC2 = await h.member(tA, ["RECEPTIONIST"], { branchScope: [a2] });
  DENT = await h.member(tA, ["DENTIST"], { branchScope: [a1, a2] });
  DENT2 = await h.member(tA, ["DENTIST"], { branchScope: [a1] });
  OWNER_B = await h.member(tB, ["OWNER"], { orgWide: true });
  for (const [userId, branchId] of [
    [DENT, a1],
    [DENT, a2],
    [DENT2, a1],
  ] as const)
    await h.admin.dentistBranchAssignment.create({
      data: {
        tenantId: tA,
        userId,
        branchId,
        effectiveFrom: new Date("2020-01-01T00:00:00Z"),
        createdBy: "seed",
      },
    });
  patients = await Promise.all(Array.from({ length: 12 }, () => patient()));

  // Branch a1 hours: every day 09:00–13:00 + 13:00–18:00 from today (adjacent sessions merge).
  const r = await api(OWNER, "PUT", "/working-hours", {
    scope: "BRANCH",
    branchId: a1,
    effectiveFrom: today(),
    sessions: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
      { weekday, startMinute: 540, endMinute: 780 },
      { weekday, startMinute: 780, endMinute: 1080 },
    ]),
  });
  expect(r.status).toBe(200);
  expect(r.body.items).toHaveLength(14);
});

afterAll(async () => {
  await h?.close();
});

describe("chairs", () => {
  test("CRUD + activate/deactivate, schedule:manage writes, branch-scoped reads", async () => {
    const c = await api(OWNER, "POST", "/chairs", {
      branchId: a1,
      code: "op-1",
      name: "Operatory 1",
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ branchId: a1, code: "OP-1", active: true });
    chair1 = c.body.id;
    const c2 = await api(MANAGER, "POST", "/chairs", { branchId: a1, code: "OP-2", name: "Op 2" });
    expect(c2.status).toBe(201);
    chair2 = c2.body.id;

    expect(
      (await api(OWNER, "POST", "/chairs", { branchId: a1, code: "OP-1", name: "x" })).body,
    ).toMatchObject({ error: "chair_code_taken" });
    expect(
      (await api(REC, "POST", "/chairs", { branchId: a1, code: "OP-9", name: "x" })).status,
    ).toBe(403);
    expect(
      (await api(MANAGER, "POST", "/chairs", { branchId: a2, code: "OP-9", name: "x" })).status,
    ).toBe(403);

    const list = await api(REC, "GET", `/chairs?branchId=${a1}`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { code: string }) => x.code)).toEqual(["OP-1", "OP-2"]);
    expect((await api(REC2, "GET", `/chairs?branchId=${a1}`)).status).toBe(403);
    expect((await api(REC2, "GET", "/chairs")).body.items).toHaveLength(0);
    expect((await api(REC2, "GET", `/chairs/${chair1}`)).status).toBe(403);
    expect((await api(OWNER_B, "GET", `/chairs/${chair1}`, undefined, { tenant: tB })).status).toBe(
      404,
    );

    const tmp = await api(OWNER, "POST", "/chairs", { branchId: a1, code: "TMP", name: "Temp" });
    const off = await api(OWNER, "POST", `/chairs/${tmp.body.id}/deactivate`);
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    expect((await api(REC, "GET", `/chairs?branchId=${a1}&active=true`)).body.items).toHaveLength(
      2,
    );
    const ren = await api(OWNER, "PATCH", `/chairs/${tmp.body.id}`, { name: "Renamed" });
    expect(ren.body).toMatchObject({ name: "Renamed", active: false });
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(5, 10), chairId: tmp.body.id })).body,
    ).toMatchObject({ error: "chair_inactive" });
    expect((await api(OWNER, "POST", `/chairs/${tmp.body.id}/activate`)).body.active).toBe(true);
    await api(OWNER, "POST", `/chairs/${tmp.body.id}/deactivate`);
  });
});

describe("working hours + settings", () => {
  test("list in force, replace from a date, past dates rejected", async () => {
    const list = await api(REC, "GET", `/working-hours?branchId=${a1}&scope=BRANCH`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(14);

    const future = addDays(today(), 60);
    const set = await api(OWNER, "PUT", "/working-hours", {
      scope: "BRANCH",
      branchId: a1,
      effectiveFrom: future,
      sessions: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMinute: 600,
        endMinute: 1020,
      })),
    });
    expect(set.status).toBe(200);
    // Today still has the old rows; from `future` the new ones; history shows both generations.
    expect(
      (await api(REC, "GET", `/working-hours?branchId=${a1}&scope=BRANCH`)).body.items[0],
    ).toMatchObject({ startMinute: 540, effectiveTo: future });
    const later = await api(REC, "GET", `/working-hours?branchId=${a1}&scope=BRANCH&on=${future}`);
    expect(later.body.items).toHaveLength(7);
    expect(later.body.items[0]).toMatchObject({ startMinute: 600, effectiveTo: null });
    // Replacing again from the same future date supersedes the not-yet-effective rows.
    await api(OWNER, "PUT", "/working-hours", {
      scope: "BRANCH",
      branchId: a1,
      effectiveFrom: future,
      sessions: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
        { weekday, startMinute: 540, endMinute: 780 },
        { weekday, startMinute: 780, endMinute: 1080 },
      ]),
    });
    const hist = await api(
      REC,
      "GET",
      `/working-hours?branchId=${a1}&scope=BRANCH&includeHistory=true`,
    );
    expect(hist.body.items).toHaveLength(28);

    const past = await api(OWNER, "PUT", "/working-hours", {
      scope: "BRANCH",
      branchId: a1,
      effectiveFrom: addDays(today(), -1),
      sessions: [],
    });
    expect(past.status).toBe(400);
    expect(
      (
        await api(REC, "PUT", "/working-hours", {
          scope: "BRANCH",
          branchId: a1,
          effectiveFrom: future,
          sessions: [],
        })
      ).status,
    ).toBe(403);
  });

  test("dentist/chair hours: validation and overlap across branches", async () => {
    const notAssigned = await api(OWNER, "PUT", "/working-hours", {
      scope: "DENTIST",
      branchId: a1,
      userId: REC,
      effectiveFrom: today(),
      sessions: [],
    });
    expect(notAssigned.body).toMatchObject({ error: "not_a_dentist" });

    const d1 = await api(OWNER, "PUT", "/working-hours", {
      scope: "DENTIST",
      branchId: a2,
      userId: DENT,
      effectiveFrom: addDays(today(), 200),
      sessions: [{ weekday: 1, startMinute: 540, endMinute: 720 }],
    });
    expect(d1.status).toBe(200);
    // Same dentist, overlapping Monday session at another branch -> exclusion constraint.
    const clash = await api(OWNER, "PUT", "/working-hours", {
      scope: "DENTIST",
      branchId: a1,
      userId: DENT,
      effectiveFrom: addDays(today(), 200),
      sessions: [{ weekday: 1, startMinute: 600, endMinute: 900 }],
    });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ error: "working_hours_overlap" });
    // Clean up DENT's future a2 hours (empty list = closed from that date).
    await api(OWNER, "PUT", "/working-hours", {
      scope: "DENTIST",
      branchId: a2,
      userId: DENT,
      effectiveFrom: addDays(today(), 200),
      sessions: [],
    });

    const foreignChair = await api(OWNER, "PUT", "/working-hours", {
      scope: "CHAIR",
      branchId: a2,
      chairId: chair1,
      effectiveFrom: today(),
      sessions: [],
    });
    expect(foreignChair.status).toBe(404);
  });

  test("scheduling settings: defaults, PATCH (schedule:manage), knobs enforced", async () => {
    const g = await api(REC, "GET", `/scheduling/settings?branchId=${a1}`);
    expect(g.body).toEqual({
      branchId: a1,
      noShowGraceMinutes: 15,
      slotMinutes: 15,
      allowUnassignedDentist: true,
      allowOutsideHoursBooking: true,
    });
    expect(
      (await api(REC, "PATCH", `/scheduling/settings?branchId=${a1}`, { slotMinutes: 30 })).status,
    ).toBe(403);
    const p = await api(MANAGER, "PATCH", `/scheduling/settings?branchId=${a1}`, {
      allowUnassignedDentist: false,
    });
    expect(p.body).toMatchObject({ allowUnassignedDentist: false, noShowGraceMinutes: 15 });
    const noDentist = await book(REC, { patientId: pat(), startsAt: at(6, 10) });
    expect(noDentist.status).toBe(400);
    expect(noDentist.body).toMatchObject({ error: "dentist_required" });
    await api(MANAGER, "PATCH", `/scheduling/settings?branchId=${a1}`, {
      allowUnassignedDentist: true,
    });
    const stored = await h.admin.branch.findUniqueOrThrow({ where: { id: a1 } });
    expect(stored.settings).toMatchObject({ scheduling: { allowUnassignedDentist: true } });
  });
});

describe("booking", () => {
  test("book: 201, creation event, detail with history, dentist validation", async () => {
    const r = await book(REC, {
      patientId: pat(),
      startsAt: at(10, 9, 30),
      dentistUserId: DENT,
      chairId: chair1,
      appointmentType: "CHECKUP",
      notes: "first visit",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: "BOOKED",
      dentistUserId: DENT,
      chairId: chair1,
      endsAt: at(10, 10),
      source: "SCHEDULED",
      createdBy: REC,
      outsideHoursReason: null,
    });
    const d = await api(DENT, "GET", `/appointments/${r.body.id}`);
    expect(d.status).toBe(200);
    expect(d.body.events).toHaveLength(1);
    expect(d.body.events[0]).toMatchObject({ fromStatus: null, toStatus: "BOOKED", actorId: REC });
    expect(d.body.patient.id).toBe(r.body.patientId);

    expect(
      (await book(REC, { patientId: pat(), startsAt: at(10, 11), dentistUserId: REC2 })).body,
    ).toMatchObject({ error: "not_a_dentist" });
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(10, 11), dentistUserId: "ghost" })).body,
    ).toMatchObject({ error: "not_a_member" });
    const dent3 = await h.member(tA, ["DENTIST"], { branchScope: [a1] });
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(10, 11), dentistUserId: dent3 })).body,
    ).toMatchObject({ error: "dentist_not_assigned" });
    expect((await book(REC, { patientId: randomUUID(), startsAt: at(10, 11) })).status).toBe(404);
    // DENTIST has no appointment:write (ADR 0003 §5).
    expect((await book(DENT, { patientId: pat(), startsAt: at(10, 11) })).status).toBe(403);
  });

  test("concurrent double booking of a dentist: exactly one 201, one 409 slot_conflict", async () => {
    const startsAt = at(11, 10);
    const [x, y] = await Promise.all([
      book(REC, { patientId: pat(), startsAt, dentistUserId: DENT }),
      book(REC, { patientId: pat(), startsAt, dentistUserId: DENT }),
    ]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.body).toMatchObject({ error: "slot_conflict", resource: "dentist" });
    // Partial overlap is also a conflict.
    const overlap = await book(REC, {
      patientId: pat(),
      startsAt: at(11, 10, 15),
      dentistUserId: DENT,
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.resource).toBe("dentist");
  });

  test("concurrent double booking of a chair: exactly one 201, one 409 slot_conflict", async () => {
    const startsAt = at(12, 10);
    const results = await Promise.all([
      book(REC, { patientId: pat(), startsAt, chairId: chair2 }),
      book(REC, { patientId: pat(), startsAt, chairId: chair2, dentistUserId: DENT2 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({
      error: "slot_conflict",
      resource: "chair",
    });
  });

  test("back-to-back slots are allowed (half-open ranges)", async () => {
    const a = await book(REC, {
      patientId: pat(),
      startsAt: at(13, 10),
      dentistUserId: DENT,
      chairId: chair1,
    });
    const b = await book(REC, {
      patientId: pat(),
      startsAt: at(13, 10, 30),
      dentistUserId: DENT,
      chairId: chair1,
    });
    const c = await book(REC, {
      patientId: pat(),
      startsAt: at(13, 9, 30),
      dentistUserId: DENT,
      chairId: chair1,
    });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
  });

  test("a cancelled slot is reusable; cancel needs a reason", async () => {
    const a = await book(REC, {
      patientId: pat(),
      startsAt: at(14, 11),
      dentistUserId: DENT,
      chairId: chair1,
    });
    expect((await api(REC, "POST", `/appointments/${a.body.id}/cancel`, {})).status).toBe(400);
    expect(
      (await api(REC, "POST", `/appointments/${a.body.id}/cancel`, { reason: "x" })).status,
    ).toBe(400);
    const c = await api(REC, "POST", `/appointments/${a.body.id}/cancel`, {
      reason: "Patient called",
    });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "CANCELLED", cancelReason: "Patient called" });
    const again = await book(REC, {
      patientId: pat(),
      startsAt: at(14, 11),
      dentistUserId: DENT,
      chairId: chair1,
    });
    expect(again.status).toBe(201);
    // Cancelling twice is an invalid transition.
    const twice = await api(REC, "POST", `/appointments/${a.body.id}/cancel`, { reason: "again" });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({
      error: "invalid_transition",
      from: "CANCELLED",
      to: "CANCELLED",
      allowed: [],
    });
  });

  test("merged patient -> 409 patient_merged with survivorId", async () => {
    const survivor = await patient();
    const merged = await patient();
    await h.admin.patient.update({
      where: { id: merged },
      data: { mergedIntoId: survivor, mergedAt: new Date() },
    });
    const r = await book(REC, { patientId: merged, startsAt: at(15, 10) });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "patient_merged", survivorId: survivor });
  });
});

describe("reschedule", () => {
  test("history chain: old RESCHEDULED first, successor linked, events on both", async () => {
    const a = await book(REC, {
      patientId: pat(),
      startsAt: at(20, 10),
      dentistUserId: DENT,
      chairId: chair1,
    });
    expect(a.status).toBe(201);
    // Overlapping its own old slot works because the old row is marked RESCHEDULED first.
    const b = await api(REC, "POST", `/appointments/${a.body.id}/reschedule`, {
      startsAt: at(20, 10, 15),
      reason: "Patient running late",
    });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({
      rescheduledFromId: a.body.id,
      status: "BOOKED",
      dentistUserId: DENT,
      chairId: chair1,
      startsAt: at(20, 10, 15),
      endsAt: at(20, 10, 45),
    });
    const c = await api(REC, "POST", `/appointments/${b.body.id}/reschedule`, {
      startsAt: at(21, 15),
      durationMin: 60,
      chairId: null,
      reason: "Moved to next day",
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({
      rescheduledFromId: b.body.id,
      chairId: null,
      endsAt: at(21, 16),
    });

    const oldA = await api(REC, "GET", `/appointments/${a.body.id}`);
    expect(oldA.body).toMatchObject({
      status: "RESCHEDULED",
      rescheduledToId: b.body.id,
      startsAt: at(20, 10),
    });
    expect(oldA.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      "BOOKED",
      "RESCHEDULED",
    ]);
    expect(oldA.body.events[1]).toMatchObject({
      fromStatus: "BOOKED",
      reason: "Patient running late",
      actorId: REC,
    });
    const ev = await api(REC, "GET", `/appointments/${c.body.id}/events`);
    expect(ev.body.items).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: "BOOKED",
        reason: "Moved to next day",
      }),
    ]);

    const again = await api(REC, "POST", `/appointments/${a.body.id}/reschedule`, {
      startsAt: at(22, 10),
      reason: "again",
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      error: "invalid_transition",
      from: "RESCHEDULED",
      to: "RESCHEDULED",
    });
    // The original slot is free again.
    expect(
      (
        await book(REC, {
          patientId: pat(),
          startsAt: at(20, 10),
          dentistUserId: DENT,
          chairId: chair1,
        })
      ).status,
    ).toBe(201);
  });

  test("reschedule into a taken slot rolls back (old row stays BOOKED)", async () => {
    await book(REC, { patientId: pat(), startsAt: at(23, 10), dentistUserId: DENT2 });
    const a = await book(REC, { patientId: pat(), startsAt: at(23, 12), dentistUserId: DENT2 });
    const r = await api(REC, "POST", `/appointments/${a.body.id}/reschedule`, {
      startsAt: at(23, 10),
      reason: "try",
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "slot_conflict", resource: "dentist" });
    expect((await api(REC, "GET", `/appointments/${a.body.id}`)).body).toMatchObject({
      status: "BOOKED",
      events: [expect.anything()],
    });
  });
});

describe("state machine", () => {
  test("happy path with permissions per target status; invalid moves -> 409", async () => {
    const a = await book(REC, {
      patientId: pat(),
      startsAt: at(0, quietHour()),
      dentistUserId: DENT,
      chairId: chair2,
    });
    expect(a.status).toBe(201);
    const id = a.body.id;
    const bad = await api(REC, "POST", `/appointments/${id}/status`, { to: "COMPLETED" });
    expect(bad.status).toBe(409);
    expect(bad.body).toEqual({
      error: "invalid_transition",
      from: "BOOKED",
      to: "COMPLETED",
      allowed: ["CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW", "RESCHEDULED"],
    });
    expect(
      (await api(REC, "POST", `/appointments/${id}/status`, { to: "CONFIRMED" })).body.status,
    ).toBe("CONFIRMED");
    const same = await api(REC, "POST", `/appointments/${id}/status`, { to: "CONFIRMED" });
    expect(same.status).toBe(409);
    expect(same.body.error).toBe("invalid_transition");
    // DENTIST lacks appointment:checkin; CHECKED_IN is front desk only.
    expect(
      (await api(DENT, "POST", `/appointments/${id}/status`, { to: "CHECKED_IN" })).status,
    ).toBe(403);
    const ci = await api(REC, "POST", `/appointments/${id}/status`, { to: "CHECKED_IN" });
    expect(ci.body.status).toBe("CHECKED_IN");
    expect(ci.body.checkedInAt).toBeString();
    // Dentist moves IN_CHAIR / COMPLETED through clinical:write.
    expect(
      (await api(DENT, "POST", `/appointments/${id}/status`, { to: "IN_CHAIR" })).body.status,
    ).toBe("IN_CHAIR");
    expect(
      (await api(DENT, "POST", `/appointments/${id}/status`, { to: "COMPLETED" })).body.status,
    ).toBe("COMPLETED");
    const done = await api(REC, "POST", `/appointments/${id}/cancel`, { reason: "too late" });
    expect(done.status).toBe(409);
    expect(done.body).toMatchObject({ from: "COMPLETED", allowed: [] });
    const d = await api(REC, "GET", `/appointments/${id}`);
    expect(
      d.body.events.map(
        (e: { fromStatus: string | null; toStatus: string }) => `${e.fromStatus}>${e.toStatus}`,
      ),
    ).toEqual([
      "null>BOOKED",
      "BOOKED>CONFIRMED",
      "CONFIRMED>CHECKED_IN",
      "CHECKED_IN>IN_CHAIR",
      "IN_CHAIR>COMPLETED",
    ]);
    // Each status change is audited with ids only.
    const audits = await h.admin.auditEvent.findMany({ where: { tenantId: tA, resourceId: id } });
    expect(audits.map((x) => x.action).sort()).toEqual(
      [
        "appointment.create",
        "appointment.status.confirmed",
        "appointment.status.checked_in",
        "appointment.status.in_chair",
        "appointment.status.completed",
      ].sort(),
    );
    // Terminal rows cannot be edited.
    expect((await api(REC, "PATCH", `/appointments/${id}`, { notes: "x" })).body).toMatchObject({
      error: "appointment_closed",
    });
  });

  test("no-show only after the grace period", async () => {
    const early = await book(REC, { patientId: pat(), startsAt: at(26, 10), dentistUserId: DENT2 });
    const r = await api(REC, "POST", `/appointments/${early.body.id}/status`, { to: "NO_SHOW" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("no_show_too_early");
    // Two days ago (before a1's BRANCH rows took effect; JSON hours unset = unrestricted).
    const past = await book(REC, { patientId: pat(), startsAt: at(-2, 10), dentistUserId: DENT2 });
    expect(past.status).toBe(201);
    const ns = await api(REC, "POST", `/appointments/${past.body.id}/status`, { to: "NO_SHOW" });
    expect(ns.status).toBe(200);
    expect(ns.body.status).toBe("NO_SHOW");
  });

  test("PATCH re-assigns dentist/chair with conflict mapping", async () => {
    await book(REC, {
      patientId: pat(),
      startsAt: at(27, 10),
      dentistUserId: DENT,
      chairId: chair1,
    });
    const b = await book(REC, {
      patientId: pat(),
      startsAt: at(27, 10),
      dentistUserId: DENT2,
      chairId: chair2,
    });
    const clash = await api(REC, "PATCH", `/appointments/${b.body.id}`, { dentistUserId: DENT });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ error: "slot_conflict", resource: "dentist" });
    const ok = await api(REC, "PATCH", `/appointments/${b.body.id}`, {
      chairId: null,
      notes: "moved",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ chairId: null, notes: "moved", dentistUserId: DENT2 });
  });
});

describe("scope and tenancy", () => {
  test("branch scope -> 403", async () => {
    const a = await book(REC, { patientId: pat(), startsAt: at(30, 10) });
    expect(a.status).toBe(201);
    expect((await book(REC, { patientId: pat(), branchId: a2, startsAt: at(30, 11) })).status).toBe(
      403,
    );
    expect((await api(REC2, "GET", `/appointments/${a.body.id}`)).status).toBe(403);
    expect(
      (await api(REC2, "POST", `/appointments/${a.body.id}/cancel`, { reason: "nope" })).status,
    ).toBe(403);
    expect(
      (await api(REC2, "POST", `/appointments/${a.body.id}/status`, { to: "CONFIRMED" })).status,
    ).toBe(403);
    expect(
      (await api(REC2, "GET", `/appointments?branchId=${a1}&from=${at(30, 0)}&to=${at(31, 0)}`))
        .status,
    ).toBe(403);
    const mine = await api(REC2, "GET", `/appointments?from=${at(30, 0)}&to=${at(31, 0)}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(0);
    expect((await api(REC2, "GET", `/front-desk/queue?branchId=${a1}`)).status).toBe(403);
    expect(
      (
        await api(
          REC2,
          "GET",
          `/availability?branchId=${a1}&date=${addDays(today(), 30)}&durationMin=30`,
        )
      ).status,
    ).toBe(403);
  });

  test("cross-tenant -> 404", async () => {
    const a = await book(REC, { patientId: pat(), startsAt: at(31, 10) });
    const o = { tenant: tB };
    expect((await api(OWNER_B, "GET", `/appointments/${a.body.id}`, undefined, o)).status).toBe(
      404,
    );
    expect(
      (await api(OWNER_B, "POST", `/appointments/${a.body.id}/cancel`, { reason: "nope" }, o))
        .status,
    ).toBe(404);
    expect(
      (await api(OWNER_B, "POST", `/appointments/${a.body.id}/status`, { to: "CONFIRMED" }, o))
        .status,
    ).toBe(404);
    // tA patient in tB's branch: invisible.
    const x = await book(
      OWNER_B,
      { patientId: a.body.patientId, branchId: b1, startsAt: at(31, 10) },
      o,
    );
    expect(x.status).toBe(404);
    // tA branch from tB: invisible.
    const y = await book(
      OWNER_B,
      { patientId: a.body.patientId, branchId: a1, startsAt: at(31, 10) },
      o,
    );
    expect(y.status).toBe(404);
    // A tA member presenting tB's tenant id is not a member there.
    expect((await api(OWNER, "GET", `/appointments/${a.body.id}`, undefined, o)).status).toBe(403);
  });
});

describe("working-hours rule", () => {
  test("outside hours: 409 unless schedule:manage + reason; branch knob forbids it", async () => {
    const late = at(35, 20);
    const r1 = await book(REC, { patientId: pat(), startsAt: late, dentistUserId: DENT });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe("outside_working_hours");
    const r2 = await book(REC, {
      patientId: pat(),
      startsAt: late,
      outsideHoursReason: "Emergency follow-up",
    });
    expect(r2.status).toBe(409);
    expect((await book(MANAGER, { patientId: pat(), startsAt: late })).status).toBe(409);
    // Straddling closing time is outside too.
    expect((await book(REC, { patientId: pat(), startsAt: at(35, 17, 45) })).status).toBe(409);
    const ok = await book(MANAGER, {
      patientId: pat(),
      startsAt: late,
      dentistUserId: DENT,
      outsideHoursReason: "Emergency follow-up",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.outsideHoursReason).toBe("Emergency follow-up");

    await api(MANAGER, "PATCH", `/scheduling/settings?branchId=${a1}`, {
      allowOutsideHoursBooking: false,
    });
    const off = await book(MANAGER, {
      patientId: pat(),
      startsAt: at(35, 21),
      outsideHoursReason: "Emergency follow-up",
    });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe("outside_working_hours");
    await api(MANAGER, "PATCH", `/scheduling/settings?branchId=${a1}`, {
      allowOutsideHoursBooking: true,
    });
  });

  test("dentist and chair hours narrow the branch hours", async () => {
    const day = addDays(today(), 36);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    const dh = await api(OWNER, "PUT", "/working-hours", {
      scope: "DENTIST",
      branchId: a1,
      userId: DENT2,
      effectiveFrom: day,
      sessions: [{ weekday, startMinute: 600, endMinute: 720 }],
    });
    expect(dh.status).toBe(200);
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(36, 9), dentistUserId: DENT2 })).body.error,
    ).toBe("outside_working_hours");
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(36, 10), dentistUserId: DENT2 })).status,
    ).toBe(201);
    const ch = await api(OWNER, "POST", "/chairs", {
      branchId: a1,
      code: "HRS",
      name: "Hours chair",
    });
    await api(MANAGER, "PUT", "/working-hours", {
      scope: "CHAIR",
      branchId: a1,
      chairId: ch.body.id,
      effectiveFrom: day,
      sessions: [{ weekday, startMinute: 840, endMinute: 900 }],
    });
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(36, 13), chairId: ch.body.id })).body.error,
    ).toBe("outside_working_hours");
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(36, 14), chairId: ch.body.id })).status,
    ).toBe(201);
    await api(OWNER, "POST", `/chairs/${ch.body.id}/deactivate`);
    // Close DENT2's hours again from the next day (later tests book DENT2 on other weekdays).
    const close = await api(OWNER, "PUT", "/working-hours", {
      scope: "DENTIST",
      branchId: a1,
      userId: DENT2,
      effectiveFrom: addDays(day, 1),
      sessions: [],
    });
    expect(close.status).toBe(200);
    const hist = await api(
      REC,
      "GET",
      `/working-hours?branchId=${a1}&scope=DENTIST&userId=${DENT2}&includeHistory=true`,
    );
    expect(hist.body.items).toEqual([
      expect.objectContaining({
        effectiveFrom: day,
        effectiveTo: addDays(day, 1),
        startMinute: 600,
      }),
    ]);
  });
});

describe("availability", () => {
  test("free slots = hours minus active appointments, per dentist and chair", async () => {
    const day = addDays(today(), 40);
    const q = `/availability?branchId=${a1}&date=${day}&durationMin=30&stepMin=30&dentistUserId=${DENT}`;
    const before = await api(REC, "GET", q);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ branchId: a1, date: day, timeZone: TZ, durationMin: 30 });
    // 09:00–18:00 in 30-minute steps.
    expect(before.body.slots).toHaveLength(18);
    expect(before.body.slots[0]).toMatchObject({ startsAt: at(40, 9), endsAt: at(40, 9, 30) });
    expect(before.body.slots[0].chairIds.sort()).toEqual([chair1, chair2].sort());

    await book(REC, {
      patientId: pat(),
      startsAt: at(40, 10),
      dentistUserId: DENT,
      chairId: chair1,
    });
    await book(REC, { patientId: pat(), startsAt: at(40, 11), chairId: chair1 });
    await book(REC, {
      patientId: pat(),
      startsAt: at(40, 11),
      chairId: chair2,
      dentistUserId: DENT2,
    });
    const after = await api(REC, "GET", q);
    const starts = after.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(starts).not.toContain(at(40, 10));
    expect(starts).not.toContain(at(40, 11)); // dentist free, but no chair free
    expect(after.body.slots).toHaveLength(16);
    const ten30 = after.body.slots.find((s: { startsAt: string }) => s.startsAt === at(40, 10, 30));
    expect(ten30.chairIds.sort()).toEqual([chair1, chair2].sort());

    const one = await api(
      REC,
      "GET",
      `/availability?branchId=${a1}&date=${day}&durationMin=60&chairId=${chair2}`,
    );
    // 15-minute default step, 60-minute visits, chair2 busy 11:00–11:30 -> 10:15..11:15 starts excluded.
    const s2 = one.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(s2).toContain(at(40, 10));
    expect(s2).not.toContain(at(40, 10, 15));
    expect(s2).not.toContain(at(40, 11, 15));
    expect(s2).toContain(at(40, 11, 30));
    expect(s2[s2.length - 1]).toBe(at(40, 17));
  });
});

describe("walk-in, queue and realtime", () => {
  test("walk-in checked in now; urgent first in queue; busy dentist booked unassigned", async () => {
    events.length = 0;
    const p1 = await patient();
    const p2 = await patient();
    const w1 = await api(REC, "POST", "/appointments/walk-in", {
      patientId: p1,
      branchId: a1,
      dentistUserId: DENT,
    });
    expect(w1.status).toBe(201);
    expect(w1.body).toMatchObject({
      status: "CHECKED_IN",
      source: "WALK_IN",
      dentistUserId: DENT,
      appointmentType: "CONSULTATION",
    });
    expect(w1.body.checkedInAt).toBeString();
    const w2 = await api(REC, "POST", "/appointments/walk-in", {
      patientId: p2,
      branchId: a1,
      source: "URGENT",
      dentistUserId: DENT,
    });
    expect(w2.status).toBe(201);
    // DENT is busy with w1 -> urgent visit booked unassigned (ADR 0003 §1.3).
    expect(w2.body).toMatchObject({
      source: "URGENT",
      dentistUserId: null,
      appointmentType: "EMERGENCY",
    });

    const queue = await api(REC, "GET", `/front-desk/queue?branchId=${a1}`);
    expect(queue.status).toBe(200);
    const ids = queue.body.items.map((i: { appointment: { id: string } }) => i.appointment.id);
    expect(ids.indexOf(w2.body.id)).toBeLessThan(ids.indexOf(w1.body.id));
    const entry = queue.body.items.find(
      (i: { appointment: { id: string } }) => i.appointment.id === w1.body.id,
    );
    expect(entry).toMatchObject({ patient: { id: p1 }, waitingSince: w1.body.checkedInAt });
    expect(queue.body.items[0].position).toBe(1);

    await api(DENT, "POST", `/appointments/${w1.body.id}/status`, { to: "IN_CHAIR" });
    await api(DENT, "POST", `/appointments/${w1.body.id}/status`, { to: "COMPLETED" });
    const q2 = await api(REC, "GET", `/front-desk/queue?branchId=${a1}`);
    expect(
      q2.body.items.map((i: { appointment: { id: string } }) => i.appointment.id),
    ).not.toContain(w1.body.id);

    // Not checked in -> BOOKED, not queued. DENTIST may not create walk-ins.
    const w3 = await api(REC, "POST", "/appointments/walk-in", {
      patientId: p1,
      branchId: a1,
      checkIn: false,
    });
    expect(w3.body.status).toBe("BOOKED");
    expect(
      (await api(DENT, "POST", "/appointments/walk-in", { patientId: p1, branchId: a1 })).status,
    ).toBe(403);

    // EventBus: tenant + branch, ids/status only.
    const mine = events.filter((e) => e.tenantId === tA);
    const types = mine.map((e) => `${e.type}:${String(e.data.appointmentId)}`);
    expect(types).toContain(`appointment.created:${w1.body.id}`);
    expect(types).toContain(`appointment.status_changed:${w1.body.id}`);
    for (const e of mine) {
      expect(e.branchId).toBe(a1);
      expect(
        Object.keys(e.data).every((k) =>
          [
            "appointmentId",
            "patientId",
            "fromStatus",
            "toStatus",
            "startsAt",
            "newAppointmentId",
          ].includes(k),
        ),
      ).toBe(true);
    }
    const completed = mine.find(
      (e) => e.type === "appointment.status_changed" && e.data.toStatus === "COMPLETED",
    );
    expect(completed?.data).toMatchObject({
      appointmentId: w1.body.id,
      fromStatus: "IN_CHAIR",
      patientId: p1,
    });
  });

  test("events for cancel and reschedule", async () => {
    events.length = 0;
    const a = await book(REC, { patientId: pat(), startsAt: at(42, 10) });
    const r = await api(REC, "POST", `/appointments/${a.body.id}/reschedule`, {
      startsAt: at(42, 11),
      reason: "swap",
    });
    await api(REC, "POST", `/appointments/${r.body.id}/cancel`, { reason: "Cancelled by patient" });
    const seq = events.filter((e) => e.tenantId === tA).map((e) => e.type);
    expect(seq).toEqual([
      "appointment.created",
      "appointment.rescheduled",
      "appointment.created",
      "appointment.cancelled",
    ]);
    const res = events.find((e) => e.type === "appointment.rescheduled");
    expect(res?.data).toMatchObject({
      appointmentId: a.body.id,
      newAppointmentId: r.body.id,
      toStatus: "RESCHEDULED",
    });
  });
});

describe("treatment-plan linkage", () => {
  async function planItem(patientId: string, status: "ACCEPTED" | "PROPOSED") {
    const svc = await h.admin.service.create({
      data: {
        tenantId: tA,
        code: code("S"),
        name: "RCT",
        durationMin: 60,
        basePricePaise: 500_000,
      },
    });
    const plan = await h.admin.treatmentPlan.create({
      data: {
        tenantId: tA,
        patientId,
        branchId: a1,
        title: "Plan",
        status: "PRESENTED",
        currentVersion: 1,
        createdBy: DENT,
      },
    });
    const item = await h.admin.planItem.create({
      data: {
        tenantId: tA,
        planId: plan.id,
        patientId,
        serviceId: svc.id,
        estimatePricePaise: 500_000,
        priceSource: "BASE",
        status,
        createdBy: DENT,
      },
    });
    return item.id;
  }
  const itemStatus = async (id: string) =>
    (await h.admin.planItem.findUniqueOrThrow({ where: { id } })).status;
  const sessions = (planItemId: string) =>
    h.admin.planItemSession.findMany({ where: { planItemId }, orderBy: { sessionNo: "asc" } });

  test("book ACCEPTED item -> SCHEDULED + session; reschedule moves it; cancel reverts", async () => {
    const pid = await patient();
    const item = await planItem(pid, "ACCEPTED");
    const a = await book(REC, {
      patientId: pid,
      startsAt: at(45, 10),
      dentistUserId: DENT,
      planItemId: item,
    });
    expect(a.status).toBe(201);
    expect(a.body.planItemId).toBe(item);
    expect(await itemStatus(item)).toBe("SCHEDULED");
    let s = await sessions(item);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ sessionNo: 1, status: "SCHEDULED", appointmentId: a.body.id });

    // Already SCHEDULED -> a second booking of the same item is an invalid transition.
    const dup = await book(REC, { patientId: pid, startsAt: at(46, 10), planItemId: item });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({
      error: "invalid_transition",
      from: "SCHEDULED",
      to: "SCHEDULED",
    });

    const r = await api(REC, "POST", `/appointments/${a.body.id}/reschedule`, {
      startsAt: at(46, 11),
      reason: "Clash",
    });
    expect(r.body.planItemId).toBe(item);
    expect(await itemStatus(item)).toBe("SCHEDULED");
    s = await sessions(item);
    expect(s).toHaveLength(1);
    expect(s[0]?.appointmentId).toBe(r.body.id);

    await api(REC, "POST", `/appointments/${r.body.id}/cancel`, { reason: "Patient unwell" });
    expect(await itemStatus(item)).toBe("ACCEPTED");
    expect((await sessions(item))[0]?.status).toBe("CANCELLED");

    // Re-booking opens session 2; a no-show releases it again.
    const past = await book(REC, { patientId: pid, startsAt: at(-3, 10), planItemId: item });
    expect(past.status).toBe(201);
    s = await sessions(item);
    expect(s.map((x) => [x.sessionNo, x.status])).toEqual([
      [1, "CANCELLED"],
      [2, "SCHEDULED"],
    ]);
    await api(REC, "POST", `/appointments/${past.body.id}/status`, { to: "NO_SHOW" });
    expect(await itemStatus(item)).toBe("ACCEPTED");
    expect((await sessions(item))[1]?.status).toBe("CANCELLED");
  });

  test("non-ACCEPTED item or another patient's item is rejected; plan untouched otherwise", async () => {
    const pid = await patient();
    const proposed = await planItem(pid, "PROPOSED");
    const r = await book(REC, { patientId: pid, startsAt: at(47, 10), planItemId: proposed });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      error: "invalid_transition",
      from: "PROPOSED",
      to: "SCHEDULED",
    });
    expect(await itemStatus(proposed)).toBe("PROPOSED");

    const other = await planItem(await patient(), "ACCEPTED");
    const m = await book(REC, { patientId: pid, startsAt: at(47, 11), planItemId: other });
    expect(m.status).toBe(400);
    expect(m.body.error).toBe("plan_item_patient_mismatch");
    expect(await itemStatus(other)).toBe("ACCEPTED");
    expect(
      (await book(REC, { patientId: pid, startsAt: at(47, 11), planItemId: randomUUID() })).status,
    ).toBe(404);

    // Completing a linked appointment does not touch the item (only cancel/no-show revert).
    const item = await planItem(pid, "ACCEPTED");
    const a = await book(REC, {
      patientId: pid,
      startsAt: at(0, quietHour(), 30),
      planItemId: item,
    });
    expect(a.status).toBe(201);
    expect(
      (await api(REC, "POST", `/appointments/${a.body.id}/status`, { to: "CHECKED_IN" })).status,
    ).toBe(200);
    await api(REC, "POST", `/appointments/${a.body.id}/status`, { to: "IN_CHAIR" });
    await api(REC, "POST", `/appointments/${a.body.id}/status`, { to: "COMPLETED" });
    expect(await itemStatus(item)).toBe("SCHEDULED");
  });

  test("items on a branch the caller cannot see answer 404, before patient/status checks", async () => {
    const pid = await patient();
    const proposed = await planItem(pid, "PROPOSED");
    const accepted = await planItem(pid, "ACCEPTED");
    // REC2 is scoped to a2 only; the plan is at a1.
    const bookA2 = (patientId: string, planItemId: string, hh: number) =>
      book(REC2, { branchId: a2, patientId, startsAt: at(49, hh), planItemId });
    for (const r of [
      await bookA2(await patient(), accepted, 10), // another patient's item
      await bookA2(pid, proposed, 11), // owning patient, PROPOSED (status would leak)
      await bookA2(pid, accepted, 12), // owning patient, ACCEPTED
      await bookA2(pid, randomUUID(), 13), // missing
    ]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(expect.objectContaining({ error: "plan_item_not_found" }));
      expect(r.body.from).toBeUndefined();
    }
    // Same through PATCH.
    const a = await book(REC2, { branchId: a2, patientId: pid, startsAt: at(49, 14) });
    expect(a.status).toBe(201);
    const pr = await api(REC2, "PATCH", `/appointments/${a.body.id}`, { planItemId: proposed });
    expect(pr.status).toBe(404);
    expect(pr.body.error).toBe("plan_item_not_found");
    expect(await itemStatus(proposed)).toBe("PROPOSED");
    expect(await itemStatus(accepted)).toBe("ACCEPTED");
  });
});

describe("verifier regressions", () => {
  test("walk-in startsAt must be within the walk-in window of now (no hours bypass)", async () => {
    const p1 = await patient();
    const nowMs = Date.now();
    for (const startsAt of [
      at(9, 3), // future, outside hours, not checked in
      at(20, 2), // future, checked in (would leak into today's queue)
      new Date(nowMs - 3 * 3_600_000).toISOString(), // back-dated
      new Date(nowMs + 45 * 60_000).toISOString(),
    ]) {
      for (const checkIn of [false, true]) {
        const r = await api(REC, "POST", "/appointments/walk-in", {
          patientId: p1,
          branchId: a1,
          startsAt,
          checkIn,
        });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({
          error: "validation_failed",
          issues: [expect.objectContaining({ path: "startsAt" })],
        });
      }
    }
    const soon = await api(REC, "POST", "/appointments/walk-in", {
      patientId: p1,
      branchId: a1,
      startsAt: new Date(nowMs + 10 * 60_000).toISOString(),
      checkIn: false,
    });
    expect(soon.status).toBe(201);
    expect(soon.body).toMatchObject({ status: "BOOKED", outsideHoursReason: null });
    const queue = await api(REC, "GET", `/front-desk/queue?branchId=${a1}`);
    const ids = queue.body.items.map((i: { appointment: { id: string } }) => i.appointment.id);
    expect(ids).not.toContain(soon.body.id);
    await api(REC, "POST", `/appointments/${soon.body.id}/cancel`, { reason: "test cleanup" });
  });

  test("PATCH dentist/chair applies the working-hours rule", async () => {
    const off = 65;
    const day = addDays(today(), off);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    // DENT2 works 10:00–12:00 on `day` only.
    expect(
      (
        await api(OWNER, "PUT", "/working-hours", {
          scope: "DENTIST",
          branchId: a1,
          userId: DENT2,
          effectiveFrom: day,
          sessions: [{ weekday, startMinute: 600, endMinute: 720 }],
        })
      ).status,
    ).toBe(200);
    // Direct booking of DENT2 at 15:00 is refused; moving a 15:00 visit onto DENT2 must be too.
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(off, 15), dentistUserId: DENT2 })).body
        .error,
    ).toBe("outside_working_hours");
    const a = await book(REC, { patientId: pat(), startsAt: at(off, 15), dentistUserId: DENT });
    expect(a.status).toBe(201);
    const moved = await api(REC, "PATCH", `/appointments/${a.body.id}`, { dentistUserId: DENT2 });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe("outside_working_hours");
    expect((await api(REC, "GET", `/appointments/${a.body.id}`)).body.dentistUserId).toBe(DENT);
    // Even schedule:manage needs a reason: none on the row -> 409 (reschedule takes one).
    expect(
      (await api(MANAGER, "PATCH", `/appointments/${a.body.id}`, { dentistUserId: DENT2 })).status,
    ).toBe(409);
    // Inside DENT2's hours: fine.
    const b = await book(REC, { patientId: pat(), startsAt: at(off, 10, 30), dentistUserId: DENT });
    const okMove = await api(REC, "PATCH", `/appointments/${b.body.id}`, { dentistUserId: DENT2 });
    expect(okMove.status).toBe(200);
    expect(okMove.body.dentistUserId).toBe(DENT2);

    // Row approved outside hours (reason stored): schedule:manage may re-assign, others may not.
    const late = await book(MANAGER, {
      patientId: pat(),
      startsAt: at(off, 20),
      dentistUserId: DENT,
      outsideHoursReason: "After-hours emergency",
    });
    expect(late.status).toBe(201);
    expect(
      (await api(MANAGER, "PATCH", `/appointments/${late.body.id}`, { dentistUserId: DENT2 }))
        .status,
    ).toBe(200);
    expect(
      (await api(REC, "PATCH", `/appointments/${late.body.id}`, { dentistUserId: DENT })).body
        .error,
    ).toBe("outside_working_hours");
    // Unassigning only widens the hours: always allowed.
    const un = await api(REC, "PATCH", `/appointments/${late.body.id}`, { dentistUserId: null });
    expect(un.status).toBe(200);
    expect(un.body).toMatchObject({
      dentistUserId: null,
      outsideHoursReason: "After-hours emergency",
    });

    // Chair with hours only on a weekday that is not today's: no hours today or in 7 days.
    const ch = await api(OWNER, "POST", "/chairs", { branchId: a1, code: code("PH"), name: "P" });
    expect(ch.status).toBe(201);
    const otherWeekday = (new Date(`${today()}T00:00:00Z`).getUTCDay() + 3) % 7;
    expect(
      (
        await api(OWNER, "PUT", "/working-hours", {
          scope: "CHAIR",
          branchId: a1,
          chairId: ch.body.id,
          effectiveFrom: today(),
          sessions: [{ weekday: otherWeekday, startMinute: 540, endMinute: 600 }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await book(REC, { patientId: pat(), startsAt: at(7, 10), chairId: ch.body.id })).body.error,
    ).toBe("outside_working_hours");
    const c = await book(REC, { patientId: pat(), startsAt: at(7, 10) });
    expect(c.status).toBe(201);
    const cm = await api(REC, "PATCH", `/appointments/${c.body.id}`, { chairId: ch.body.id });
    expect(cm.status).toBe(409);
    expect(cm.body.error).toBe("outside_working_hours");
    // A visit happening now (walk-in window) may still be assigned, like a walk-in could be.
    const w = await api(REC, "POST", "/appointments/walk-in", { patientId: pat(), branchId: a1 });
    expect(w.status).toBe(201);
    const wm = await api(REC, "PATCH", `/appointments/${w.body.id}`, { chairId: ch.body.id });
    expect(wm.status).toBe(200);
    expect(wm.body.chairId).toBe(ch.body.id);
    await api(REC, "POST", `/appointments/${w.body.id}/cancel`, { reason: "test cleanup" });
    await api(OWNER, "POST", `/chairs/${ch.body.id}/deactivate`);

    // Close DENT2's hours again from the next day.
    expect(
      (
        await api(OWNER, "PUT", "/working-hours", {
          scope: "DENTIST",
          branchId: a1,
          userId: DENT2,
          effectiveFrom: addDays(day, 1),
          sessions: [],
        })
      ).status,
    ).toBe(200);
  });

  test("replacing hours that took effect today keeps them (409); from tomorrow closes them", async () => {
    const ch = await api(OWNER, "POST", "/chairs", { branchId: a1, code: code("WH"), name: "W" });
    expect(ch.status).toBe(201);
    const put = (effectiveFrom: string, startMinute: number) =>
      api(OWNER, "PUT", "/working-hours", {
        scope: "CHAIR",
        branchId: a1,
        chairId: ch.body.id,
        effectiveFrom,
        sessions: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute,
          endMinute: 900,
        })),
      });
    const hist = async () =>
      (
        await api(
          REC,
          "GET",
          `/working-hours?branchId=${a1}&scope=CHAIR&chairId=${ch.body.id}&includeHistory=true`,
        )
      ).body.items as { id: string; effectiveFrom: string; effectiveTo: string | null }[];

    const first = await put(today(), 540);
    expect(first.status).toBe(200);
    const firstIds = first.body.items.map((r: { id: string }) => r.id).sort();
    expect(firstIds).toHaveLength(7);

    const again = await put(today(), 600);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("working_hours_in_force");
    expect((await hist()).map((r) => r.id).sort()).toEqual(firstIds);

    const tomorrow = addDays(today(), 1);
    expect((await put(tomorrow, 600)).status).toBe(200);
    // Not-yet-effective rows (from tomorrow) are still superseded by a second replacement.
    expect((await put(tomorrow, 660)).status).toBe(200);
    const rows = await hist();
    expect(rows).toHaveLength(14);
    const kept = rows.filter((r) => firstIds.includes(r.id));
    expect(kept).toHaveLength(7);
    for (const r of kept)
      expect(r).toMatchObject({ effectiveFrom: today(), effectiveTo: tomorrow });
    await api(OWNER, "POST", `/chairs/${ch.body.id}/deactivate`);
  });
});

describe("verifier regressions (round 2)", () => {
  test("a checked-in walk-in past the window can still be given a dentist/chair outside hours", async () => {
    // Fresh dentist + chair whose only hours are on a weekday other than the visit's.
    const dent = await h.member(tA, ["DENTIST"], { branchScope: [a1] });
    await h.admin.dentistBranchAssignment.create({
      data: {
        tenantId: tA,
        userId: dent,
        branchId: a1,
        effectiveFrom: new Date("2020-01-01T00:00:00Z"),
        createdBy: "seed",
      },
    });
    const ch = await api(OWNER, "POST", "/chairs", { branchId: a1, code: code("WK"), name: "W" });
    expect(ch.status).toBe(201);
    const now = Date.now();
    const seed = async (status: "CHECKED_IN" | "IN_CHAIR" | "BOOKED", agoMin: number) => {
      const startsAt = new Date(now - agoMin * 60_000);
      return h.admin.appointment.create({
        data: {
          tenantId: tA,
          patientId: await patient(),
          branchId: a1,
          appointmentType: "EMERGENCY",
          source: "URGENT",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          status,
          checkedInAt: status === "BOOKED" ? null : startsAt,
          createdBy: "seed",
        },
      });
    };
    const waiting = await seed("CHECKED_IN", 120);
    const inChair = await seed("IN_CHAIR", 90);
    const booked = await seed("BOOKED", 100);
    const weekdays = [waiting, inChair, booked].map(
      (a) => new Date(a.startsAt.getTime() + 330 * 60_000).getUTCDay(), // Asia/Kolkata = UTC+05:30
    );
    const off = [0, 1, 2, 3, 4, 5, 6].find((d) => !weekdays.includes(d)) ?? 0;
    for (const extra of [
      { scope: "DENTIST" as const, userId: dent },
      { scope: "CHAIR" as const, chairId: ch.body.id },
    ])
      await h.admin.workingHours.create({
        data: {
          tenantId: tA,
          branchId: a1,
          ...extra,
          weekday: off,
          startMinute: 540,
          endMinute: 600,
          effectiveFrom: new Date("2020-01-01T00:00:00Z"),
          createdBy: "seed",
        },
      });

    // Not at the desk, outside the walk-in window: still refused (control).
    const ctl = await api(REC, "PATCH", `/appointments/${booked.id}`, { dentistUserId: dent });
    expect(ctl.status).toBe(409);
    expect(ctl.body.error).toBe("outside_working_hours");
    // At the desk: the receptionist assigns the dentist and chair when they free up (ADR 0003 §1.3).
    for (const a of [waiting, inChair]) {
      const r = await api(REC, "PATCH", `/appointments/${a.id}`, {
        dentistUserId: dent,
        chairId: ch.body.id,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        dentistUserId: dent,
        chairId: ch.body.id,
        outsideHoursReason: null,
      });
      await api(REC, "POST", `/appointments/${a.id}/cancel`, { reason: "test cleanup" });
    }
    await api(REC, "POST", `/appointments/${booked.id}/cancel`, { reason: "test cleanup" });
    await api(OWNER, "POST", `/chairs/${ch.body.id}/deactivate`);
  });

  test("check-in only on the visit's own day", async () => {
    const future = await book(REC, { patientId: pat(), startsAt: at(20, 10) });
    expect(future.status).toBe(201);
    const early = await api(REC, "POST", `/appointments/${future.body.id}/status`, {
      to: "CHECKED_IN",
    });
    expect(early.status).toBe(409);
    expect(early.body).toEqual({
      error: "check_in_too_early",
      eligibleFrom: zonedToUtc(addDays(today(), 20), 0, TZ).toISOString(),
    });
    // Confirmed changes nothing; the row stays out of today's queue.
    await api(REC, "POST", `/appointments/${future.body.id}/status`, { to: "CONFIRMED" });
    expect(
      (await api(REC, "POST", `/appointments/${future.body.id}/status`, { to: "CHECKED_IN" })).body
        .error,
    ).toBe("check_in_too_early");
    const row = await api(REC, "GET", `/appointments/${future.body.id}`);
    expect(row.body).toMatchObject({ status: "CONFIRMED", checkedInAt: null });
    const queue = await api(REC, "GET", `/front-desk/queue?branchId=${a1}`);
    expect(
      queue.body.items.map((i: { appointment: { id: string } }) => i.appointment.id),
    ).not.toContain(future.body.id);

    // A past day's visit is a no-show or a reschedule, not a check-in.
    const past = await book(REC, { patientId: pat(), startsAt: at(-4, 10) });
    expect(past.status).toBe(201);
    const late = await api(REC, "POST", `/appointments/${past.body.id}/status`, {
      to: "CHECKED_IN",
    });
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ error: "check_in_too_late", startsAt: past.body.startsAt });
  });
});

describe("calendar list", () => {
  test("range overlap + filters, patient history", async () => {
    const pid = await patient();
    const a = await book(REC, {
      patientId: pid,
      startsAt: at(50, 9),
      dentistUserId: DENT,
      chairId: chair1,
    });
    const b = await book(REC, {
      patientId: pid,
      startsAt: at(50, 12),
      dentistUserId: DENT2,
      chairId: chair2,
    });
    await book(REC, { patientId: pat(), startsAt: at(52, 12) });
    const day = await api(
      REC,
      "GET",
      `/appointments?branchId=${a1}&from=${at(50, 0)}&to=${at(51, 0)}`,
    );
    expect(day.status).toBe(200);
    expect(day.body.items.map((x: { id: string }) => x.id)).toEqual([a.body.id, b.body.id]);
    expect(day.body.items[0].patient.id).toBe(pid);
    const byDentist = await api(
      REC,
      "GET",
      `/appointments?from=${at(50, 0)}&to=${at(57, 0)}&dentistUserId=${DENT2}`,
    );
    expect(byDentist.body.items.map((x: { id: string }) => x.id)).toEqual([b.body.id]);
    const byChair = await api(
      REC,
      "GET",
      `/appointments?from=${at(50, 0)}&to=${at(57, 0)}&chairId=${chair1}`,
    );
    expect(byChair.body.items.map((x: { id: string }) => x.id)).toEqual([a.body.id]);
    // Overlap semantics: a window inside the 09:00–09:30 visit still finds it.
    const inner = await api(REC, "GET", `/appointments?from=${at(50, 9, 10)}&to=${at(50, 9, 20)}`);
    expect(inner.body.items.map((x: { id: string }) => x.id)).toEqual([a.body.id]);
    await api(REC, "POST", `/appointments/${a.body.id}/cancel`, { reason: "No longer needed" });
    const active = await api(
      REC,
      "GET",
      `/appointments?from=${at(50, 0)}&to=${at(51, 0)}&status=BOOKED,CONFIRMED`,
    );
    expect(active.body.items.map((x: { id: string }) => x.id)).toEqual([b.body.id]);
    const hist = await api(REC, "GET", `/appointments?patientId=${pid}`);
    expect(hist.body.items).toHaveLength(2);
    expect((await api(REC, "GET", `/appointments?from=${at(50, 0)}&to=${at(100, 0)}`)).status).toBe(
      400,
    );
    expect((await api(REC, "GET", "/appointments")).status).toBe(400);
  });
});
