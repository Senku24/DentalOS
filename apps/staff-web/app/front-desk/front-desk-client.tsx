"use client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  SelectField,
  Skeleton,
  StatCard,
  StatGrid,
  useLink,
} from "@dentalos/ui";
import type { AppointmentResponse, AppointmentStatus, PatientSummary } from "@dentalos/validation";
import { CalendarDays, Zap } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { BranchOptions, MockNotice, RequirePermission } from "../../components/common";
import { type ApptContext, StatusActions } from "../../components/scheduling/appointment-actions";
import {
  BranchGate,
  LiveIndicator,
  SourceBadge,
  StatusBadge,
} from "../../components/scheduling/bits";
import { WalkInDialog } from "../../components/scheduling/booking-drawer";
import {
  focusLost,
  useChairs,
  useDentists,
  useFocusReturn,
  useLiveRefresh,
  useNow,
  useSchedulingBranch,
  useSchedulingSettings,
} from "../../components/scheduling/use-scheduling";
import { errorStateFor } from "../../lib/api/errors";
import type { QueryState } from "../../lib/api/hooks";
import { useQuery } from "../../lib/api/hooks";
import { schedulingApi } from "../../lib/api/scheduling";
import {
  addDays,
  formatTimeRange,
  fullDayLabel,
  minutesBetween,
  todayIn,
  zonedIso,
} from "../../lib/api/scheduling-time";
import { formatPhone, humanize, patientName } from "../../lib/format";
import { canDo } from "../../lib/session";

/**
 * Front desk for today at one branch: who is expected, who is waiting (queue order from the API:
 * urgent first, then arrival) and who is in the chair. Live over SSE `/events` (branch-filtered),
 * polling while the stream is down.
 */
export function FrontDeskClient() {
  const Link = useLink();
  const sb = useSchedulingBranch();
  const { branchId, timeZone: tz } = sb;
  const now = useNow();
  const today = todayIn(tz, now);
  const chairs = useChairs(branchId);
  const { noShowGraceMinutes } = useSchedulingSettings(branchId);
  const [walkIn, setWalkIn] = useState(false);
  const walkInFocus = useFocusReturn();

  const day = useQuery(
    () =>
      schedulingApi.appointments.list({
        branchId,
        from: zonedIso(today, 0, tz),
        to: zonedIso(addDays(today, 1), 0, tz),
      }),
    [branchId, today, tz],
    Boolean(branchId),
  );
  const queue = useQuery(
    () => schedulingApi.frontDesk.queue({ branchId }),
    [branchId, today],
    Boolean(branchId),
  );
  const reload = () => {
    day.reload();
    queue.reload();
  };
  const live = useLiveRefresh(branchId, reload);

  const all = day.data?.items ?? [];
  const dentists = useDentists(
    branchId,
    all.map((a) => a.dentistUserId),
  );
  const arriving = useMemo(
    () =>
      all
        .filter((a) => a.status === "BOOKED" || a.status === "CONFIRMED")
        .sort((x, y) => x.startsAt.localeCompare(y.startsAt)),
    [all],
  );
  // API positions span waiting + in-chair entries (queue order); the lane numbers who is next.
  const waiting = (queue.data?.items ?? []).filter((e) => e.appointment.status === "CHECKED_IN");
  const inChair = (queue.data?.items ?? []).filter((e) => e.appointment.status === "IN_CHAIR");
  const completed = all.filter((a) => a.status === "COMPLETED").length;
  const noShows = all.filter((a) => a.status === "NO_SHOW").length;

  const ctx: ApptContext = {
    timeZone: tz,
    noShowGraceMinutes,
    dentistLabel: dentists.label,
    chairLabel: chairs.label,
  };
  const canWalkIn = canDo("appointment:write", { branchId });

  // After a status action the ticket moves to another lane (or leaves the board), so the focused
  // button unmounts. Move focus to the destination lane heading at once, then onto the ticket in its
  // new lane when the reload brings it (unless the user has moved focus elsewhere meanwhile).
  const [focusTicket, setFocusTicket] = useState<{ id: string; status: AppointmentStatus } | null>(
    null,
  );
  const onTicketChanged = (next: AppointmentResponse, prev: AppointmentResponse) => {
    const lane = laneOf(next.status) ?? laneOf(prev.status);
    // After the commit, so a closing no-show confirm dialog no longer traps focus.
    if (lane) setTimeout(() => document.getElementById(laneId(lane))?.focus(), 0);
    setFocusTicket(laneOf(next.status) ? { id: next.id, status: next.status } : null);
    reload();
  };
  const ticketProps = (a: AppointmentResponse) => ({
    onChanged: (next: AppointmentResponse) => onTicketChanged(next, a),
    focusRequested: focusTicket?.id === a.id && focusTicket.status === a.status,
    onFocusDone: () => setFocusTicket(null),
  });

  return (
    <RequirePermission permission="appointment:read">
      <PageHeader
        title="Front desk"
        description={`${sb.branch?.name ?? "Branch"} · ${fullDayLabel(today)}`}
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Front desk" }]}
        actions={
          <>
            <Link className="dos-btn" data-variant="secondary" data-size="md" href="/appointments">
              <CalendarDays size={16} aria-hidden="true" /> Calendar
            </Link>
            {canWalkIn && sb.branchId ? (
              <Button
                onClick={() => {
                  walkInFocus.remember();
                  setWalkIn(true);
                }}
              >
                <Zap size={16} aria-hidden="true" /> Walk-in / urgent
              </Button>
            ) : null}
          </>
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <BranchGate sb={sb}>
          <div className="sch-toolbar">
            <div className="sch-filters">
              <SelectField
                label="Branch"
                value={branchId}
                onChange={(e) => sb.setBranchId(e.target.value)}
              >
                <BranchOptions branches={sb.branches} ids={sb.scoped} />
              </SelectField>
            </div>
            <LiveIndicator status={live} />
          </div>

          <StatGrid>
            <StatCard label="Still expected" value={arriving.length} loading={!day.data} />
            <StatCard label="Waiting" value={waiting.length} loading={!queue.data} />
            <StatCard label="In chair" value={inChair.length} loading={!queue.data} />
            <StatCard
              label="Completed"
              value={completed}
              loading={!day.data}
              hint={noShows ? `${noShows} no-show${noShows === 1 ? "" : "s"}` : undefined}
            />
          </StatGrid>

          <div className="sch-desk">
            <Lane
              lane="arriving"
              count={arriving.length}
              state={day}
              empty="Nobody else is expected today."
            >
              {arriving.map((a) => (
                <Ticket
                  key={a.id}
                  a={a}
                  patient={a.patient}
                  ctx={ctx}
                  now={now}
                  {...ticketProps(a)}
                  meta={lateness(a, now)}
                />
              ))}
            </Lane>
            <Lane
              lane="waiting"
              count={waiting.length}
              state={queue}
              empty="The waiting room is empty."
              ordered
            >
              {waiting.map((e, i) => (
                <Ticket
                  key={e.appointment.id}
                  a={e.appointment}
                  patient={e.patient}
                  position={i + 1}
                  ctx={ctx}
                  now={now}
                  {...ticketProps(e.appointment)}
                  meta={
                    e.waitingSince
                      ? `Waiting ${Math.max(0, minutesBetween(e.waitingSince, now.toISOString()))} min`
                      : undefined
                  }
                />
              ))}
            </Lane>
            <Lane
              lane="in-chair"
              count={inChair.length}
              state={queue}
              empty="No one is in a chair."
            >
              {inChair.map((e) => (
                <Ticket
                  key={e.appointment.id}
                  a={e.appointment}
                  patient={e.patient}
                  ctx={ctx}
                  now={now}
                  {...ticketProps(e.appointment)}
                />
              ))}
            </Lane>
          </div>
        </BranchGate>
      </div>

      {walkIn ? (
        <WalkInDialog
          branchId={branchId}
          timeZone={tz}
          onClose={() => {
            setWalkIn(false);
            walkInFocus.restore();
          }}
          onDone={() => {
            setWalkIn(false);
            walkInFocus.restore();
            reload();
          }}
        />
      ) : null}
    </RequirePermission>
  );
}

type LaneKey = "arriving" | "waiting" | "in-chair";
const LANE_TITLES: Record<LaneKey, string> = {
  arriving: "Arriving today",
  waiting: "Waiting",
  "in-chair": "In chair",
};
const laneOf = (s: AppointmentStatus): LaneKey | null =>
  s === "BOOKED" || s === "CONFIRMED"
    ? "arriving"
    : s === "CHECKED_IN"
      ? "waiting"
      : s === "IN_CHAIR"
        ? "in-chair"
        : null;
const laneId = (lane: LaneKey) => `lane-${lane}`;

function lateness(a: AppointmentResponse, now: Date): string | undefined {
  const late = minutesBetween(a.startsAt, now.toISOString());
  return late > 5 ? `${late} min late` : undefined;
}

function Lane<T>({
  lane,
  count,
  state,
  empty,
  ordered,
  children,
}: {
  lane: LaneKey;
  count: number;
  state: QueryState<T>;
  empty: string;
  ordered?: boolean;
  children: ReactNode;
}) {
  const id = laneId(lane);
  const title = LANE_TITLES[lane];
  const List = ordered ? "ol" : "ul";
  let body: ReactNode;
  if (state.error && state.data === undefined) {
    const e = errorStateFor(state.error);
    body = (
      <ErrorState
        title={e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={state.reload}>
            Try again
          </Button>
        }
      />
    );
  } else if (state.data === undefined) {
    body = (
      <div className="dos-stack" data-gap="sm" aria-busy="true">
        <span className="dos-sr-only">Loading</span>
        <Skeleton height="4.5em" />
        <Skeleton height="4.5em" />
      </div>
    );
  } else if (count === 0) {
    body = <EmptyState title={empty} />;
  } else body = <List aria-labelledby={id}>{children}</List>;
  return (
    <section className="sch-lane" aria-labelledby={id}>
      {/* tabIndex -1: focus lands here after a status action moves a ticket into this lane */}
      <h2 id={id} tabIndex={-1} className="dos-section-title" style={{ margin: 0 }}>
        {title} <Badge tone="neutral">{String(count)}</Badge>
      </h2>
      {body}
    </section>
  );
}

function Ticket({
  a,
  patient,
  position,
  meta,
  ctx,
  now,
  onChanged,
  focusRequested,
  onFocusDone,
}: {
  a: AppointmentResponse;
  patient: PatientSummary | undefined;
  position?: number;
  meta?: string;
  ctx: ApptContext;
  now: Date;
  onChanged: (next: AppointmentResponse) => void;
  focusRequested?: boolean;
  onFocusDone?: () => void;
}) {
  const Link = useLink();
  const name = patient ? patientName(patient) : "Patient";
  const ref = useRef<HTMLLIElement>(null);
  const doneRef = useRef(onFocusDone);
  doneRef.current = onFocusDone;
  useEffect(() => {
    if (!focusRequested) return;
    doneRef.current?.();
    const el = document.activeElement;
    // Only take focus from where onTicketChanged parked it (a lane heading) or from nowhere.
    if (focusLost() || (el instanceof HTMLElement && el.matches(".sch-lane > h2")))
      ref.current?.querySelector<HTMLElement>("a")?.focus();
  }, [focusRequested]);
  return (
    <li
      ref={ref}
      className="sch-ticket"
      data-status={a.status}
      data-urgent={a.source === "URGENT" ? "true" : undefined}
    >
      <div className="sch-ticket__head">
        <div className="dos-cluster" style={{ gap: 8 }}>
          {position ? (
            <span className="sch-ticket__pos" aria-label={`Position ${position}`}>
              {position}
            </span>
          ) : null}
          <Link href={`/appointments/${a.id}`}>
            <strong>{name}</strong>
          </Link>
        </div>
        <div className="dos-cluster" style={{ gap: 4 }}>
          <SourceBadge source={a.source} />
          <StatusBadge status={a.status} />
        </div>
      </div>
      <div className="sch-ticket__meta">
        {[
          formatTimeRange(a.startsAt, a.endsAt, ctx.timeZone),
          humanize(a.appointmentType),
          ctx.dentistLabel(a.dentistUserId),
          ctx.chairLabel(a.chairId),
          patient?.phone ? formatPhone(patient.phone) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        {meta ? (
          <>
            {" · "}
            <strong>{meta}</strong>
          </>
        ) : null}
      </div>
      <StatusActions a={a} ctx={ctx} now={now} onChanged={onChanged} />
    </li>
  );
}
