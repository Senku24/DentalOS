import { describe, expect, test } from "bun:test";
import {
  addDays,
  addMonths,
  assignLanes,
  ceilToStep,
  daysBetween,
  formatTime,
  formatTimeRange,
  gridBounds,
  isValidDay,
  localOf,
  minutesBetween,
  queryRange,
  rangeLabel,
  rowOf,
  shiftAnchor,
  startOfMonth,
  startOfWeek,
  timeOptions,
  todayIn,
  visibleDays,
  weekdayOf,
  zonedIso,
} from "./scheduling-time";

const NY = "America/New_York"; // DST 2026: starts 8 Mar, ends 1 Nov
const LON = "Europe/London"; // DST 2026 ends 25 Oct
const IST = "Asia/Kolkata"; // no DST

describe("calendar days (DST-safe: pure calendar arithmetic)", () => {
  test("addDays steps exactly one calendar day across DST changes", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-11-02", "2026-10-31")).toBe(-2);
  });

  test("addMonths clamps to the last day of the month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  test("weekday, week and month starts (Monday-first)", () => {
    expect(weekdayOf("2026-11-19")).toBe(4);
    expect(weekdayOf("2026-11-22")).toBe(0);
    expect(startOfWeek("2026-11-22")).toBe("2026-11-16");
    expect(startOfWeek("2026-11-16")).toBe("2026-11-16");
    expect(startOfWeek("2026-11-22", 0)).toBe("2026-11-22");
    expect(startOfMonth("2026-11-19")).toBe("2026-11-01");
  });

  test("visible days per view", () => {
    expect(visibleDays("day", "2026-11-19")).toEqual(["2026-11-19"]);
    const week = visibleDays("week", "2026-11-19");
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2026-11-16");
    expect(week[6]).toBe("2026-11-22");
    const month = visibleDays("month", "2026-11-19");
    expect(month).toHaveLength(42);
    expect(month[0]).toBe("2026-10-26");
    expect(month[41]).toBe("2026-12-06");
    // A week spanning the NY fall-back still has 7 distinct days.
    expect(new Set(visibleDays("week", "2026-11-01")).size).toBe(7);
  });

  test("shiftAnchor moves by the view's period", () => {
    expect(shiftAnchor("day", "2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftAnchor("week", "2026-11-19", -1)).toBe("2026-11-12");
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-28");
  });

  test("isValidDay rejects impossible dates", () => {
    expect(isValidDay("2026-02-29")).toBe(false);
    expect(isValidDay("2028-02-29")).toBe(true);
    expect(isValidDay("2026-13-01")).toBe(false);
    expect(isValidDay("19-11-2026")).toBe(false);
    expect(isValidDay(null)).toBe(false);
  });

  test("range labels", () => {
    expect(rangeLabel("week", "2026-11-19")).toContain("2026");
    expect(rangeLabel("month", "2026-11-19")).toMatch(/November 2026/);
  });
});

describe("instants in the branch time zone", () => {
  test("local midnight resolves per day: 23 h and 25 h days stay one day", () => {
    expect(zonedIso("2026-03-08", 0, NY)).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedIso("2026-03-09", 0, NY)).toBe("2026-03-09T04:00:00.000Z");
    expect(zonedIso("2026-11-01", 0, NY)).toBe("2026-11-01T04:00:00.000Z");
    expect(zonedIso("2026-11-02", 0, NY)).toBe("2026-11-02T05:00:00.000Z");
    expect(zonedIso("2026-11-19", 630, IST)).toBe("2026-11-19T05:00:00.000Z");
  });

  test("queryRange covers whole local days", () => {
    const springDay = queryRange(["2026-03-08"], NY);
    expect(minutesBetween(springDay.from, springDay.to)).toBe(23 * 60);
    const fallDay = queryRange(["2026-11-01"], NY);
    expect(minutesBetween(fallDay.from, fallDay.to)).toBe(25 * 60);
    const londonFall = queryRange(["2026-10-25"], LON);
    expect(minutesBetween(londonFall.from, londonFall.to)).toBe(25 * 60);
  });

  test("a 6-week month grid crossing fall-back is trimmed to the API's 42 × 24 h cap", () => {
    const days = visibleDays("month", "2026-11-19");
    const ny = queryRange(days, NY);
    expect(ny.days).toHaveLength(41);
    expect(Date.parse(ny.to) - Date.parse(ny.from)).toBeLessThanOrEqual(42 * 86_400_000);
    expect(ny.days.at(-1)).toBe("2026-12-05");
    const ist = queryRange(days, IST);
    expect(ist.days).toHaveLength(42);
    expect(Date.parse(ist.to) - Date.parse(ist.from)).toBe(42 * 86_400_000);
    // Spring-forward grid (23 h day) needs no trimming.
    expect(queryRange(visibleDays("month", "2026-03-15"), NY).days).toHaveLength(42);
  });

  test("wall-clock readback, including the repeated hour at fall-back", () => {
    expect(formatTime("2026-11-19T05:00:00.000Z", IST)).toBe("10:30");
    expect(formatTimeRange("2026-11-19T05:00:00.000Z", "2026-11-19T05:30:00.000Z", IST)).toBe(
      "10:30–11:00",
    );
    const edt = localOf("2026-11-01T05:30:00.000Z", NY);
    const est = localOf("2026-11-01T06:30:00.000Z", NY);
    expect(edt).toMatchObject({ date: "2026-11-01", minuteOfDay: 90 });
    expect(est).toMatchObject({ date: "2026-11-01", minuteOfDay: 90 });
    // Real elapsed time, not wall-clock difference.
    expect(minutesBetween("2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z")).toBe(60);
  });

  test("todayIn uses the branch's calendar date", () => {
    expect(todayIn(IST, new Date("2026-11-19T20:00:00Z"))).toBe("2026-11-20");
    expect(todayIn(NY, new Date("2026-11-20T03:00:00Z"))).toBe("2026-11-19");
  });
});

describe("time grid helpers", () => {
  test("grid bounds widen to whole hours with a default", () => {
    expect(gridBounds([])).toEqual({ startMinute: 480, endMinute: 1200 });
    expect(
      gridBounds([
        { startMinute: 570, endMinute: 810 },
        { startMinute: 990, endMinute: 1230 },
      ]),
    ).toEqual({ startMinute: 540, endMinute: 1260 });
    expect(gridBounds([{ startMinute: 1430, endMinute: 1440 }])).toEqual({
      startMinute: 1380,
      endMinute: 1440,
    });
  });

  test("lanes: overlaps go side by side, touching items share a lane", () => {
    const lanes = assignLanes([
      { id: "a", start: 600, end: 660 },
      { id: "b", start: 630, end: 690 },
      { id: "c", start: 660, end: 720 },
      { id: "d", start: 800, end: 830 },
    ]);
    expect(lanes.get("a")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("b")).toEqual({ lane: 1, lanes: 2 });
    expect(lanes.get("c")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("d")).toEqual({ lane: 0, lanes: 1 });
  });

  test("rows, steps and time options", () => {
    expect(rowOf(540, 540, 15)).toBe(1);
    expect(rowOf(600, 540, 15)).toBe(5);
    expect(ceilToStep(601, 15)).toBe(615);
    expect(ceilToStep(600, 15)).toBe(600);
    expect(timeOptions(30, 540, 660)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
    expect(timeOptions(15)).toHaveLength(96);
  });
});
