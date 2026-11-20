import { beforeEach, describe, expect, test } from "bun:test";
import type { AppointmentResponse, WorkingHoursResponse } from "@dentalos/validation";
import { ApiError } from "./errors";
import { fid } from "./fixtures";
import {
  FULL_DAY,
  branchJsonHours,
  covers,
  effectiveHours,
  hoursPeriods,
  intersect,
  scheduleOn,
} from "./scheduling-hours";
import { parseSseChunk, toSchedulingChange } from "./scheduling-live";
import { resetSchedulingMock, schedulingMockCall, schedulingMockDb } from "./scheduling-mock";
import { describeSchedulingError } from "./scheduling-rules";
import { addDays, todayIn, zonedIso } from "./scheduling-time";

const IST = "Asia/Kolkata";
const B1 = fid("0b", 1);
const OP1 = fid("31", 1);
const RAHUL = fid("01", 41);
const MERGED = fid("01", 45);
// Far enough ahead that the real clock never makes these "past"; B1's hours are open-ended.
const DAY = "2027-01-13"; // Wednesday

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

const book = (minute: number, extra: Record<string, unknown> = {}) =>
  schedulingMockCall(
    "POST",
    "/appointments",
    {},
    {
      patientId: RAHUL,
      branchId: B1,
      startsAt: zonedIso(DAY, minute, IST),
      durationMin: 30,
      chairId: OP1,
      ...extra,
    },
  ) as Promise<AppointmentResponse>;

describe("scheduling mock (mirrors the API contract)", () => {
  beforeEach(() => resetSchedulingMock(new Date("2026-11-16T04:00:00Z")));

  test("double booking a chair → 409 slot_conflict {resource: chair}", async () => {
    const first = await book(600);
    expect(first.status).toBe("BOOKED");
    const e = await failure(book(615));
    expect(e.status).toBe(409);
    expect(e.code).toBe("slot_conflict");
    expect(e.body.resource).toBe("chair");
    expect(describeSchedulingError(e).field).toBe("chairId");
    // Touching intervals are fine ([start, end)).
    expect((await book(630)).status).toBe("BOOKED");
  });

  test("outside working hours → 409 unless a reason is given (schedule:manage)", async () => {
    const e = await failure(book(840)); // 14:00, B1 closes 13:30–16:30
    expect(e.code).toBe("outside_working_hours");
    const ok = await book(840, { outsideHoursReason: "Only slot the patient can make" });
    expect(ok.outsideHoursReason).toBe("Only slot the patient can make");
  });

  test("merged patient → 409 patient_merged with the survivor", async () => {
    const e = await failure(book(600, { patientId: MERGED }));
    expect(e.code).toBe("patient_merged");
    expect(e.mergedSurvivorId).toBe(fid("01", 46));
  });

  test("state machine: invalid_transition, check-in day rule, cancel reason", async () => {
    const a = await book(600);
    const bad = await failure(
      schedulingMockCall("POST", `/appointments/${a.id}/status`, {}, { to: "COMPLETED" }),
    );
    expect(bad.code).toBe("invalid_transition");
    expect(bad.body.allowed).toEqual([
      "CONFIRMED",
      "CHECKED_IN",
      "CANCELLED",
      "NO_SHOW",
      "RESCHEDULED",
    ]);
    const early = await failure(
      schedulingMockCall("POST", `/appointments/${a.id}/status`, {}, { to: "CHECKED_IN" }),
    );
    expect(early.code).toBe("check_in_too_early");
    const noReason = await failure(
      schedulingMockCall("POST", `/appointments/${a.id}/cancel`, {}, { reason: "" }),
    );
    expect(noReason.status).toBe(400);
    const cancelled = (await schedulingMockCall(
      "POST",
      `/appointments/${a.id}/cancel`,
      {},
      {
        reason: "Patient called",
      },
    )) as AppointmentResponse;
    expect(cancelled.status).toBe("CANCELLED");
    // The freed slot can be booked again.
    expect((await book(600)).status).toBe("BOOKED");
  });

  test("reschedule creates a linked appointment and keeps the old one", async () => {
    const a = await book(600);
    const next = (await schedulingMockCall(
      "POST",
      `/appointments/${a.id}/reschedule`,
      {},
      {
        startsAt: zonedIso(DAY, 660, IST),
        reason: "Clashes with work",
      },
    )) as AppointmentResponse;
    expect(next.id).not.toBe(a.id);
    expect(next.rescheduledFromId).toBe(a.id);
    const old = schedulingMockDb().appointments.find((x) => x.id === a.id);
    expect(old?.status).toBe("RESCHEDULED");
  });

  test("working hours: past day → 400, same-day replace of rows in force today → 409", async () => {
    const today = todayIn(IST);
    const put = (effectiveFrom: string) =>
      schedulingMockCall(
        "PUT",
        "/working-hours",
        {},
        {
          scope: "BRANCH",
          branchId: B1,
          effectiveFrom,
          sessions: [{ weekday: 1, startMinute: 540, endMinute: 1080 }],
        },
      );
    const past = await failure(put(addDays(today, -1)));
    expect(past.status).toBe(400);
    expect(past.code).toBe("validation_failed");
    // First set from today succeeds (closes the rows in force across today)…
    const set = (await put(today)) as { items: WorkingHoursResponse[] };
    expect(set.items[0]?.effectiveFrom).toBe(today);
    // …but those rows took effect today, so replacing them again today is refused.
    const again = await failure(put(today));
    expect(again.status).toBe(409);
    expect(again.code).toBe("working_hours_in_force");
    expect(describeSchedulingError(again).message).toMatch(/tomorrow/i);
    // From tomorrow is fine.
    expect(((await put(addDays(today, 1))) as { items: unknown[] }).items).toHaveLength(1);
  });
});

const row = (o: Partial<WorkingHoursResponse>): WorkingHoursResponse => ({
  id: fid("32", Math.floor(Math.random() * 1e6)),
  scope: "BRANCH",
  branchId: B1,
  userId: null,
  chairId: null,
  weekday: 3,
  startMinute: 540,
  endMinute: 780,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  createdBy: "u",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

describe("effective hours (mirrors apps/api/src/scheduling/hours.ts)", () => {
  test("intersect keeps only overlaps, sorted", () => {
    expect(
      intersect(
        [
          { start: 540, end: 780 },
          { start: 900, end: 1200 },
        ],
        [{ start: 600, end: 960 }],
      ),
    ).toEqual([
      { start: 600, end: 780 },
      { start: 900, end: 960 },
    ]);
    expect(intersect([{ start: 0, end: 60 }], [{ start: 60, end: 120 }])).toEqual([]);
  });

  test("branch ∩ dentist ∩ chair; dentist rows elsewhere close this branch", () => {
    const D = fid("00", 7);
    const rows = [
      row({}),
      row({ startMinute: 990, endMinute: 1230 }),
      row({ scope: "DENTIST", userId: D, startMinute: 600, endMinute: 1080 }),
      row({ scope: "CHAIR", chairId: OP1, startMinute: 0, endMinute: 720 }),
    ];
    // No branch object → id "" → no BRANCH rows and no JSON → unrestricted, like the API's null.
    expect(effectiveHours(rows, undefined, DAY)).toEqual([...FULL_DAY]);
    const branch = { id: B1, workingHours: null } as unknown as Parameters<
      typeof effectiveHours
    >[1];
    expect(effectiveHours(rows, branch, DAY, { dentistUserId: D, chairId: OP1 })).toEqual([
      { start: 600, end: 720 },
    ]);
    // Dentist only has rows at another branch → no time here.
    const elsewhere = [row({}), row({ scope: "DENTIST", userId: D, branchId: fid("0b", 2) })];
    expect(effectiveHours(elsewhere, branch, DAY, { dentistUserId: D })).toEqual([]);
    // No DENTIST rows at all → branch hours apply.
    expect(effectiveHours([row({})], branch, DAY, { dentistUserId: D })).toEqual([
      { start: 540, end: 780 },
    ]);
  });

  test("branch JSON never configured (null or {}) is unrestricted, as in the API; configured but empty that day is closed", () => {
    type B = Parameters<typeof effectiveHours>[1];
    const unset = { id: B1, workingHours: {} } as unknown as B;
    const nullJson = { id: B1, workingHours: null } as unknown as B;
    const weekdaysOnly = {
      id: B1,
      workingHours: { mon: [{ open: "09:00", close: "17:00" }] },
    } as unknown as B;
    expect(branchJsonHours(unset, 3)).toBeNull();
    expect(branchJsonHours(nullJson, 3)).toBeNull();
    expect(branchJsonHours(weekdaysOnly, 1)).toEqual([{ start: 540, end: 1020 }]);
    expect(branchJsonHours(weekdaysOnly, 3)).toEqual([]); // DAY is a Wednesday: closed
    // A new branch (DB default {}) accepts bookings at any hour, e.g. 03:00.
    expect(covers(effectiveHours([], unset, DAY), 180, 210)).toBe(true);
    expect(covers(effectiveHours([], weekdaysOnly, DAY), 600, 630)).toBe(false);
    // Unrestricted branch ∩ dentist rows → the dentist's hours.
    const D = fid("00", 7);
    expect(
      effectiveHours([row({ scope: "DENTIST", userId: D })], unset, DAY, { dentistUserId: D }),
    ).toEqual([{ start: 540, end: 780 }]);
  });

  test("effective dating: [from, to) and periods grouped past/current/scheduled", () => {
    const rows = [
      row({ effectiveFrom: "2026-01-01", effectiveTo: "2026-11-01" }),
      row({ effectiveFrom: "2026-11-01", weekday: 1 }),
      row({ effectiveFrom: "2026-11-01", weekday: 1, startMinute: 900, endMinute: 1000 }),
      row({ effectiveFrom: "2027-02-01", weekday: 2 }),
    ];
    // Closing rows are exclusive at effectiveTo.
    expect(scheduleOn(rows.slice(0, 1), "2026-10-31")?.sessions).toHaveLength(1);
    expect(scheduleOn(rows.slice(0, 1), "2026-11-01")).toBeUndefined();
    const periods = hoursPeriods(rows, "2026-11-20");
    expect(periods.map((p) => [p.effectiveFrom, p.state])).toEqual([
      ["2027-02-01", "scheduled"],
      ["2026-11-01", "current"],
      ["2026-01-01", "past"],
    ]);
    expect(periods[1]?.sessions.map((s) => s.startMinute)).toEqual([540, 900]);
  });
});

describe("live updates (GET /events SSE)", () => {
  test("parser handles CRLF, multi-line data, comments and a partial tail", () => {
    const { messages, rest } = parseSseChunk(
      ': ping\r\n\r\nevent: appointment.status_changed\r\ndata: {"a":\r\ndata: 1}\r\nid: 7\r\n\r\nevent: appoint',
    );
    expect(messages).toEqual([{ event: "appointment.status_changed", data: '{"a":\n1}', id: "7" }]);
    expect(rest).toBe("event: appoint");
  });

  test("filters to scheduling events of the selected branch (tenant-wide events kept)", () => {
    const B2 = fid("0b", 2);
    const msg = (event: string, data: unknown) => ({ event, data: JSON.stringify(data) });
    expect(toSchedulingChange(msg("ping", {}), B1)).toBeNull();
    expect(
      toSchedulingChange(msg("appointment.created", { appointmentId: "x", branchId: B2 }), B1),
    ).toBeNull();
    expect(
      toSchedulingChange(msg("appointment.created", { appointmentId: "x", branchId: B1 }), B1),
    ).toEqual({
      type: "appointment.created",
      appointmentId: "x",
      branchId: B1,
      toStatus: undefined,
    });
    expect(toSchedulingChange({ event: "appointment.created", data: "{bad" }, B1)).toBeNull();
  });
});
