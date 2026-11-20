import type { Branch, Tx, WorkingHours } from "@dentalos/db";
import { hhmmToMinutes } from "@dentalos/validation";
import { dateFromDay } from "./scheduling-common";

/**
 * Effective working hours (ADR 0003 §1.3). Pure interval maths + one loader.
 *
 * Minutes after local midnight, half-open `[start, end)`. For a local date the allowed time is
 *   branch hours ∩ dentist hours (when the dentist has hours in force) ∩ chair hours (when set).
 * Branch hours: the `BRANCH` rows in force on the date; when the branch has none in force, the M1
 * `Branch.workingHours` JSON is the fallback. `null` = no hours configured at all = unrestricted
 * (a fresh branch can book before an admin sets hours; documented in the S1 report).
 * A dentist with DENTIST rows in force anywhere is restricted to the rows at this branch (possibly
 * none = not working here that day); one without rows is not restricted.
 */

export type Interval = readonly [number, number];
/** `null` = unrestricted. */
export type Hours = Interval[] | null;

const JSON_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Sorts and merges overlapping/adjacent intervals (09:00–13:00 + 13:00–17:00 = 09:00–17:00). */
export function mergeIntervals(xs: readonly Interval[]): Interval[] {
  const sorted = [...xs].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Intersection of two hour sets (`null` is the identity). */
export function intersectHours(a: Hours, b: Hours): Hours {
  if (a === null) return b;
  if (b === null) return a;
  const out: Interval[] = [];
  for (const [as, ae] of mergeIntervals(a))
    for (const [bs, be] of mergeIntervals(b)) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (e > s) out.push([s, e]);
    }
  return mergeIntervals(out);
}

/** True when `[start, end)` lies entirely inside one allowed interval. */
export function covers(hours: Hours, start: number, end: number): boolean {
  if (hours === null) return true;
  return mergeIntervals(hours).some(([s, e]) => s <= start && end <= e);
}

type Row = Pick<WorkingHours, "weekday" | "startMinute" | "endMinute">;

export const sessionsOn = (rows: readonly Row[], weekday: number): Interval[] =>
  mergeIntervals(
    rows.filter((r) => r.weekday === weekday).map((r) => [r.startMinute, r.endMinute] as const),
  );

/** M1 `Branch.workingHours` ({ mon: [{ open, close }] }) for a weekday; `null` when never configured. */
export function branchJsonHours(json: unknown, weekday: number): Hours {
  if (!json || typeof json !== "object" || Object.keys(json).length === 0) return null;
  const day = (json as Record<string, unknown>)[JSON_DAYS[weekday] ?? ""];
  if (!Array.isArray(day)) return [];
  const out: Interval[] = [];
  for (const s of day) {
    try {
      const v = s as { open: string; close: string };
      out.push([hhmmToMinutes(v.open), hhmmToMinutes(v.close)]);
    } catch {
      // Malformed entries are ignored (the M1 API validates on write).
    }
  }
  return mergeIntervals(out);
}

export interface HoursContext {
  branch: Hours;
  /** Undefined when no dentist was asked for. */
  dentist?: Hours;
  /** Per requested chair id. */
  chairs: Map<string, Hours>;
}

/**
 * Loads the rows in force on local `day` and resolves the hour sets for `weekday`.
 * `chairIds` restricts chair lookups (pass every candidate chair).
 */
export async function loadHours(
  tx: Tx,
  branch: Pick<Branch, "id" | "workingHours">,
  day: string,
  weekday: number,
  opts: { dentistUserId?: string; chairIds?: readonly string[] } = {},
): Promise<HoursContext> {
  const d = dateFromDay(day);
  const inForce = {
    effectiveFrom: { lte: d },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: d } }],
  };
  const or: object[] = [{ scope: "BRANCH", branchId: branch.id }];
  if (opts.dentistUserId) or.push({ scope: "DENTIST", userId: opts.dentistUserId });
  if (opts.chairIds?.length)
    or.push({ scope: "CHAIR", branchId: branch.id, chairId: { in: [...opts.chairIds] } });
  const rows = await tx.workingHours.findMany({ where: { AND: [inForce, { OR: or }] } });

  const branchRows = rows.filter((r) => r.scope === "BRANCH");
  const ctx: HoursContext = {
    branch:
      branchRows.length > 0
        ? sessionsOn(branchRows, weekday)
        : branchJsonHours(branch.workingHours, weekday),
    chairs: new Map(),
  };
  if (opts.dentistUserId) {
    const dentistRows = rows.filter((r) => r.scope === "DENTIST");
    ctx.dentist =
      dentistRows.length > 0
        ? sessionsOn(
            dentistRows.filter((r) => r.branchId === branch.id),
            weekday,
          )
        : null;
  }
  for (const chairId of opts.chairIds ?? []) {
    const chairRows = rows.filter((r) => r.scope === "CHAIR" && r.chairId === chairId);
    ctx.chairs.set(chairId, chairRows.length > 0 ? sessionsOn(chairRows, weekday) : null);
  }
  return ctx;
}

/** Allowed hours for a dentist (optional) + chair (optional) on the loaded day. */
export function allowedHours(ctx: HoursContext, chairId?: string | null): Hours {
  let h = intersectHours(ctx.branch, ctx.dentist ?? null);
  if (chairId) h = intersectHours(h, ctx.chairs.get(chairId) ?? null);
  return h;
}
