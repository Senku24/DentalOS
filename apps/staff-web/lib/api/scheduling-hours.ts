import type { BranchResponse, WorkingHoursResponse } from "@dentalos/validation";
import { hhmmToMinutes } from "@dentalos/validation";
import { weekdayOf } from "./scheduling-time";

/**
 * Effective working hours, mirroring apps/api/src/scheduling/hours.ts: on a local day the bookable
 * time is branch hours (BRANCH rows in force, else the M1 Branch.workingHours JSON; a JSON that was
 * never configured — null or {} — means unrestricted, like the API) ∩ the dentist's hours (when the
 * dentist has DENTIST rows in force anywhere: only the rows at this branch count) ∩ the chair's
 * hours (when set). Used to shade closed time on the calendar and by the mock API.
 *
 * The "anywhere" part only works on the rows the caller passes: GET /working-hours is filtered by
 * branchId, so a dentist's rows at other branches must be fetched separately (the calendar does so
 * for the dentist filter, for branches in the user's scope). Rows at branches the user can't read
 * stay invisible, so calendar shading is approximate; GET /availability is the server's answer.
 */

export interface Interval {
  start: number;
  end: number;
}

/** Sorted union-free intersection of two interval lists ([start, end) minutes). */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a)
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (start < end) out.push({ start, end });
    }
  return out.sort((p, q) => p.start - q.start);
}

export const covers = (hours: readonly Interval[], start: number, end: number) =>
  hours.some((h) => h.start <= start && end <= h.end);

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Unrestricted (the API's `null` hours): the whole local day. */
export const FULL_DAY: readonly Interval[] = Object.freeze([{ start: 0, end: 24 * 60 }]);

/**
 * M1 Branch.workingHours JSON for a weekday (fallback when no BRANCH rows exist). `null` when the
 * JSON was never configured (null or {} — the DB default), which the API treats as unrestricted;
 * `[]` (closed) when it is configured but has no sessions that day.
 */
export function branchJsonHours(
  branch: BranchResponse | undefined,
  weekday: number,
): Interval[] | null {
  const json = branch?.workingHours as Record<string, unknown> | null | undefined;
  if (!json || typeof json !== "object" || Object.keys(json).length === 0) return null;
  const day = json[WEEKDAY_KEYS[weekday] as (typeof WEEKDAY_KEYS)[number]];
  if (!Array.isArray(day)) return [];
  const out: Interval[] = [];
  for (const s of day as { open: string; close: string }[]) {
    try {
      out.push({ start: hhmmToMinutes(s.open), end: hhmmToMinutes(s.close) });
    } catch {
      // Malformed entries are ignored, as in the API.
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

export const inForce = (w: WorkingHoursResponse, day: string) =>
  w.effectiveFrom <= day && (w.effectiveTo === null || w.effectiveTo > day);

/** Rows of one subject in force on `day` and that weekday; `null` when the subject has no rows at all that day. */
export function subjectHours(
  rows: readonly WorkingHoursResponse[],
  subject: {
    scope: WorkingHoursResponse["scope"];
    branchId: string;
    userId?: string;
    chairId?: string;
  },
  day: string,
): Interval[] | null {
  const mine = rows.filter(
    (w) =>
      w.scope === subject.scope &&
      (subject.scope === "DENTIST" || w.branchId === subject.branchId) &&
      (subject.scope !== "DENTIST" || w.userId === subject.userId) &&
      (subject.scope !== "CHAIR" || w.chairId === subject.chairId) &&
      inForce(w, day),
  );
  if (mine.length === 0) return null;
  const wd = weekdayOf(day);
  return mine
    .filter(
      (w) => w.weekday === wd && (subject.scope !== "DENTIST" || w.branchId === subject.branchId),
    )
    .map((w) => ({ start: w.startMinute, end: w.endMinute }))
    .sort((p, q) => p.start - q.start);
}

/** Effective hours (branch ∩ dentist ∩ chair) on a local day, like apps/api/src/scheduling/hours.ts. */
export function effectiveHours(
  rows: readonly WorkingHoursResponse[],
  branch: BranchResponse | undefined,
  day: string,
  opts: { dentistUserId?: string | null; chairId?: string | null } = {},
): Interval[] {
  const branchId = branch?.id ?? "";
  let hours: Interval[] = subjectHours(rows, { scope: "BRANCH", branchId }, day) ??
    branchJsonHours(branch, weekdayOf(day)) ?? [...FULL_DAY];
  if (opts.dentistUserId) {
    const d = subjectHours(rows, { scope: "DENTIST", branchId, userId: opts.dentistUserId }, day);
    if (d) hours = intersect(hours, d);
  }
  if (opts.chairId) {
    const c = subjectHours(rows, { scope: "CHAIR", branchId, chairId: opts.chairId }, day);
    if (c) hours = intersect(hours, c);
  }
  return hours;
}

// ---------------------------------------------------------------------------------------------
// Admin: effective-dated periods of one subject
// ---------------------------------------------------------------------------------------------

export type PeriodState = "past" | "current" | "scheduled";

export interface HoursPeriod {
  effectiveFrom: string;
  effectiveTo: string | null;
  state: PeriodState;
  sessions: { weekday: number; startMinute: number; endMinute: number }[];
}

/**
 * Groups one subject's rows (listWorkingHours with includeHistory) into periods by
 * [effectiveFrom, effectiveTo), newest first, each marked past / current / scheduled relative to
 * the branch-local `today`. A PUT with no sessions closes the subject without inserting rows, so a
 * gap between periods means "closed" (the API answers that day as no hours).
 */
export function hoursPeriods(rows: readonly WorkingHoursResponse[], today: string): HoursPeriod[] {
  const byKey = new Map<string, HoursPeriod>();
  for (const w of rows) {
    const key = `${w.effectiveFrom}|${w.effectiveTo ?? ""}`;
    let p = byKey.get(key);
    if (!p) {
      p = {
        effectiveFrom: w.effectiveFrom,
        effectiveTo: w.effectiveTo,
        state:
          w.effectiveFrom > today
            ? "scheduled"
            : w.effectiveTo !== null && w.effectiveTo <= today
              ? "past"
              : "current",
        sessions: [],
      };
      byKey.set(key, p);
    }
    p.sessions.push({ weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute });
  }
  const out = [...byKey.values()];
  for (const p of out)
    p.sessions.sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  return out.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

/** Monday-first weekday order for editors and summaries (0 = Sunday last). */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * The weekly schedule in force on `day` (rows may come from different periods if data was written
 * piecemeal); `undefined` when the subject has no rows in force that day.
 */
export function scheduleOn(
  rows: readonly WorkingHoursResponse[],
  day: string,
): HoursPeriod | undefined {
  const live = rows.filter((w) => inForce(w, day));
  if (live.length === 0) return undefined;
  const from = live.reduce(
    (m, w) => (w.effectiveFrom > m ? w.effectiveFrom : m),
    live[0]?.effectiveFrom ?? day,
  );
  const tos = live.map((w) => w.effectiveTo).filter((t): t is string => t !== null);
  return {
    effectiveFrom: from,
    effectiveTo: tos.length ? tos.reduce((m, t) => (t < m ? t : m)) : null,
    state: "current",
    sessions: live
      .map((w) => ({ weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute }))
      .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute),
  };
}
