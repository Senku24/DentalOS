"use client";
import {
  Alert,
  Button,
  Checkbox,
  ErrorState,
  PageHeader,
  SelectField,
  Skeleton,
} from "@dentalos/ui";
import type { AppointmentResponse } from "@dentalos/validation";
import { ChevronLeft, ChevronRight, Plus, Zap } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { BranchOptions, MockNotice, RequirePermission } from "../../components/common";
import {
  AppointmentPanel,
  type ApptContext,
  CancelDialog,
} from "../../components/scheduling/appointment-actions";
import {
  BranchGate,
  LiveIndicator,
  Segmented,
  StatusLegend,
} from "../../components/scheduling/bits";
import {
  BookingDrawer,
  type BookingSeed,
  WalkInDialog,
} from "../../components/scheduling/booking-drawer";
import { Calendar } from "../../components/scheduling/calendar";
import {
  useChairs,
  useDentists,
  useFocusReturn,
  useLiveRefresh,
  useMediaQuery,
  useNow,
  useSchedulingBranch,
  useSchedulingSettings,
} from "../../components/scheduling/use-scheduling";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { schedulingApi } from "../../lib/api/scheduling";
import { effectiveHours } from "../../lib/api/scheduling-hours";
import { calendarStatuses, listTruncated } from "../../lib/api/scheduling-rules";
import {
  type CalendarView,
  ceilToStep,
  isCalendarView,
  isValidDay,
  localOf,
  queryRange,
  rangeLabel,
  shiftAnchor,
  todayIn,
  visibleDays,
} from "../../lib/api/scheduling-time";
import { canDo } from "../../lib/session";

const VIEWS: { value: CalendarView; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

/** Calendar: day (chairs as columns), week and month views; agenda list on phones. */
export function AppointmentsClient() {
  const params = useSearchParams();
  const router = useRouter();
  const sb = useSchedulingBranch();
  const { branchId, timeZone: tz } = sb;
  const now = useNow();
  const today = todayIn(tz, now);

  const view: CalendarView = isCalendarView(params.get("view"))
    ? (params.get("view") as CalendarView)
    : "day";
  const dateParam = params.get("date");
  const anchor = isValidDay(dateParam) ? dateParam : today;
  const dentistFilter = params.get("dentist") ?? "";
  const chairFilter = params.get("chair") ?? "";
  const [showClosed, setShowClosed] = useState(false);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, val] of Object.entries(patch)) {
        if (val) next.set(k, val);
        else next.delete(k);
      }
      const qs = next.toString();
      router.replace(qs ? `/appointments?${qs}` : "/appointments", { scroll: false });
    },
    [params, router],
  );

  const chairs = useChairs(branchId);
  const { slotMinutes, noShowGraceMinutes } = useSchedulingSettings(branchId);
  const narrow = useMediaQuery("(max-width: 639px)");

  const days = useMemo(() => visibleDays(view, anchor), [view, anchor]);
  const range = useMemo(() => queryRange(days, tz), [days, tz]);
  // GET /appointments stops at 1000 rows (no cursor): ask only for statuses the grid shows, so
  // hidden closed rows don't push later weeks out, and say so when the cap is still hit.
  const appts = useQuery(
    () =>
      schedulingApi.appointments.list({
        branchId,
        from: range.from,
        to: range.to,
        dentistUserId: dentistFilter || undefined,
        chairId: chairFilter || undefined,
        status: calendarStatuses(showClosed),
      }),
    [branchId, range.from, range.to, dentistFilter, chairFilter, showClosed],
    Boolean(branchId),
  );
  const hours = useQuery(
    () => schedulingApi.hours.list({ branchId, includeHistory: true }),
    [branchId],
    Boolean(branchId),
  );
  // GET /working-hours is filtered by branch, but the API limits a dentist with DENTIST rows at ANY
  // branch to the rows at this one: fetch the filtered dentist's rows at the other branches in scope
  // (403s ignored; branches outside the user's scope stay invisible, so shading is approximate).
  const otherBranches = sb.scoped.filter((id) => id !== branchId);
  const dentistElsewhere = useQuery(
    async () =>
      (
        await Promise.all(
          otherBranches.map((b) =>
            schedulingApi.hours
              .list({ branchId: b, scope: "DENTIST", userId: dentistFilter, includeHistory: true })
              .then((r) => r.items)
              .catch(() => []),
          ),
        )
      ).flat(),
    [branchId, dentistFilter, otherBranches.join(",")],
    Boolean(branchId && dentistFilter && otherBranches.length),
  );
  const live = useLiveRefresh(branchId, appts.reload);
  const dentists = useDentists(
    branchId,
    (appts.data?.items ?? []).map((a) => a.dentistUserId).concat(dentistFilter || null),
  );

  const visible = useMemo(
    () =>
      (appts.data?.items ?? []).filter(
        (a) =>
          a.status !== "RESCHEDULED" &&
          (showClosed || (a.status !== "CANCELLED" && a.status !== "NO_SHOW")),
      ),
    [appts.data, showClosed],
  );
  const shownChairs = useMemo(
    () => chairs.active.filter((c) => !chairFilter || c.id === chairFilter),
    [chairs.active, chairFilter],
  );
  const hourRows = useMemo(
    () => [...(hours.data?.items ?? []), ...(dentistFilter ? (dentistElsewhere.data ?? []) : [])],
    [hours.data, dentistElsewhere.data, dentistFilter],
  );
  const openHours = useCallback(
    (day: string, chairId: string | null) =>
      effectiveHours(hourRows, sb.branch, day, {
        dentistUserId: dentistFilter || null,
        chairId: chairId ?? (chairFilter || null),
      }),
    [hourRows, sb.branch, dentistFilter, chairFilter],
  );

  const canBook = canDo("appointment:write", { branchId });
  const [selected, setSelected] = useState<AppointmentResponse | null>(null);
  const [booking, setBooking] = useState<BookingSeed | null>(null);
  const [rescheduling, setRescheduling] = useState<AppointmentResponse | null>(null);
  const [cancelling, setCancelling] = useState<AppointmentResponse | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  // Overlays have no Radix trigger: return focus to the chip / slot / button that opened them.
  const rangeId = "sch-range-heading";
  const focus = useFocusReturn(() => document.getElementById(rangeId));
  const opening =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      focus.remember();
      set(v);
    };
  const closing = (set: (v: null) => void) => {
    set(null);
    focus.restore();
  };

  const ctx: ApptContext = {
    timeZone: tz,
    noShowGraceMinutes,
    dentistLabel: dentists.label,
    chairLabel: chairs.label,
  };

  const newBookingSeed = (): BookingSeed => {
    const open = openHours(anchor, null)[0];
    const nowMin = localOf(now.toISOString(), tz).minuteOfDay;
    // Unrestricted hours (nothing configured) open at 00:00: start at 09:00 instead.
    const firstOpen = open && open.end - open.start < 24 * 60 ? open.start : 9 * 60;
    const minute = anchor === today ? ceilToStep(nowMin, slotMinutes) : firstOpen;
    return {
      day: anchor,
      minute: Math.min(minute, 24 * 60 - slotMinutes),
      chairId: chairFilter || null,
      dentistUserId: dentistFilter || null,
    };
  };

  const afterWrite = (a?: AppointmentResponse) => {
    appts.reload();
    if (a && selected?.id === a.id) setSelected(a);
  };

  return (
    <RequirePermission permission="appointment:read">
      <PageHeader
        title="Appointments"
        description={`Calendar for ${sb.branch?.name ?? "the branch"} (times in ${tz})`}
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Appointments" }]}
        actions={
          canBook && branchId ? (
            <>
              <Button variant="secondary" onClick={() => opening(setWalkIn)(true)}>
                <Zap size={16} aria-hidden="true" /> Walk-in
              </Button>
              <Button onClick={() => opening(setBooking)(newBookingSeed())}>
                <Plus size={16} aria-hidden="true" /> Book appointment
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <BranchGate sb={sb}>
          <fieldset className="sch-filters sch-fieldset">
            <legend className="dos-sr-only">Calendar filters</legend>
            <SelectField
              label="Branch"
              value={branchId}
              onChange={(e) => {
                sb.setBranchId(e.target.value);
                setParams({ dentist: null, chair: null });
              }}
            >
              <BranchOptions branches={sb.branches} ids={sb.scoped} />
            </SelectField>
            <SelectField
              label="Dentist"
              value={dentistFilter}
              onChange={(e) => setParams({ dentist: e.target.value || null })}
            >
              <option value="">All dentists</option>
              {dentists.dentists.map((d) => (
                <option key={d.userId} value={d.userId}>
                  {d.label}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Chair"
              value={chairFilter}
              onChange={(e) => setParams({ chair: e.target.value || null })}
            >
              <option value="">All chairs</option>
              {chairs.active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </option>
              ))}
            </SelectField>
            <Checkbox
              label="Show cancelled and no-shows"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
          </fieldset>

          <div className="sch-toolbar">
            <div className="sch-toolbar__nav">
              <Button
                variant="secondary"
                disabled={anchor === today}
                onClick={() => setParams({ date: null })}
              >
                Today
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={`Previous ${view}`}
                onClick={() => setParams({ date: shiftAnchor(view, anchor, -1) })}
              >
                <ChevronLeft size={18} aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                iconOnly
                aria-label={`Next ${view}`}
                onClick={() => setParams({ date: shiftAnchor(view, anchor, 1) })}
              >
                <ChevronRight size={18} aria-hidden="true" />
              </Button>
              <h2 id={rangeId} tabIndex={-1} className="sch-range" aria-live="polite">
                {rangeLabel(view, anchor)}
                <span className="dos-sr-only">
                  {appts.data ? `, ${visible.length} appointments` : ""}
                </span>
              </h2>
            </div>
            <div className="sch-toolbar__nav">
              <LiveIndicator status={live} />
              <Segmented
                label="Calendar view"
                options={VIEWS}
                value={view}
                onChange={(v) => setParams({ view: v === "day" ? null : v })}
              />
            </div>
          </div>

          {appts.error && !appts.data ? (
            <ErrorState
              {...errorStateFor(appts.error)}
              action={
                <Button variant="secondary" onClick={appts.reload}>
                  Try again
                </Button>
              }
            />
          ) : !appts.data ? (
            <div className="dos-stack" data-gap="sm" aria-busy="true">
              <span className="dos-sr-only">Loading appointments</span>
              <Skeleton height="3rem" />
              <Skeleton height="16rem" />
            </div>
          ) : (
            <div aria-busy={appts.loading} className="dos-stack" data-gap="sm">
              {listTruncated(appts.data.items) ? (
                <Alert tone="warning">
                  Too many appointments to show in one go: only the first {appts.data.items.length}{" "}
                  are listed, so later days may look emptier than they are. Switch to week or day
                  view, or filter by dentist or chair.
                </Alert>
              ) : null}
              <Calendar
                view={view}
                anchor={anchor}
                today={today}
                timeZone={tz}
                slotMinutes={slotMinutes}
                appointments={visible}
                chairs={shownChairs}
                chairFiltered={Boolean(chairFilter)}
                openHours={openHours}
                dentistLabel={dentists.label}
                chairLabel={chairs.label}
                canBook={canBook}
                now={now}
                narrow={narrow}
                onSelectSlot={(day, minute, chairId) =>
                  opening(setBooking)({
                    day,
                    minute,
                    chairId: chairId ?? (chairFilter || null),
                    dentistUserId: dentistFilter || null,
                  })
                }
                onOpenAppointment={opening(setSelected)}
                onShift={(dir) => setParams({ date: shiftAnchor(view, anchor, dir) })}
                onDrill={(day) => setParams({ view: null, date: day })}
              />
              {range.days.length < days.length ? (
                <p className="dos-hint">
                  The last {days.length - range.days.length} day(s) of this grid fall outside the
                  42-day query window; open the next month to see them.
                </p>
              ) : null}
              {narrow ? null : <StatusLegend />}
            </div>
          )}
        </BranchGate>
      </div>

      {selected ? (
        <AppointmentPanel
          a={selected}
          ctx={ctx}
          now={now}
          onClose={() => closing(setSelected)}
          onChanged={afterWrite}
          onReschedule={(a) => {
            setSelected(null);
            setRescheduling(a);
          }}
          onCancel={(a) => {
            setSelected(null);
            setCancelling(a);
          }}
        />
      ) : null}
      {booking ? (
        <BookingDrawer
          branchId={branchId}
          timeZone={tz}
          seed={booking}
          onClose={() => closing(setBooking)}
          onDone={() => {
            closing(setBooking);
            appts.reload();
          }}
        />
      ) : null}
      {rescheduling ? (
        <BookingDrawer
          branchId={branchId}
          timeZone={tz}
          appointment={rescheduling}
          onClose={() => closing(setRescheduling)}
          onDone={(a) => {
            closing(setRescheduling);
            appts.reload();
            const day = localOf(a.startsAt, tz).date;
            if (!days.includes(day)) setParams({ date: day });
          }}
        />
      ) : null}
      {cancelling ? (
        <CancelDialog
          a={cancelling}
          timeZone={tz}
          onClose={() => closing(setCancelling)}
          onDone={() => {
            closing(setCancelling);
            appts.reload();
          }}
        />
      ) : null}
      {walkIn ? (
        <WalkInDialog
          branchId={branchId}
          timeZone={tz}
          onClose={() => closing(() => setWalkIn(false))}
          onDone={() => {
            closing(() => setWalkIn(false));
            appts.reload();
          }}
        />
      ) : null}
    </RequirePermission>
  );
}
