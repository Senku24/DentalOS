"use client";
import { EmptyState } from "@dentalos/ui";
import { type AppointmentResponse, type ChairResponse, minutesToHHMM } from "@dentalos/validation";
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Interval } from "../../lib/api/scheduling-hours";
import { STATUS_LABELS, isActiveStatus } from "../../lib/api/scheduling-rules";
import {
  type CalendarView,
  assignLanes,
  dayNumber,
  formatTimeRange,
  fullDayLabel,
  gridBounds,
  localOf,
  longDayLabel,
  minutesBetween,
  rowOf,
  sameMonth,
  slotStarts,
  visibleDays,
  weekdayLabel,
} from "../../lib/api/scheduling-time";
import { humanize } from "../../lib/format";
import { apptPatientName } from "./bits";

export interface CalendarProps {
  view: CalendarView;
  anchor: string;
  today: string;
  timeZone: string;
  slotMinutes: number;
  appointments: readonly AppointmentResponse[];
  /** Active chairs of the branch (already narrowed by the chair filter). */
  chairs: readonly ChairResponse[];
  /** True when the chair filter is set (day view shows only that chair). */
  chairFiltered: boolean;
  /** Open (bookable) time on a day, optionally for one chair: closed time is hatched. */
  openHours: (day: string, chairId: string | null) => Interval[];
  dentistLabel: (id: string | null) => string;
  chairLabel: (id: string | null) => string;
  canBook: boolean;
  now: Date;
  narrow: boolean;
  onSelectSlot: (day: string, minute: number, chairId: string | null) => void;
  onOpenAppointment: (a: AppointmentResponse) => void;
  /** PageUp / PageDown in the grid. */
  onShift: (dir: -1 | 1) => void;
  /** Month cell → day view. */
  onDrill: (day: string) => void;
}

interface Column {
  key: string;
  day: string;
  chairId: string | null;
  label: string;
  sublabel?: string;
  today: boolean;
}

/** Day / week time grid, month grid, or (phone) an agenda list. */
export function Calendar(props: CalendarProps) {
  if (props.narrow) return <Agenda {...props} />;
  if (props.view === "month") return <MonthGrid {...props} />;
  return <TimeGrid {...props} />;
}

const dayOf = (a: AppointmentResponse, tz: string) => localOf(a.startsAt, tz).date;

export function appointmentLabel(
  a: AppointmentResponse,
  tz: string,
  dentistLabel: (id: string | null) => string,
  chairLabel: (id: string | null) => string,
  withDay = false,
) {
  return [
    withDay ? fullDayLabel(dayOf(a, tz)) : null,
    formatTimeRange(a.startsAt, a.endsAt, tz),
    apptPatientName(a),
    humanize(a.appointmentType),
    dentistLabel(a.dentistUserId),
    chairLabel(a.chairId),
    STATUS_LABELS[a.status],
    a.source === "URGENT" ? "Urgent" : a.source === "WALK_IN" ? "Walk-in" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function Chip({
  a,
  props,
  style,
  compact,
  withDay,
}: {
  a: AppointmentResponse;
  props: CalendarProps;
  style?: CSSProperties;
  compact?: boolean;
  withDay?: boolean;
}) {
  const { timeZone: tz } = props;
  return (
    <button
      type="button"
      className="sch-evt"
      data-status={a.status}
      data-urgent={a.source === "URGENT" ? "true" : undefined}
      data-dim={isActiveStatus(a.status) || a.status === "COMPLETED" ? undefined : "true"}
      style={style}
      aria-label={appointmentLabel(a, tz, props.dentistLabel, props.chairLabel, withDay)}
      onClick={(e) => {
        e.stopPropagation();
        props.onOpenAppointment(a);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <strong>
        {compact ? `${formatTimeRange(a.startsAt, a.endsAt, tz).split("–")[0]} ` : null}
        {apptPatientName(a)}
      </strong>
      {compact ? null : (
        <span>
          {formatTimeRange(a.startsAt, a.endsAt, tz)} · {humanize(a.appointmentType)}
          {a.dentistUserId ? ` · ${props.dentistLabel(a.dentistUserId)}` : ""}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Time grid
// ---------------------------------------------------------------------------------------------

function TimeGrid(props: CalendarProps) {
  const { view, anchor, today, timeZone: tz, slotMinutes: step } = props;
  const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);

  const columns: Column[] = useMemo(() => {
    if (view === "week")
      return days.map((d) => ({
        key: d,
        day: d,
        chairId: null,
        label: `${weekdayLabel(d)} ${dayNumber(d)}`,
        today: d === today,
      }));
    const cols: Column[] = props.chairs.map((c) => ({
      key: c.id,
      day: anchor,
      chairId: c.id,
      label: c.code,
      sublabel: c.name,
      today: anchor === today,
    }));
    const unassigned = props.appointments.some(
      (a) => a.chairId === null && dayOf(a, tz) === anchor,
    );
    if (!props.chairFiltered && (unassigned || cols.length === 0))
      cols.push({
        key: "none",
        day: anchor,
        chairId: null,
        label: "No chair",
        sublabel: "Unassigned",
        today: anchor === today,
      });
    return cols;
  }, [view, days, anchor, today, props.chairs, props.appointments, props.chairFiltered, tz]);

  const colItems = useMemo(
    () =>
      columns.map((col) =>
        props.appointments.filter(
          (a) =>
            dayOf(a, tz) === col.day &&
            (view === "week" || a.chairId === col.chairId || (col.key === "none" && !a.chairId)),
        ),
      ),
    [columns, props.appointments, tz, view],
  );

  // Local [start, end) minutes of each column's appointments, for the cells' "booked" labels.
  const colSpans = useMemo(
    () =>
      colItems.map((list) =>
        list.map((a) => {
          const s = localOf(a.startsAt, tz).minuteOfDay;
          return { a, s, e: Math.min(1440, s + Math.max(5, minutesBetween(a.startsAt, a.endsAt))) };
        }),
      ),
    [colItems, tz],
  );
  const bookedAt = (c: number, minute: number) =>
    (colSpans[c] ?? []).filter((x) => x.s < minute + step && x.e > minute).map((x) => x.a);

  const open = useMemo(
    () => columns.map((c) => props.openHours(c.day, view === "day" ? c.chairId : null)),
    [columns, props.openHours, view],
  );

  const bounds = useMemo(() => {
    const spans: { startMinute: number; endMinute: number }[] = [];
    // Unrestricted hours (whole day) don't stretch the grid to 24 h: appointments still do.
    for (const list of open)
      for (const i of list)
        if (i.end - i.start < 1440) spans.push({ startMinute: i.start, endMinute: i.end });
    for (const list of colItems)
      for (const a of list) {
        const s = localOf(a.startsAt, tz).minuteOfDay;
        spans.push({
          startMinute: s,
          endMinute: Math.min(1440, s + minutesBetween(a.startsAt, a.endsAt)),
        });
      }
    return gridBounds(spans);
  }, [open, colItems, tz]);

  const slots = slotStarts(bounds.startMinute, bounds.endMinute, step);
  const rows = slots.length;
  const [focus, setFocus] = useState<{ c: number; r: number }>({ c: 0, r: 0 });
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const wantFocus = useRef(false);
  const wantPeriodFocus = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the roving focus inside the grid when the view changes.
  useEffect(() => {
    setFocus((f) => ({ c: Math.min(f.c, columns.length - 1), r: Math.min(f.r, rows - 1) }));
  }, [columns.length, rows]);
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    cellRefs.current.get(`${focus.c}:${focus.r}`)?.focus();
  }, [focus]);
  // Scroll to "now" (or the first open slot) when the period changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on period change
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nowMin = localOf(props.now.toISOString(), tz).minuteOfDay;
    const first = open[0]?.[0];
    const target = columns.some((c) => c.today)
      ? nowMin - 60
      : first && first.end - first.start < 1440
        ? first.start
        : bounds.startMinute;
    const slotH = el.querySelector<HTMLElement>(".sch-cell")?.offsetHeight ?? 22;
    el.scrollTop = Math.max(0, ((target - bounds.startMinute) / step) * slotH);
  }, [anchor, view]);
  // Page Up / Page Down re-keys the columns (new days), so the focused cell unmounts: put focus
  // back on the same slot of the new period (after the scroll reset above, so it stays in view).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on period change
  useEffect(() => {
    if (!wantPeriodFocus.current) return;
    wantPeriodFocus.current = false;
    const c = Math.min(focus.c, columns.length - 1);
    cellRefs.current.get(`${c}:${focus.r}`)?.focus();
  }, [anchor, view]);

  const isOpen = (c: number, minute: number) =>
    (open[c] ?? []).some((i) => i.start <= minute && minute + step <= i.end);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.getAttribute("role") !== "gridcell") return;
    let { c, r } = focus;
    switch (e.key) {
      case "ArrowUp":
        r = Math.max(0, r - 1);
        break;
      case "ArrowDown":
        r = Math.min(rows - 1, r + 1);
        break;
      case "ArrowLeft":
        c = Math.max(0, c - 1);
        break;
      case "ArrowRight":
        c = Math.min(columns.length - 1, c + 1);
        break;
      case "Home":
        if (e.ctrlKey) r = 0;
        else c = 0;
        break;
      case "End":
        if (e.ctrlKey) r = rows - 1;
        else c = columns.length - 1;
        break;
      case "PageUp":
        e.preventDefault();
        wantPeriodFocus.current = true;
        props.onShift(-1);
        return;
      case "PageDown":
        e.preventDefault();
        wantPeriodFocus.current = true;
        props.onShift(1);
        return;
      case "Enter":
      case " ": {
        e.preventDefault();
        const col = columns[c];
        const minute = slots[r] ?? bounds.startMinute;
        // A chair column's occupied slot can't be booked (409 slot_conflict): open the visit.
        const taken = col?.chairId ? bookedAt(c, minute)[0] : undefined;
        if (taken) props.onOpenAppointment(taken);
        else if (col && props.canBook) props.onSelectSlot(col.day, minute, col.chairId);
        return;
      }
      default:
        return;
    }
    e.preventDefault();
    wantFocus.current = true;
    setFocus({ c, r });
  };

  const nowLocal = localOf(props.now.toISOString(), tz);
  const nowMin = nowLocal.minuteOfDay;
  const colMin = view === "week" ? "110px" : "140px";

  return (
    <div className="sch-tg-scroll" ref={scrollRef}>
      <div
        className="sch-tg"
        style={{ "--cols": columns.length, "--rows": rows, "--col-min": colMin } as CSSProperties}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container) */}
        <div
          role="grid"
          aria-label={`${view === "day" ? "Day" : "Week"} calendar. Arrow keys move between time slots, Enter books a free slot${view === "day" ? " or opens a booked one" : ""}, Page Up and Page Down change ${view}.`}
          aria-rowcount={rows + 1}
          aria-colcount={columns.length + 1}
          style={{ display: "contents" }}
          onKeyDown={onKeyDown}
        >
          {/* biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container) */}
          <div role="row" aria-rowindex={1}>
            {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container) */}
            <div
              role="columnheader"
              className="sch-tg__corner"
              style={{ gridRow: 1, gridColumn: 1 }}
            >
              <span className="dos-sr-only">Time</span>
            </div>
            {columns.map((col, c) => (
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container)
              <div
                role="columnheader"
                key={col.key}
                className="sch-tg__colhead"
                data-today={col.today ? "true" : undefined}
                style={{ gridRow: 1, gridColumn: c + 2 }}
                aria-label={
                  view === "week" ? longDayLabel(col.day) : `${col.label} ${col.sublabel ?? ""}`
                }
              >
                {col.label}
                {col.sublabel ? <small>{col.sublabel}</small> : null}
              </div>
            ))}
          </div>
          {slots.map((minute, r) => {
            const hour = minute % 60 === 0;
            return (
              // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container)
              <div role="row" key={minute} aria-rowindex={r + 2}>
                {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container) */}
                <div
                  role="rowheader"
                  className="sch-tg__time"
                  data-hour={hour ? "true" : "false"}
                  style={{ gridRow: r + 2, gridColumn: 1 }}
                >
                  <span aria-hidden="true">{minutesToHHMM(minute)}</span>
                  <span className="dos-sr-only">{minutesToHHMM(minute)}</span>
                </div>
                {columns.map((col, c) => {
                  const openSlot = isOpen(c, minute);
                  const active = focus.c === c && focus.r === r;
                  const where =
                    view === "week"
                      ? fullDayLabel(col.day)
                      : `${col.label}, ${fullDayLabel(col.day)}`;
                  const booked = bookedAt(c, minute);
                  const bookedText = booked.length
                    ? `, booked: ${booked
                        .map((a) => `${apptPatientName(a)}, ${humanize(a.appointmentType)}`)
                        .join("; ")}`
                    : "";
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container)
                    <div
                      role="gridcell"
                      key={col.key}
                      ref={(el) => {
                        const k = `${c}:${r}`;
                        if (el) cellRefs.current.set(k, el);
                        else cellRefs.current.delete(k);
                      }}
                      tabIndex={active ? 0 : -1}
                      className="sch-cell"
                      data-hour={hour ? "true" : undefined}
                      data-closed={openSlot ? undefined : "true"}
                      aria-readonly={props.canBook ? undefined : true}
                      aria-label={`${minutesToHHMM(minute)}, ${where}${openSlot ? "" : ", closed"}${bookedText}`}
                      style={{ gridRow: r + 2, gridColumn: c + 2 }}
                      onFocus={() => setFocus({ c, r })}
                      onClick={() =>
                        props.canBook && props.onSelectSlot(col.day, minute, col.chairId)
                      }
                    />
                  );
                })}
              </div>
            );
          })}
        </div>

        {columns.map((col, c) => {
          const items = colItems[c] ?? [];
          const placed = items.map((a) => {
            const s = localOf(a.startsAt, tz).minuteOfDay;
            const e = Math.min(1440, s + Math.max(5, minutesBetween(a.startsAt, a.endsAt)));
            return { id: a.id, start: s, end: e, a };
          });
          const lanes = assignLanes(placed);
          return (
            <div
              key={`ev-${col.key}`}
              className="sch-col-events"
              style={{ gridColumn: c + 2, gridRow: `2 / span ${rows}` }}
            >
              {placed.map(({ id, start, end, a }) => {
                const s = Math.max(start, bounds.startMinute);
                const e = Math.min(end, bounds.endMinute);
                const rowStart = rowOf(s, bounds.startMinute, step);
                const span = Math.max(1, Math.ceil((e - s) / step));
                const lane = lanes.get(id) ?? { lane: 0, lanes: 1 };
                return (
                  <Chip
                    key={id}
                    a={a}
                    props={props}
                    compact={span < 2}
                    style={{
                      gridRow: `${rowStart} / span ${span}`,
                      gridColumn: 1,
                      width: `calc(${100 / lane.lanes}% - 2px)`,
                      marginInlineStart: `${(100 / lane.lanes) * lane.lane}%`,
                      minHeight: 0,
                    }}
                  />
                );
              })}
              {col.day === nowLocal.date &&
              nowMin >= bounds.startMinute &&
              nowMin < bounds.endMinute ? (
                <div
                  className="sch-now"
                  aria-hidden="true"
                  style={{
                    gridRow: rowOf(nowMin, bounds.startMinute, step),
                    gridColumn: 1,
                    marginTop: `calc(var(--slot-h) * ${((nowMin - bounds.startMinute) % step) / step})`,
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------------------------

function MonthGrid(props: CalendarProps) {
  const { anchor, today, timeZone: tz } = props;
  const days = useMemo(() => visibleDays("month", anchor), [anchor]);
  const byDay = useMemo(() => {
    const m = new Map<string, AppointmentResponse[]>();
    for (const a of props.appointments) {
      const d = dayOf(a, tz);
      const list = m.get(d) ?? [];
      list.push(a);
      m.set(d, list);
    }
    return m;
  }, [props.appointments, tz]);
  const initial = Math.max(0, days.indexOf(anchor));
  const [focus, setFocus] = useState(initial);
  const refs = useRef(new Map<number, HTMLDivElement>());
  const wantFocus = useRef(false);
  const wantPeriodFocus = useRef(false);
  useEffect(() => {
    const i = Math.max(0, days.indexOf(anchor));
    setFocus(i);
    // Page Up / Page Down: keep keyboard focus in the grid, on the new month's anchor day.
    if (wantPeriodFocus.current) {
      wantPeriodFocus.current = false;
      refs.current.get(i)?.focus();
    }
  }, [anchor, days]);
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    refs.current.get(focus)?.focus();
  }, [focus]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).getAttribute("role") !== "gridcell") return;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in moves) {
      e.preventDefault();
      wantFocus.current = true;
      setFocus((f) => Math.min(41, Math.max(0, f + (moves[e.key] ?? 0))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      wantFocus.current = true;
      setFocus((f) => (e.key === "Home" ? f - (f % 7) : f - (f % 7) + 6));
    } else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      wantPeriodFocus.current = true;
      props.onShift(e.key === "PageUp" ? -1 : 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const d = days[focus];
      if (d) props.onDrill(d);
    }
  };

  const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  return (
    // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container)
    <div
      role="grid"
      className="sch-month"
      aria-label="Month calendar. Arrow keys move between days, Enter opens the day, Page Up and Page Down change month."
      onKeyDown={onKeyDown}
    >
      {/* biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container) */}
      <div role="row">
        {(weeks[0] ?? []).map((d) => (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container)
          <div key={d} role="columnheader" className="sch-month__head">
            {weekdayLabel(d)}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container)
        <div role="row" key={week[0]}>
          {week.map((d) => {
            const i = days.indexOf(d);
            const list = (byDay.get(d) ?? []).filter((a) => a.status !== "RESCHEDULED");
            const shown = list.slice(0, 3);
            const active = list.filter((a) => isActiveStatus(a.status)).length;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useSemanticElements: WAI-ARIA grid pattern on a CSS grid (roving tabindex; keys handled on the grid container)
              <div
                role="gridcell"
                key={d}
                ref={(el) => {
                  if (el) refs.current.set(i, el);
                  else refs.current.delete(i);
                }}
                tabIndex={focus === i ? 0 : -1}
                className="sch-daycell"
                data-outside={sameMonth(d, anchor) ? undefined : "true"}
                data-today={d === today ? "true" : undefined}
                aria-label={`${longDayLabel(d)}, ${list.length} appointment${list.length === 1 ? "" : "s"}${
                  active ? `, ${active} active` : ""
                }`}
                onFocus={() => setFocus(i)}
                onClick={() => props.onDrill(d)}
              >
                <div className="sch-daycell__num" aria-hidden="true">
                  <span>{dayNumber(d)}</span>
                  {list.length > 0 ? <span className="sch-more">{list.length}</span> : null}
                </div>
                {shown.map((a) => (
                  <Chip key={a.id} a={a} props={props} compact withDay />
                ))}
                {list.length > shown.length ? (
                  <span className="sch-more" aria-hidden="true">
                    +{list.length - shown.length} more
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Agenda (phone)
// ---------------------------------------------------------------------------------------------

function Agenda(props: CalendarProps) {
  const { view, anchor, timeZone: tz } = props;
  const days = visibleDays(view, anchor).filter((d) => view !== "month" || sameMonth(d, anchor));
  const groups = days
    .map((d) => ({
      day: d,
      items: props.appointments
        .filter((a) => dayOf(a, tz) === d && a.status !== "RESCHEDULED")
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    }))
    .filter((g) => g.items.length > 0 || (view === "day" && g.day === anchor));
  if (groups.every((g) => g.items.length === 0))
    return (
      <EmptyState
        title="No appointments"
        description={`Nothing booked for this ${view}${props.chairFiltered ? " and chair" : ""}.`}
      />
    );
  return (
    <div className="sch-agenda">
      {groups.map((g) => (
        <section key={g.day} aria-labelledby={`ag-${g.day}`}>
          <h3 id={`ag-${g.day}`}>
            {fullDayLabel(g.day)}
            {g.day === props.today ? " (today)" : ""}
          </h3>
          <ul>
            {g.items.map((a) => (
              <li key={a.id}>
                <Chip a={a} props={props} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
