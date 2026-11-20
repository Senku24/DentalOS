import { describe, expect, test } from "bun:test";
import type { Permission } from "@dentalos/contracts";
import { ROLE_PERMISSIONS } from "@dentalos/contracts";
import type { AppointmentStatus } from "@dentalos/validation";
import { mapHttpError, networkError } from "./errors";
import { buildSchedulingFixtures } from "./scheduling-fixtures";
import {
  APPOINTMENT_LIST_CAP,
  type CanFn,
  calendarStatuses,
  checkInWindow,
  closedNote,
  describeSchedulingError,
  isBookablePlan,
  listTruncated,
  manageActions,
  statusActions,
} from "./scheduling-rules";
import { zonedIso } from "./scheduling-time";

const IST = "Asia/Kolkata";
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";
// Thu 19 Nov 2026, 11:00 IST
const NOW = new Date(zonedIso("2026-11-19", 660, IST));

const roleCan =
  (role: keyof typeof ROLE_PERMISSIONS, branches: string[] = [B1]): CanFn =>
  (perm, res) =>
    (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(perm) &&
    (!res?.branchId || branches.includes(res.branchId));

const appt = (status: AppointmentStatus, day = "2026-11-19", minute = 720, branchId = B1) => ({
  status,
  branchId,
  startsAt: zonedIso(day, minute, IST),
});
const targets = (a: ReturnType<typeof appt>, can: CanFn, grace?: number) =>
  statusActions(a, { can, now: NOW, timeZone: IST, noShowGraceMinutes: grace }).map((x) => x.to);

describe("status transition gating (display only)", () => {
  test("receptionist on a booked visit today: confirm, check in, no-show", () => {
    expect(targets(appt("BOOKED"), roleCan("RECEPTIONIST"))).toEqual([
      "CONFIRMED",
      "CHECKED_IN",
      "NO_SHOW",
    ]);
  });

  test("only allowedAppointmentTransitions are offered", () => {
    const can = roleCan("MANAGER");
    expect(targets(appt("CONFIRMED"), can)).toEqual(["CHECKED_IN", "NO_SHOW"]);
    expect(targets(appt("CHECKED_IN"), can)).toEqual(["IN_CHAIR"]);
    expect(targets(appt("IN_CHAIR"), can)).toEqual(["COMPLETED"]);
    for (const closed of ["COMPLETED", "CANCELLED", "NO_SHOW", "RESCHEDULED"] as const)
      expect(targets(appt(closed), can)).toEqual([]);
  });

  test("permission per target: a dentist seats and completes, but never checks in", () => {
    const dentist = roleCan("DENTIST");
    expect(targets(appt("BOOKED"), dentist)).toEqual([]);
    expect(targets(appt("CHECKED_IN"), dentist)).toEqual(["IN_CHAIR"]);
    expect(targets(appt("IN_CHAIR"), dentist)).toEqual(["COMPLETED"]);
    expect(targets(appt("BOOKED"), roleCan("ACCOUNTANT"))).toEqual([]);
  });

  test("permission is checked against the appointment's branch", () => {
    expect(targets(appt("BOOKED", "2026-11-19", 720, B2), roleCan("RECEPTIONIST", [B1]))).toEqual(
      [],
    );
  });

  test("check-in is disabled (with a reason) when the visit is not today", () => {
    const can = roleCan("RECEPTIONIST");
    const tomorrow = statusActions(appt("BOOKED", "2026-11-20"), {
      can,
      now: NOW,
      timeZone: IST,
    }).find((x) => x.to === "CHECKED_IN");
    expect(tomorrow?.enabled).toBe(false);
    expect(tomorrow?.reason).toMatch(/Check-in opens on/);
    const yesterday = statusActions(appt("BOOKED", "2026-11-18"), {
      can,
      now: NOW,
      timeZone: IST,
    }).find((x) => x.to === "CHECKED_IN");
    expect(yesterday?.enabled).toBe(false);
    expect(yesterday?.reason).toMatch(/no-show or reschedule/);
    const today = statusActions(appt("BOOKED", "2026-11-19", 1200), {
      can,
      now: NOW,
      timeZone: IST,
    }).find((x) => x.to === "CHECKED_IN");
    expect(today?.enabled).toBe(true);
  });

  test("no-show waits for the grace period", () => {
    const can = roleCan("RECEPTIONIST");
    const noShow = (minute: number, grace?: number) =>
      statusActions(appt("BOOKED", "2026-11-19", minute), {
        can,
        now: NOW,
        timeZone: IST,
        noShowGraceMinutes: grace,
      }).find((x) => x.to === "NO_SHOW");
    expect(noShow(650)?.enabled).toBe(false); // started 10 min ago, default grace 15
    expect(noShow(650)?.reason).toMatch(/11:05/);
    expect(noShow(640)?.enabled).toBe(true);
    expect(noShow(650, 5)?.enabled).toBe(true);
  });

  test("checkInWindow mirrors the API: ±30 min of start, else the visit's local day", () => {
    const start = zonedIso("2026-11-20", 10, IST); // 00:10 tomorrow, 13 h away
    expect(checkInWindow(start, IST, NOW)).toEqual({
      ok: false,
      reason: "too_early",
      eligibleDay: "2026-11-20",
    });
    // 23:50 tonight → visit just after midnight is within the walk-in window
    expect(checkInWindow(start, IST, new Date(zonedIso("2026-11-19", 1430, IST)))).toEqual({
      ok: true,
    });
    expect(checkInWindow(zonedIso("2026-11-18", 600, IST), IST, NOW)).toMatchObject({
      reason: "too_late",
    });
  });

  test("manage actions follow the state machine and appointment:write", () => {
    const rec = roleCan("RECEPTIONIST");
    expect(manageActions(appt("BOOKED"), rec)).toEqual({
      cancel: true,
      reschedule: true,
      edit: true,
    });
    expect(manageActions(appt("CHECKED_IN"), rec)).toEqual({
      cancel: true,
      reschedule: false,
      edit: true,
    });
    expect(manageActions(appt("IN_CHAIR"), rec)).toEqual({
      cancel: false,
      reschedule: false,
      edit: true,
    });
    expect(manageActions(appt("COMPLETED"), rec)).toEqual({
      cancel: false,
      reschedule: false,
      edit: false,
    });
    expect(manageActions(appt("BOOKED"), roleCan("DENTIST"))).toEqual({
      cancel: false,
      reschedule: false,
      edit: false,
    });
  });
});

describe("scheduling error mapping", () => {
  test("409 slot_conflict names the double-booked resource and its field", () => {
    const chair = describeSchedulingError(
      mapHttpError(409, { error: "slot_conflict", resource: "chair" }),
      { chairLabel: "OP1" },
    );
    expect(chair).toMatchObject({
      resource: "chair",
      field: "chairId",
      title: "Chair already booked",
    });
    expect(chair.message).toContain("Chair OP1");
    const dentist = describeSchedulingError(
      mapHttpError(409, { error: "slot_conflict", resource: "dentist" }),
      { dentistLabel: "Dr. Iyer" },
    );
    expect(dentist).toMatchObject({ resource: "dentist", field: "dentistUserId" });
    expect(dentist.message).toContain("Dr. Iyer");
  });

  test("outside_working_hours offers the override reason only with schedule:manage", () => {
    const e = mapHttpError(409, {
      error: "outside_working_hours",
      message: "Outside working hours: needs schedule:manage and outsideHoursReason",
    });
    expect(describeSchedulingError(e, { canManageSchedule: true }).offerOutsideHoursReason).toBe(
      true,
    );
    const noManage = describeSchedulingError(e, { canManageSchedule: false });
    expect(noManage.offerOutsideHoursReason).toBe(false);
    expect(noManage.message).toMatch(/ask a manager/);
    const forbidden = describeSchedulingError(
      mapHttpError(409, {
        error: "outside_working_hours",
        message: "This branch does not allow bookings outside working hours",
      }),
      { canManageSchedule: true },
    );
    expect(forbidden.offerOutsideHoursReason).toBe(false);
    expect(forbidden.field).toBe("startsAt");
  });

  test("invalid_transition lists what is allowed", () => {
    const p = describeSchedulingError(
      mapHttpError(409, {
        error: "invalid_transition",
        from: "CHECKED_IN",
        to: "NO_SHOW",
        allowed: ["IN_CHAIR", "CANCELLED"],
      }),
    );
    expect(p.message).toContain("Waiting to No-show");
    expect(p.message).toContain("In chair, Cancelled");
    const closed = describeSchedulingError(
      mapHttpError(409, {
        error: "invalid_transition",
        from: "COMPLETED",
        to: "CANCELLED",
        allowed: [],
      }),
    );
    expect(closed.message).toContain("it is closed");
  });

  test("check-in day and no-show grace errors carry the branch-local time", () => {
    const early = describeSchedulingError(
      mapHttpError(409, {
        error: "check_in_too_early",
        eligibleFrom: zonedIso("2026-11-20", 0, IST),
      }),
      { timeZone: IST },
    );
    expect(early.title).toBe("Too early to check in");
    expect(early.message).toContain("00:00");
    const late = describeSchedulingError(
      mapHttpError(409, { error: "check_in_too_late", startsAt: zonedIso("2026-11-18", 600, IST) }),
      { timeZone: IST },
    );
    expect(late.message).toContain("10:00");
    const grace = describeSchedulingError(
      mapHttpError(409, {
        error: "no_show_too_early",
        eligibleAt: zonedIso("2026-11-19", 675, IST),
      }),
      { timeZone: IST },
    );
    expect(grace.message).toContain("11:15");
  });

  test("patient_merged points at the surviving record", () => {
    const p = describeSchedulingError(
      mapHttpError(409, { error: "patient_merged", survivorId: "p-2" }),
    );
    expect(p).toMatchObject({ code: "patient_merged", field: "patientId", survivorId: "p-2" });
  });

  test("working-hours, chair and validation errors map to fields", () => {
    expect(
      describeSchedulingError(mapHttpError(409, { error: "working_hours_in_force" })),
    ).toMatchObject({ field: "effectiveFrom", title: "Hours already in force today" });
    expect(describeSchedulingError(mapHttpError(409, { error: "chair_code_taken" }))).toMatchObject(
      { field: "code" },
    );
    expect(describeSchedulingError(mapHttpError(409, { error: "chair_inactive" }))).toMatchObject({
      field: "chairId",
    });
    const v = describeSchedulingError(
      mapHttpError(400, {
        error: "validation_failed",
        issues: [{ path: "durationMin", message: "Too big" }],
      }),
    );
    expect(v).toMatchObject({ field: "durationMin", fieldErrors: { durationMin: "Too big" } });
    expect(describeSchedulingError(networkError()).title).toBe("Couldn't save");
  });
});

describe("review fixes", () => {
  test("plan-item link offers PARTIALLY_ACCEPTED plans (the fixture plan) and no invalid statuses", () => {
    const plans = buildSchedulingFixtures(NOW).plans;
    const partial = plans.find((p) => p.status === "PARTIALLY_ACCEPTED");
    expect(partial?.items.some((i) => i.status === "ACCEPTED")).toBe(true);
    expect(isBookablePlan(partial as NonNullable<typeof partial>)).toBe(true);
    expect(isBookablePlan({ status: "PRESENTED" })).toBe(true);
    expect(isBookablePlan({ status: "ACCEPTED" })).toBe(true);
    for (const status of ["DRAFT", "REJECTED", "COMPLETED", "CANCELLED"] as const)
      expect(isBookablePlan({ status })).toBe(false);
  });

  test("calendar asks only for shown statuses so hidden rows don't use the 1000-row cap", () => {
    expect(calendarStatuses(false)).toEqual([
      "BOOKED",
      "CONFIRMED",
      "CHECKED_IN",
      "IN_CHAIR",
      "COMPLETED",
    ]);
    expect(calendarStatuses(true)).toEqual([
      "BOOKED",
      "CONFIRMED",
      "CHECKED_IN",
      "IN_CHAIR",
      "COMPLETED",
      "CANCELLED",
      "NO_SHOW",
    ]);
    expect(calendarStatuses(true)).not.toContain("RESCHEDULED");
    expect(listTruncated(new Array(APPOINTMENT_LIST_CAP - 1))).toBe(false);
    expect(listTruncated(new Array(APPOINTMENT_LIST_CAP))).toBe(true);
  });

  test("closed-state note follows the status, not the caller's permission", () => {
    const dentist = roleCan("DENTIST");
    const checkedIn = appt("CHECKED_IN");
    // A dentist can't edit, but a checked-in visit is not closed (they can seat the patient).
    expect(closedNote(checkedIn, manageActions(checkedIn, dentist))).toBe(
      "Your role can't edit, reschedule or cancel appointments.",
    );
    expect(targets(checkedIn, dentist)).toContain("IN_CHAIR");
    const booked = appt("BOOKED");
    expect(closedNote(booked, manageActions(booked, roleCan("RECEPTIONIST")))).toBeNull();
    for (const status of ["COMPLETED", "CANCELLED", "NO_SHOW", "RESCHEDULED"] as const) {
      const a = appt(status);
      expect(closedNote(a, manageActions(a, roleCan("OWNER")))).toMatch(/can no longer change/);
    }
  });
});
