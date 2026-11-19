import { describe, expect, test } from "bun:test";
import { schedulingEventData } from "@dentalos/validation";
import { ConflictException } from "@nestjs/common";
import { EventBus } from "../realtime/event-bus";
import { assertCheckInDay } from "./appointments.service";
import {
  allowedHours,
  branchJsonHours,
  covers,
  intersectHours,
  mergeIntervals,
  sessionsOn,
} from "./hours";
import { isRetryableTxError, rethrowDb, retryTx, schedulingEvent } from "./scheduling-common";

const T = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P = "33333333-3333-4333-8333-333333333333";
const A = "44444444-4444-4444-8444-444444444444";

describe("working-hours interval maths", () => {
  test("merge sorts and joins overlapping/adjacent sessions", () => {
    expect(
      mergeIntervals([
        [780, 1020],
        [540, 780],
        [1100, 1200],
      ]),
    ).toEqual([
      [540, 1020],
      [1100, 1200],
    ]);
  });

  test("intersection; null = unrestricted identity", () => {
    expect(intersectHours(null, null)).toBeNull();
    expect(intersectHours(null, [[540, 1080]])).toEqual([[540, 1080]]);
    expect(
      intersectHours(
        [
          [540, 780],
          [840, 1080],
        ],
        [[600, 900]],
      ),
    ).toEqual([
      [600, 780],
      [840, 900],
    ]);
    expect(intersectHours([[540, 600]], [[600, 660]])).toEqual([]);
  });

  test("covers is half-open and needs one interval to hold the whole slot", () => {
    const h = [[540, 1080]] as const;
    expect(covers([...h], 540, 570)).toBe(true);
    expect(covers([...h], 1050, 1080)).toBe(true);
    expect(covers([...h], 1060, 1090)).toBe(false);
    expect(
      covers(
        [
          [540, 780],
          [840, 1080],
        ],
        760,
        860,
      ),
    ).toBe(false);
    expect(covers(null, 0, 1440)).toBe(true);
    expect(covers([], 600, 630)).toBe(false);
  });

  test("sessionsOn filters by weekday", () => {
    const rows = [
      { weekday: 1, startMinute: 540, endMinute: 780 },
      { weekday: 1, startMinute: 780, endMinute: 1080 },
      { weekday: 2, startMinute: 600, endMinute: 700 },
    ];
    expect(sessionsOn(rows, 1)).toEqual([[540, 1080]]);
    expect(sessionsOn(rows, 0)).toEqual([]);
  });

  test("M1 Branch.workingHours JSON fallback (0 = Sunday); {} = never configured", () => {
    const json = { mon: [{ open: "09:00", close: "13:00" }], sun: [] };
    expect(branchJsonHours(json, 1)).toEqual([[540, 780]]);
    expect(branchJsonHours(json, 0)).toEqual([]);
    expect(branchJsonHours(json, 3)).toEqual([]);
    expect(branchJsonHours({}, 1)).toBeNull();
  });

  test("allowedHours = branch ∩ dentist ∩ chair", () => {
    const ctx = {
      branch: [[540, 1080]] as [number, number][],
      dentist: [[600, 1200]] as [number, number][],
      chairs: new Map<string, [number, number][] | null>([
        ["c1", [[540, 720]]],
        ["c2", null],
      ]),
    };
    expect(allowedHours(ctx)).toEqual([[600, 1080]]);
    expect(allowedHours(ctx, "c1")).toEqual([[600, 720]]);
    expect(allowedHours(ctx, "c2")).toEqual([[600, 1080]]);
    expect(allowedHours({ ...ctx, dentist: [] })).toEqual([]);
  });
});

describe("realtime scheduling events", () => {
  const appt = {
    id: A,
    tenantId: T,
    branchId: B,
    patientId: P,
    startsAt: new Date("2026-12-01T04:30:00.000Z"),
  };

  test("payload carries ids/status only and matches schedulingEventData", () => {
    const e = schedulingEvent("appointment.status_changed", appt, "BOOKED", "CHECKED_IN");
    expect(e).toEqual({
      tenantId: T,
      branchId: B,
      type: "appointment.status_changed",
      data: {
        appointmentId: A,
        patientId: P,
        fromStatus: "BOOKED",
        toStatus: "CHECKED_IN",
        startsAt: "2026-12-01T04:30:00.000Z",
      },
    });
    expect(schedulingEventData.safeParse(e.data).success).toBe(true);
  });

  test("extra fields from the row (names, notes) never reach the payload", () => {
    const row = { ...appt, notes: "secret", patient: { firstName: "X" } };
    const e = schedulingEvent("appointment.created", row, null, "BOOKED");
    expect(Object.keys(e.data).sort()).toEqual(
      ["appointmentId", "fromStatus", "patientId", "startsAt", "toStatus"].sort(),
    );
  });

  test("rescheduled events carry the successor id; bus fans out to subscribers", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.stream.subscribe((ev) => seen.push(`${ev.type}:${String(ev.data.newAppointmentId)}`));
    bus.publish(
      schedulingEvent("appointment.rescheduled", appt, "BOOKED", "RESCHEDULED", {
        newAppointmentId: P,
      }),
    );
    expect(seen).toEqual([`appointment.rescheduled:${P}`]);
    bus.onModuleDestroy();
  });
});

describe("DB error mapping", () => {
  const catchIt = (e: unknown) => {
    try {
      rethrowDb(e);
    } catch (x) {
      return x;
    }
  };

  test("23P01 on the dentist/chair constraint -> 409 slot_conflict {resource}", () => {
    const err = catchIt(
      new Error(
        'Error occurred during query execution: ... code: "23P01", message: "conflicting key value violates exclusion constraint \\"Appointment_chair_no_overlap\\""',
      ),
    ) as ConflictException;
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ error: "slot_conflict", resource: "chair" });
  });

  test("HttpExceptions pass through; unknown errors are rethrown unchanged", () => {
    const http = new ConflictException({ error: "x" });
    expect(catchIt(http)).toBe(http);
    const other = new Error("boom");
    expect(catchIt(other)).toBe(other);
  });
});

describe("deadlock retry", () => {
  const deadlock = () =>
    new Error(
      'Error occurred during query execution: ConnectorError(... code: "40P01", message: "deadlock detected" ...)',
    );

  test("deadlock / serialization failures are retryable; others are not", () => {
    expect(isRetryableTxError(deadlock())).toBe(true);
    expect(isRetryableTxError(new Error('code: "40001", could not serialize access'))).toBe(true);
    expect(isRetryableTxError(new Error("boom"))).toBe(false);
    expect(isRetryableTxError(new ConflictException({ error: "deadlock detected" }))).toBe(false);
  });

  test("retryTx re-runs the transaction after a deadlock, then surfaces the real outcome", async () => {
    let calls = 0;
    const slot = new Error('code: "23P01" exclusion constraint "Appointment_chair_no_overlap"');
    const run = async () => {
      calls++;
      if (calls === 1) throw deadlock();
      throw slot;
    };
    await expect(retryTx(run)).rejects.toBe(slot);
    expect(calls).toBe(2);

    let n = 0;
    expect(await retryTx(async () => (++n < 3 ? Promise.reject(deadlock()) : "ok"))).toBe("ok");
    expect(n).toBe(3);
  });

  test("gives up after the attempt budget; non-retryable errors are not retried", async () => {
    let n = 0;
    await expect(
      retryTx(async () => {
        n++;
        throw deadlock();
      }, 2),
    ).rejects.toThrow("deadlock detected");
    expect(n).toBe(2);
    let m = 0;
    await expect(
      retryTx(async () => {
        m++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(m).toBe(1);
  });
});

describe("assertCheckInDay (same branch-local day, or within the walk-in window)", () => {
  const TZ = "Asia/Kolkata"; // UTC+05:30
  // 2026-11-19 local midnight = 2026-11-18T18:30Z.
  const local = (day: number, hh: number, mm = 0) =>
    new Date(Date.UTC(2026, 10, day, hh, mm) - 330 * 60_000);
  const err = (startsAt: Date, now: Date) => {
    try {
      assertCheckInDay(startsAt, TZ, now);
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      return (e as ConflictException).getResponse();
    }
  };

  test("same local day, earlier or later: ok", () => {
    expect(err(local(19, 9), local(19, 17))).toBeNull();
    expect(err(local(19, 23, 30), local(19, 0, 5))).toBeNull();
  });

  test("future day: check_in_too_early from that day's local midnight", () => {
    expect(err(local(20, 10), local(19, 23))).toEqual({
      error: "check_in_too_early",
      eligibleFrom: "2026-11-19T18:30:00.000Z",
    });
    expect(err(local(30, 10), local(19, 10))).toMatchObject({ error: "check_in_too_early" });
  });

  test("past day: check_in_too_late", () => {
    expect(err(local(18, 22), local(19, 0, 10))).toEqual({
      error: "check_in_too_late",
      startsAt: local(18, 22).toISOString(),
    });
  });

  test("across midnight inside the walk-in window: ok", () => {
    expect(err(local(18, 23, 50), local(19, 0, 10))).toBeNull();
    expect(err(local(20, 0, 15), local(19, 23, 55))).toBeNull();
  });
});
