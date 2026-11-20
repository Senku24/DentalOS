import {
  MAX_APPOINTMENT_RANGE_DAYS,
  minutesToHHMM,
  utcToZoned,
  zonedToUtc,
} from "@dentalos/validation";

/**
 * Calendar date math for the front desk (no date library). Calendar days are "YYYY-MM-DD" strings in
 * the BRANCH time zone and are moved with pure UTC calendar arithmetic, so a DST change can never
 * skip or repeat a day. Instants (ISO strings) are only produced at the edges with `zonedToUtc`,
 * which resolves each local midnight / wall-clock time on its own (a 23 h or 25 h day stays one day).
 */

export const CALENDAR_VIEWS = ["day", "week", "month"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
export const isCalendarView = (v: unknown): v is CalendarView =>
  typeof v === "string" && (CALENDAR_VIEWS as readonly string[]).includes(v);

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDay(day: unknown): day is string {
  if (typeof day !== "string") return false;
  const m = DAY_RE.exec(day);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === day;
}

function parts(day: string): [number, number, number] {
  const m = DAY_RE.exec(day);
  if (!m) throw new RangeError(`Expected YYYY-MM-DD, got ${day}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return fromUtc(Date.UTC(y, m - 1, d + n));
}

/** Adds calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = parts(day);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(y, m - 1 + n, Math.min(d, last)));
}

/** 0 = Sunday … 6 = Saturday (same convention as WorkingHours.weekday). */
export function weekdayOf(day: string): number {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Whole calendar days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Monday-first weeks by default (India / ISO). */
export function startOfWeek(day: string, weekStartsOn = 1): string {
  const back = (weekdayOf(day) - weekStartsOn + 7) % 7;
  return addDays(day, -back);
}

export function startOfMonth(day: string): string {
  const [y, m] = parts(day);
  return fromUtc(Date.UTC(y, m - 1, 1));
}

export const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);

/** Local calendar date of `now` in `tz`. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return utcToZoned(now, tz).date;
}

/** The calendar days a view shows (month = 6 full weeks so the grid never changes height). */
export function visibleDays(view: CalendarView, anchor: string): string[] {
  if (view === "day") return [anchor];
  const first = view === "week" ? startOfWeek(anchor) : startOfWeek(startOfMonth(anchor));
  const n = view === "week" ? 7 : 42;
  return Array.from({ length: n }, (_, i) => addDays(first, i));
}

export function shiftAnchor(view: CalendarView, anchor: string, dir: -1 | 1): string {
  if (view === "day") return addDays(anchor, dir);
  if (view === "week") return addDays(anchor, 7 * dir);
  return addMonths(anchor, dir);
}

const MAX_RANGE_MS = MAX_APPOINTMENT_RANGE_DAYS * 86_400_000;

/**
 * UTC query range for `GET /appointments?from&to` covering whole local days. The API rejects spans
 * longer than 42 × 24 h; a 6-week month grid crossing a DST "fall back" is 42 days + 1 h, so trailing
 * days (next month's spill-over) are dropped until it fits. `days` lists what was actually covered.
 */
export function queryRange(
  days: readonly string[],
  tz: string,
): { from: string; to: string; days: string[] } {
  const covered = [...days];
  const first = covered[0];
  if (!first) throw new RangeError("No days");
  const from = zonedToUtc(first, 0, tz);
  let to = zonedToUtc(addDays(covered[covered.length - 1] as string, 1), 0, tz);
  while (covered.length > 1 && to.getTime() - from.getTime() > MAX_RANGE_MS) {
    covered.pop();
    to = zonedToUtc(addDays(covered[covered.length - 1] as string, 1), 0, tz);
  }
  return { from: from.toISOString(), to: to.toISOString(), days: covered };
}

/** Local wall-clock → ISO instant ("2026-11-19", 630, tz → "2026-11-19T05:00:00.000Z"). */
export function zonedIso(day: string, minuteOfDay: number, tz: string): string {
  return zonedToUtc(day, minuteOfDay, tz).toISOString();
}

export function localOf(iso: string, tz: string) {
  return utcToZoned(new Date(iso), tz);
}

/** "10:30" in the branch time zone. */
export function formatTime(iso: string, tz: string): string {
  return minutesToHHMM(localOf(iso, tz).minuteOfDay);
}

export function formatTimeRange(startIso: string, endIso: string, tz: string): string {
  return `${formatTime(startIso, tz)}–${formatTime(endIso, tz)}`;
}

/** Elapsed minutes between two instants (real time, so a DST jump is not double counted). */
export function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
}

// Calendar-day labels: format the day at UTC noon in UTC, so no time zone can shift it.
const dayDate = (day: string) => {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d, 12));
};
const fmt = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-IN", { ...o, timeZone: "UTC" });
const F_WEEKDAY = fmt({ weekday: "short" });
const F_DAYNUM = fmt({ day: "numeric" });
const F_DAY_MONTH = fmt({ day: "numeric", month: "short" });
const F_FULL = fmt({ weekday: "short", day: "numeric", month: "short", year: "numeric" });
const F_LONG = fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
const F_MONTH = fmt({ month: "long", year: "numeric" });

export const weekdayLabel = (day: string) => F_WEEKDAY.format(dayDate(day));
export const dayNumber = (day: string) => F_DAYNUM.format(dayDate(day));
export const dayMonthLabel = (day: string) => F_DAY_MONTH.format(dayDate(day));
/** "Thu, 19 Nov 2026" */
export const fullDayLabel = (day: string) => F_FULL.format(dayDate(day));
/** "Thursday, 19 November 2026" (screen-reader labels). */
export const longDayLabel = (day: string) => F_LONG.format(dayDate(day));

export function rangeLabel(view: CalendarView, anchor: string): string {
  if (view === "day") return fullDayLabel(anchor);
  if (view === "month") return F_MONTH.format(dayDate(anchor));
  const days = visibleDays("week", anchor);
  const a = days[0] as string;
  const b = days[6] as string;
  const year = b.slice(0, 4);
  return `${dayMonthLabel(a)} – ${dayMonthLabel(b)} ${year}`;
}

// ---------------------------------------------------------------------------------------------
// Time grid
// ---------------------------------------------------------------------------------------------

/**
 * Visible minute range of the time grid: the union of working sessions and booked items, widened to
 * whole hours; 08:00–20:00 when nothing is known.
 */
export function gridBounds(
  spans: readonly { startMinute: number; endMinute: number }[],
  fallback: [number, number] = [8 * 60, 20 * 60],
): { startMinute: number; endMinute: number } {
  if (spans.length === 0) return { startMinute: fallback[0], endMinute: fallback[1] };
  let lo = Math.min(...spans.map((s) => s.startMinute));
  let hi = Math.max(...spans.map((s) => s.endMinute));
  lo = Math.max(0, Math.floor(lo / 60) * 60);
  hi = Math.min(1440, Math.ceil(hi / 60) * 60);
  if (hi - lo < 60) hi = Math.min(1440, lo + 60);
  return { startMinute: lo, endMinute: hi };
}

export function slotStarts(startMinute: number, endMinute: number, step: number): number[] {
  const out: number[] = [];
  for (let m = startMinute; m < endMinute; m += step) out.push(m);
  return out;
}

/**
 * Side-by-side lanes for overlapping items in one column (half-open [start, end)). Items that touch
 * (end == next start) share a lane. Every item in an overlap cluster reports the cluster's lane count.
 */
export function assignLanes<T extends { id: string; start: number; end: number }>(
  items: readonly T[],
): Map<string, { lane: number; lanes: number }> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const c of cluster) out.set(c.id, { lane: c.lane, lanes });
    cluster = [];
    laneEnds = [];
  };
  for (const it of sorted) {
    if (it.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else laneEnds[lane] = it.end;
    cluster.push({ id: it.id, lane });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

/** Grid row (1-based) of a local minute in a slot grid starting at `startMinute`. */
export function rowOf(minute: number, startMinute: number, step: number): number {
  return Math.floor((minute - startMinute) / step) + 1;
}

/** Time options for a select ("HH:MM" every `step` minutes inside [start, end)). */
export function timeOptions(step: number, startMinute = 0, endMinute = 1440): string[] {
  return slotStarts(startMinute, endMinute, step).map(minutesToHHMM);
}

/** Round up to the next `step` boundary (local minutes). */
export const ceilToStep = (minute: number, step: number) => Math.ceil(minute / step) * step;
