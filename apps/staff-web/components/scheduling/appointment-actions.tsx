"use client";
import {
  Alert,
  Button,
  ConfirmDialog,
  DescriptionList,
  Dialog,
  Drawer,
  TextareaField,
  useLink,
  useToast,
} from "@dentalos/ui";
import type { AppointmentResponse } from "@dentalos/validation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { schedulingApi } from "../../lib/api/scheduling";
import {
  type SchedulingProblem,
  type StatusAction,
  describeSchedulingError,
  manageActions,
  statusActions,
} from "../../lib/api/scheduling-rules";
import {
  formatTime,
  formatTimeRange,
  fullDayLabel,
  localOf,
  minutesBetween,
} from "../../lib/api/scheduling-time";
import { humanize } from "../../lib/format";
import { userLabel } from "../../lib/session";
import { SourceBadge, StatusBadge, apptPatientName } from "./bits";
import { canFn, focusLost } from "./use-scheduling";

/** Announced, focusable explanation of a failed scheduling call. */
export function ProblemAlert({
  problem,
  children,
}: {
  problem: SchedulingProblem | null;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (problem) ref.current?.focus();
  }, [problem]);
  if (!problem) return null;
  return (
    <div ref={ref} tabIndex={-1} style={{ outline: "none" }}>
      <Alert tone={problem.code === "outside_working_hours" ? "warning" : "danger"}>
        <div>
          <strong>{problem.title}.</strong> {problem.message}
          {children}
        </div>
      </Alert>
    </div>
  );
}

export interface ApptContext {
  timeZone: string;
  noShowGraceMinutes: number;
  dentistLabel: (id: string | null | undefined) => string;
  chairLabel: (id: string | null | undefined) => string;
}

export function whenLabel(a: Pick<AppointmentResponse, "startsAt" | "endsAt">, tz: string) {
  return `${fullDayLabel(localOf(a.startsAt, tz).date)}, ${formatTimeRange(a.startsAt, a.endsAt, tz)}`;
}

/** Facts about an appointment (shared by the calendar panel and the detail page). */
export function AppointmentFacts({
  a,
  ctx,
  columns = 1,
}: {
  a: AppointmentResponse;
  ctx: ApptContext;
  columns?: 1 | 2 | 3;
}) {
  const items = [
    { term: "When", detail: whenLabel(a, ctx.timeZone) },
    { term: "Duration", detail: `${minutesBetween(a.startsAt, a.endsAt)} min` },
    { term: "Dentist", detail: ctx.dentistLabel(a.dentistUserId) },
    { term: "Chair", detail: ctx.chairLabel(a.chairId) },
    { term: "Type", detail: humanize(a.appointmentType) },
    { term: "Booked by", detail: userLabel(a.createdBy) },
  ];
  if (a.checkedInAt)
    items.push({
      term: "Checked in",
      detail: formatTime(a.checkedInAt, ctx.timeZone),
    });
  if (a.notes) items.push({ term: "Notes", detail: a.notes });
  if (a.outsideHoursReason)
    items.push({ term: "Outside-hours reason", detail: a.outsideHoursReason });
  if (a.cancelReason) items.push({ term: "Cancel reason", detail: a.cancelReason });
  return <DescriptionList columns={columns} items={items} />;
}

/**
 * Status buttons: only the moves allowedAppointmentTransitions permits AND the caller's role can
 * make (display-only can()). Check-in is disabled (with the reason) when the visit is not today;
 * no-show before the grace period. The API re-checks everything; its errors are explained inline.
 *
 * Focus: the clicked button usually disappears after the move (that move is no longer offered). Once
 * this component re-renders with the new status and focus was lost, it goes to the first remaining
 * action, else `focusFallback`, else the enclosing dialog. Callers that move the ticket elsewhere
 * (front desk) place focus themselves in onChanged; this only acts when focus is actually lost.
 */
export function StatusActions({
  a,
  ctx,
  now,
  onChanged,
  focusFallback,
}: {
  a: AppointmentResponse;
  ctx: ApptContext;
  now: Date;
  onChanged: (next: AppointmentResponse) => void;
  focusFallback?: () => HTMLElement | null | undefined;
}) {
  const uid = useId();
  const { toast } = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [confirmNoShow, setConfirmNoShow] = useState(false);
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const refocus = useRef<{ status: string; dialog: HTMLElement | null } | null>(null);
  const fallbackRef = useRef(focusFallback);
  fallbackRef.current = focusFallback;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the status prop changes
  useEffect(() => {
    const want = refocus.current;
    if (!want || want.status !== a.status) return;
    refocus.current = null;
    if (!focusLost()) return;
    const first = groupRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (first ?? fallbackRef.current?.() ?? (want.dialog?.isConnected ? want.dialog : null))?.focus();
  }, [a.status, a.id]);
  const actions = statusActions(a, {
    can: canFn,
    now,
    timeZone: ctx.timeZone,
    noShowGraceMinutes: ctx.noShowGraceMinutes,
  });
  if (actions.length === 0) return null;

  const run = async (act: StatusAction) => {
    setPending(act.to);
    setProblem(null);
    try {
      const next = await schedulingApi.appointments.transition(a.id, { to: act.to });
      toast({ tone: "success", title: `${apptPatientName(a)}: ${act.label.toLowerCase()} done` });
      refocus.current = {
        status: next.status,
        dialog: groupRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null,
      };
      onChanged(next);
    } catch (e) {
      setProblem(describeSchedulingError(e, { timeZone: ctx.timeZone }));
    } finally {
      setPending(null);
      setConfirmNoShow(false);
    }
  };

  return (
    <div className="dos-stack" data-gap="sm">
      <fieldset ref={groupRef} className="dos-cluster sch-fieldset">
        <legend className="dos-sr-only">Change status</legend>
        {actions.map((act) => (
          <Button
            key={act.to}
            size="sm"
            variant={act.to === "NO_SHOW" ? "secondary" : "primary"}
            disabled={!act.enabled || pending !== null}
            loading={pending === act.to}
            aria-describedby={act.reason ? `${uid}-${act.to}` : undefined}
            onClick={() => (act.to === "NO_SHOW" ? setConfirmNoShow(true) : void run(act))}
          >
            {act.label}
          </Button>
        ))}
      </fieldset>
      {actions
        .filter((act) => act.reason)
        .map((act) => (
          <p key={act.to} id={`${uid}-${act.to}`} className="dos-hint" style={{ margin: 0 }}>
            {act.label}: {act.reason}
          </p>
        ))}
      <ProblemAlert problem={problem} />
      <ConfirmDialog
        open={confirmNoShow}
        onOpenChange={setConfirmNoShow}
        title={`Mark ${apptPatientName(a)} as a no-show?`}
        description="The visit is closed as not attended and frees the dentist and chair. This can't be undone; book a new appointment if the patient arrives later."
        confirmLabel="Mark no-show"
        tone="danger"
        loading={pending === "NO_SHOW"}
        onConfirm={() => {
          const act = actions.find((x) => x.to === "NO_SHOW");
          if (act) void run(act);
        }}
      />
    </div>
  );
}

/** Cancel needs a reason (DB CHECK; API 400 reason_required). */
export function CancelDialog({
  a,
  timeZone,
  onClose,
  onDone,
}: {
  a: AppointmentResponse;
  timeZone: string;
  onClose: () => void;
  onDone: (next: AppointmentResponse) => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [pending, setPending] = useState(false);
  const formId = useId();

  const submit = async () => {
    if (reason.trim().length < 3) {
      setError("Give a reason (at least 3 characters).");
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const next = await schedulingApi.appointments.cancel(a.id, reason.trim());
      toast({ tone: "success", title: "Appointment cancelled" });
      onDone(next);
    } catch (e) {
      const p = describeSchedulingError(e, { timeZone });
      if (p.field === "reason") setError(p.message);
      else setProblem(p);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Cancel ${apptPatientName(a)}'s appointment?`}
      description={`${whenLabel(a, timeZone)}. The slot is freed for other bookings. The record and its history are kept.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep appointment
          </Button>
          <Button variant="danger" type="submit" form={formId} loading={pending}>
            Cancel appointment
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="dos-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ProblemAlert problem={problem} />
        <TextareaField
          label="Reason"
          required
          hint="Shown in the appointment history, e.g. “Patient called: travelling”."
          rows={3}
          maxLength={500}
          value={reason}
          error={error}
          onChange={(e) => {
            setReason(e.target.value);
            setError(undefined);
          }}
        />
      </form>
    </Dialog>
  );
}

/** Quick view opened from the calendar: facts, status buttons, reschedule / cancel, details link. */
export function AppointmentPanel({
  a,
  ctx,
  now,
  onClose,
  onChanged,
  onReschedule,
  onCancel,
}: {
  a: AppointmentResponse;
  ctx: ApptContext;
  now: Date;
  onClose: () => void;
  onChanged: (next: AppointmentResponse) => void;
  onReschedule: (a: AppointmentResponse) => void;
  onCancel: (a: AppointmentResponse) => void;
}) {
  const Link = useLink();
  const manage = manageActions(a, canFn);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={apptPatientName(a)}
      description={whenLabel(a, ctx.timeZone)}
      footer={
        <>
          <Link
            href={`/appointments/${a.id}`}
            className="dos-btn"
            data-variant="ghost"
            data-size="md"
          >
            Open details
          </Link>
          {manage.reschedule ? (
            <Button variant="secondary" onClick={() => onReschedule(a)}>
              Reschedule
            </Button>
          ) : null}
          {manage.cancel ? (
            <Button variant="danger" onClick={() => onCancel(a)}>
              Cancel
            </Button>
          ) : null}
        </>
      }
    >
      <div className="dos-stack">
        <div className="dos-cluster">
          <StatusBadge status={a.status} />
          <SourceBadge source={a.source} />
          {a.patient?.mrn ? <span className="dos-muted dos-mono">{a.patient.mrn}</span> : null}
        </div>
        <StatusActions a={a} ctx={ctx} now={now} onChanged={onChanged} />
        <AppointmentFacts a={a} ctx={ctx} />
        <Link href={`/patients/${a.patientId}`}>View patient profile</Link>
      </div>
    </Drawer>
  );
}
