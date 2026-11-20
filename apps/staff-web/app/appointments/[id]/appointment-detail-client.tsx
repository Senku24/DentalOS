"use client";
import {
  Alert,
  Button,
  Drawer,
  PageHeader,
  SelectField,
  TextareaField,
  Timeline,
  type TimelineItem,
  useLink,
  useToast,
} from "@dentalos/ui";
import {
  APPOINTMENT_TYPES,
  type AppointmentDetailResponse,
  type AppointmentResponse,
  type UpdateAppointmentRequest,
} from "@dentalos/validation";
import { useRef, useState } from "react";
import {
  Loadable,
  MockNotice,
  RequirePermission,
  Section,
  useBranches,
} from "../../../components/common";
import {
  AppointmentFacts,
  type ApptContext,
  CancelDialog,
  ProblemAlert,
  StatusActions,
  whenLabel,
} from "../../../components/scheduling/appointment-actions";
import { SourceBadge, StatusBadge, apptPatientName } from "../../../components/scheduling/bits";
import { BookingDrawer } from "../../../components/scheduling/booking-drawer";
import {
  canFn,
  chairText,
  useChairs,
  useDentists,
  useFocusReturn,
  useLiveRefresh,
  useNow,
  useSchedulingSettings,
} from "../../../components/scheduling/use-scheduling";
import { useQuery } from "../../../lib/api/hooks";
import { schedulingApi } from "../../../lib/api/scheduling";
import {
  STATUS_LABELS,
  STATUS_TONES,
  type SchedulingProblem,
  closedNote,
  describeSchedulingError,
  manageActions,
} from "../../../lib/api/scheduling-rules";
import {
  DEFAULT_TIME_ZONE,
  formatTime,
  fullDayLabel,
  localOf,
} from "../../../lib/api/scheduling-time";
import { humanize } from "../../../lib/format";
import { userLabel } from "../../../lib/session";

/** Appointment detail: facts, status actions, reschedule / cancel / edit, and the event history. */
export function AppointmentDetailClient({ id }: { id: string }) {
  const q = useQuery(() => schedulingApi.appointments.get(id), [id]);
  return (
    <RequirePermission permission="appointment:read">
      <Loadable state={q} rows={6}>
        {(a) => <Detail a={a} reload={q.reload} />}
      </Loadable>
    </RequirePermission>
  );
}

function Detail({ a, reload }: { a: AppointmentDetailResponse; reload: () => void }) {
  const Link = useLink();
  const now = useNow();
  const { branches, name: branchName } = useBranches();
  const tz = branches.find((b) => b.id === a.branchId)?.timezone ?? DEFAULT_TIME_ZONE;
  const dentists = useDentists(a.branchId, [a.dentistUserId]);
  const chairs = useChairs(a.branchId);
  const { noShowGraceMinutes } = useSchedulingSettings(a.branchId);
  useLiveRefresh(a.branchId, reload);
  const [mode, setModeState] = useState<"reschedule" | "cancel" | "edit" | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  // Drawers/dialogs have no Radix trigger: return focus to the header button that opened them.
  const focus = useFocusReturn(() => statusRef.current);
  const setMode = (m: "reschedule" | "cancel" | "edit" | null) => {
    if (m) focus.remember();
    setModeState(m);
    if (!m) focus.restore();
  };
  const manage = manageActions(a, canFn);
  const note = closedNote(a, manage);
  const ctx: ApptContext = {
    timeZone: tz,
    noShowGraceMinutes,
    dentistLabel: dentists.label,
    chairLabel: chairs.label,
  };
  const name = apptPatientName(a);

  const history: TimelineItem[] = [...a.events]
    .sort((x, y) => y.at.localeCompare(x.at))
    .map((e, i) => ({
      id: e.id,
      title: e.fromStatus
        ? `${STATUS_LABELS[e.fromStatus]} → ${STATUS_LABELS[e.toStatus]}`
        : `${STATUS_LABELS[e.toStatus]} (created)`,
      meta: `${fullDayLabel(localOf(e.at, tz).date)} ${formatTime(e.at, tz)} · ${userLabel(e.actorId)}`,
      description: e.reason ?? undefined,
      tone: STATUS_TONES[e.toStatus],
      current: i === 0,
    }));

  return (
    <>
      <PageHeader
        title={name}
        description={`${humanize(a.appointmentType)} · ${whenLabel(a, tz)} · ${branchName(a.branchId)}`}
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Appointments", href: "/appointments" },
          { label: name },
        ]}
        actions={
          <>
            {manage.edit ? (
              <Button variant="secondary" onClick={() => setMode("edit")}>
                Edit details
              </Button>
            ) : null}
            {manage.reschedule ? (
              <Button variant="secondary" onClick={() => setMode("reschedule")}>
                Reschedule
              </Button>
            ) : null}
            {manage.cancel ? (
              <Button variant="danger" onClick={() => setMode("cancel")}>
                Cancel
              </Button>
            ) : null}
          </>
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <div className="dos-cluster">
          <StatusBadge status={a.status} />
          <SourceBadge source={a.source} />
          <Link href={`/patients/${a.patientId}`}>Patient profile</Link>
          <Link href={`/appointments?date=${localOf(a.startsAt, tz).date}`}>Show in calendar</Link>
        </div>
        {a.status === "RESCHEDULED" && a.rescheduledToId ? (
          <Alert tone="info">
            This appointment was rescheduled.{" "}
            <Link href={`/appointments/${a.rescheduledToId}`}>Open the new appointment</Link>
          </Alert>
        ) : null}
        {a.rescheduledFromId ? (
          <p className="dos-muted" style={{ margin: 0 }}>
            Rescheduled from{" "}
            <Link href={`/appointments/${a.rescheduledFromId}`}>an earlier appointment</Link>.
          </p>
        ) : null}
        <Section title="Status">
          <div ref={statusRef} tabIndex={-1} className="dos-stack" data-gap="sm">
            <StatusActions
              a={a}
              ctx={ctx}
              now={now}
              onChanged={reload}
              focusFallback={() => statusRef.current}
            />
            {note ? (
              <p className="dos-muted" style={{ margin: 0 }}>
                {note}
              </p>
            ) : null}
          </div>
        </Section>
        <Section title="Details">
          <AppointmentFacts a={a} ctx={ctx} columns={2} />
        </Section>
        <Section title="History" description="Every status change, who made it and why.">
          {history.length ? (
            <Timeline items={history} label="Appointment history" />
          ) : (
            <p className="dos-muted">No events recorded.</p>
          )}
        </Section>
      </div>

      {mode === "reschedule" ? (
        <BookingDrawer
          branchId={a.branchId}
          timeZone={tz}
          appointment={a}
          onClose={() => setMode(null)}
          onDone={() => {
            setMode(null);
            reload();
          }}
        />
      ) : null}
      {mode === "cancel" ? (
        <CancelDialog
          a={a}
          timeZone={tz}
          onClose={() => setMode(null)}
          onDone={() => {
            setMode(null);
            reload();
          }}
        />
      ) : null}
      {mode === "edit" ? (
        <EditDrawer
          a={a}
          timeZone={tz}
          dentists={dentists.dentists}
          chairs={chairs.active}
          onClose={() => setMode(null)}
          onDone={() => {
            setMode(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

/** PATCH type / dentist / chair / notes (no time changes: that is a reschedule). */
function EditDrawer({
  a,
  timeZone,
  dentists,
  chairs,
  onClose,
  onDone,
}: {
  a: AppointmentResponse;
  timeZone: string;
  dentists: { userId: string; label: string }[];
  chairs: { id: string; code: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [type, setType] = useState(a.appointmentType);
  const [dentist, setDentist] = useState(a.dentistUserId ?? "");
  const [chair, setChair] = useState(a.chairId ?? "");
  const [notes, setNotes] = useState(a.notes ?? "");
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const formId = "appt-edit";

  const submit = async () => {
    const body: UpdateAppointmentRequest = {};
    if (type !== a.appointmentType)
      body.appointmentType = type as UpdateAppointmentRequest["appointmentType"];
    if ((dentist || null) !== a.dentistUserId) body.dentistUserId = dentist || null;
    if ((chair || null) !== a.chairId) body.chairId = chair || null;
    if ((notes.trim() || null) !== a.notes) body.notes = notes.trim() || null;
    if (Object.keys(body).length === 0) return onClose();
    setPending(true);
    setProblem(null);
    try {
      await schedulingApi.appointments.update(a.id, body);
      toast({ tone: "success", title: "Appointment updated" });
      onDone();
    } catch (e) {
      const p = describeSchedulingError(e, {
        timeZone,
        dentistLabel: dentists.find((d) => d.userId === dentist)?.label,
        chairLabel: chairs.find((c) => c.id === chair)?.code,
      });
      setProblem(p);
      setErrors(p.field ? { [p.field]: p.title } : {});
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit appointment"
      description="To change the time, reschedule instead."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            Save changes
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
        <SelectField label="Type" value={type} onChange={(e) => setType(e.target.value)}>
          {[...new Set([...APPOINTMENT_TYPES, a.appointmentType])].map((t) => (
            <option key={t} value={t}>
              {humanize(t)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Dentist"
          value={dentist}
          error={errors.dentistUserId}
          onChange={(e) => setDentist(e.target.value)}
        >
          <option value="">Unassigned</option>
          {dentists.map((d) => (
            <option key={d.userId} value={d.userId}>
              {d.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Chair"
          value={chair}
          error={errors.chairId}
          onChange={(e) => setChair(e.target.value)}
        >
          <option value="">No chair</option>
          {chairs.map((c) => (
            <option key={c.id} value={c.id}>
              {chairText(c)}
            </option>
          ))}
        </SelectField>
        <TextareaField
          label="Notes"
          rows={3}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </form>
    </Drawer>
  );
}
