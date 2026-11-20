"use client";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Drawer,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  TextareaField,
  useToast,
} from "@dentalos/ui";
import {
  APPOINTMENT_TYPES,
  type AppointmentResponse,
  type BookAppointmentRequest,
  type CreateWalkInRequest,
  type PatientSummary,
  type RescheduleAppointmentRequest,
  hhmmToMinutes,
  minutesToHHMM,
} from "@dentalos/validation";
import { type FormEvent, useId, useMemo, useState } from "react";
import { api } from "../../lib/api/endpoints";
import { useQuery } from "../../lib/api/hooks";
import { schedulingApi } from "../../lib/api/scheduling";
import {
  type SchedulingProblem,
  describeSchedulingError,
  isBookablePlan,
} from "../../lib/api/scheduling-rules";
import {
  formatTime,
  isValidDay,
  localOf,
  minutesBetween,
  timeOptions,
  todayIn,
  zonedIso,
} from "../../lib/api/scheduling-time";
import { humanize, patientName } from "../../lib/format";
import { canDo } from "../../lib/session";
import { ProblemAlert, whenLabel } from "./appointment-actions";
import { apptPatientName } from "./bits";
import { PatientPicker } from "./patient-picker";
import {
  LIMITED_DENTISTS_HINT,
  chairText,
  useChairs,
  useDentists,
  useSchedulingSettings,
} from "./use-scheduling";

export const DURATIONS = [10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240] as const;

export interface BookingSeed {
  day: string;
  minute: number;
  chairId?: string | null;
  dentistUserId?: string | null;
  patient?: PatientSummary | null;
}

type Values = {
  day: string;
  time: string;
  durationMin: string;
  dentistUserId: string;
  chairId: string;
  appointmentType: string;
  planItemId: string;
  notes: string;
  reason: string;
  outsideHoursReason: string;
};

const asSummary = (p: PatientSummary): PatientSummary => ({
  id: p.id,
  mrn: p.mrn,
  firstName: p.firstName,
  lastName: p.lastName,
  preferredName: p.preferredName,
  dob: p.dob,
  sex: p.sex,
  phone: p.phone,
  originBranchId: p.originBranchId,
  lifecycleStage: p.lifecycleStage,
  mergedIntoId: p.mergedIntoId,
});

/** ACCEPTED plan items of the patient that a booking can be linked to (optional FK). */
function usePlanItems(patientId: string | undefined, branchId: string) {
  return useQuery(
    async () => {
      if (!patientId) return [];
      const plans = await schedulingApi.plans.list({ patientId });
      const open = plans.items.filter(isBookablePlan);
      const [details, services] = await Promise.all([
        Promise.all(open.slice(0, 5).map((p) => schedulingApi.plans.get(p.id))),
        api.catalog
          .services({ branchId, limit: 100 })
          .then((r) => new Map(r.items.map((s) => [s.id, s.name])))
          .catch(() => new Map<string, string>()),
      ]);
      return details.flatMap((plan) =>
        plan.items
          .filter((i) => i.status === "ACCEPTED")
          .map((i) => ({
            id: i.id,
            label: [
              services.get(i.serviceId) ?? "Treatment",
              i.toothCode ? `tooth ${i.toothCode}` : null,
              `${plan.title} · phase ${i.phase}`,
            ]
              .filter(Boolean)
              .join(" · "),
          })),
      );
    },
    [patientId, branchId],
    Boolean(patientId),
  );
}

/**
 * Book (POST /appointments) or reschedule (POST /appointments/:id/reschedule → a NEW appointment)
 * in the branch time zone. 409s are explained inline: slot_conflict names the double-booked
 * resource and marks its field, outside_working_hours offers the override reason when the user has
 * schedule:manage, patient_merged offers the surviving record.
 */
export function BookingDrawer({
  branchId,
  timeZone,
  seed,
  appointment,
  onClose,
  onDone,
}: {
  branchId: string;
  timeZone: string;
  seed?: BookingSeed;
  /** Reschedule this appointment instead of booking a new one. */
  appointment?: AppointmentResponse;
  onClose: () => void;
  onDone: (a: AppointmentResponse) => void;
}) {
  const uid = useId();
  const formId = `${uid}-form`;
  const { toast } = useToast();
  const isReschedule = Boolean(appointment);
  const {
    dentists,
    label: dentistLabel,
    limited,
  } = useDentists(branchId, [appointment?.dentistUserId, seed?.dentistUserId]);
  const { active: chairs, label: chairLabel } = useChairs(branchId);
  const { settings, slotMinutes } = useSchedulingSettings(branchId);
  const canManage = canDo("schedule:manage", { branchId });

  const start = appointment ? localOf(appointment.startsAt, timeZone) : null;
  const [patient, setPatient] = useState<PatientSummary | null>(
    appointment?.patient ?? seed?.patient ?? null,
  );
  const [v, setV] = useState<Values>({
    day: start?.date ?? seed?.day ?? todayIn(timeZone),
    time: minutesToHHMM(start?.minuteOfDay ?? seed?.minute ?? 9 * 60),
    durationMin: String(
      appointment ? minutesBetween(appointment.startsAt, appointment.endsAt) : 30,
    ),
    dentistUserId: appointment?.dentistUserId ?? seed?.dentistUserId ?? "",
    chairId: appointment?.chairId ?? seed?.chairId ?? "",
    appointmentType: appointment?.appointmentType ?? "CONSULTATION",
    planItemId: "",
    notes: "",
    reason: "",
    outsideHoursReason: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof Values>(k: K, value: Values[K]) => {
    setV((s) => ({ ...s, [k]: value }));
    setErrors((e) => {
      if (!(k in e)) return e;
      const { [k]: _, ...rest } = e;
      return rest;
    });
  };

  const duration = Number(v.durationMin);
  const availability = useQuery(
    () =>
      schedulingApi.availability({
        branchId,
        date: v.day,
        durationMin: duration,
        dentistUserId: v.dentistUserId || undefined,
        chairId: v.chairId || undefined,
      }),
    [branchId, v.day, duration, v.dentistUserId, v.chairId],
    Boolean(branchId) && isValidDay(v.day),
  );
  const freeTimes = useMemo(() => {
    const now = Date.now();
    return (availability.data?.slots ?? [])
      .filter((s) => Date.parse(s.startsAt) >= now - 5 * 60_000)
      .slice(0, 16)
      .map((s) => formatTime(s.startsAt, timeZone));
  }, [availability.data, timeZone]);
  const planItems = usePlanItems(isReschedule ? undefined : patient?.id, branchId);
  const times = useMemo(() => {
    const opts = timeOptions(Math.min(slotMinutes, 15));
    return opts.includes(v.time) ? opts : [...opts, v.time].sort();
  }, [slotMinutes, v.time]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!isReschedule && !patient) e.patientId = "Choose a patient.";
    if (!isValidDay(v.day)) e.day = "Enter a date.";
    if (!/^\d{2}:\d{2}$/.test(v.time)) e.time = "Choose a time.";
    if (isReschedule && v.reason.trim().length < 3)
      e.reason = "Give a reason (at least 3 characters).";
    if (showOverride && v.outsideHoursReason.trim().length < 3)
      e.outsideHoursReason = "Give a reason (at least 3 characters).";
    if (!v.dentistUserId && settings && !settings.allowUnassignedDentist)
      e.dentistUserId = "This branch requires a dentist on every booking.";
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      requestAnimationFrame(() =>
        document
          .getElementById(formId)
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    const startsAt = zonedIso(v.day, hhmmToMinutes(v.time), timeZone);
    const override =
      showOverride && v.outsideHoursReason.trim() ? v.outsideHoursReason.trim() : undefined;
    setPending(true);
    setProblem(null);
    try {
      let result: AppointmentResponse;
      if (appointment) {
        const body: RescheduleAppointmentRequest = {
          startsAt,
          durationMin: duration,
          dentistUserId: v.dentistUserId || null,
          chairId: v.chairId || null,
          reason: v.reason.trim(),
          ...(override ? { outsideHoursReason: override } : {}),
        };
        result = await schedulingApi.appointments.reschedule(appointment.id, body);
      } else {
        const body: BookAppointmentRequest = {
          patientId: (patient as PatientSummary).id,
          branchId,
          startsAt,
          durationMin: duration,
          appointmentType: v.appointmentType as BookAppointmentRequest["appointmentType"],
          source: "SCHEDULED",
          ...(v.dentistUserId ? { dentistUserId: v.dentistUserId } : {}),
          ...(v.chairId ? { chairId: v.chairId } : {}),
          ...(v.planItemId ? { planItemId: v.planItemId } : {}),
          ...(v.notes.trim() ? { notes: v.notes.trim() } : {}),
          ...(override ? { outsideHoursReason: override } : {}),
        };
        result = await schedulingApi.appointments.book(body);
      }
      toast({
        tone: "success",
        title: appointment ? "Appointment rescheduled" : "Appointment booked",
        description: `${apptPatientName(result.patient ? result : { ...result, patient: patient ?? undefined })}, ${whenLabel(result, timeZone)}`,
      });
      onDone(result);
    } catch (err) {
      const p = describeSchedulingError(err, {
        canManageSchedule: canManage,
        timeZone,
        dentistLabel: v.dentistUserId ? dentistLabel(v.dentistUserId) : undefined,
        chairLabel: v.chairId ? chairLabel(v.chairId).split(" · ")[0] : undefined,
      });
      setProblem(p);
      if (p.offerOutsideHoursReason) setShowOverride(true);
      const fe: Record<string, string> = { ...(p.fieldErrors ?? {}) };
      if (p.field && !fe[p.field]) fe[p.field === "startsAt" ? "time" : p.field] = p.title;
      setErrors(fe);
    } finally {
      setPending(false);
    }
  };

  const switchToSurvivor = async (id: string) => {
    try {
      const p = await api.patients.get(id);
      setPatient(asSummary(p));
      setProblem(null);
      set("planItemId", "");
    } catch (e) {
      setProblem(describeSchedulingError(e));
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={appointment ? `Reschedule ${apptPatientName(appointment)}` : "Book appointment"}
      description={
        appointment
          ? `Currently ${whenLabel(appointment, timeZone)}. A new appointment is created and this one is kept as rescheduled.`
          : `Times are in the branch time zone (${timeZone}).`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {appointment ? "Reschedule" : showOverride ? "Book outside hours" : "Book"}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate className="dos-stack" onSubmit={(e) => void submit(e)}>
        <ProblemAlert problem={problem}>
          {problem?.survivorId ? (
            <div style={{ marginTop: 8 }}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void switchToSurvivor(problem.survivorId as string)}
              >
                Use the surviving record
              </Button>
            </div>
          ) : null}
        </ProblemAlert>

        {isReschedule ? (
          <p style={{ margin: 0 }}>
            <strong>{patient ? patientName(patient) : "Patient"}</strong>
          </p>
        ) : (
          <PatientPicker
            value={patient}
            onChange={(p) => {
              setPatient(p);
              set("planItemId", "");
              setErrors((e) => {
                const { patientId: _, ...rest } = e;
                return rest;
              });
            }}
            error={errors.patientId}
            autoFocus={!seed?.patient}
          />
        )}

        <div className="dos-form-grid">
          <TextField
            label="Date"
            type="date"
            required
            value={v.day}
            error={errors.day}
            onChange={(e) => set("day", e.target.value)}
          />
          <SelectField
            label="Start time"
            required
            value={v.time}
            error={errors.time ?? errors.startsAt}
            onChange={(e) => set("time", e.target.value)}
          >
            {times.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </SelectField>
        </div>

        <fieldset className="dos-fieldset">
          <legend className="dos-label">Free times on this date</legend>
          {availability.loading ? (
            <Spinner label="Finding free times" />
          ) : freeTimes.length ? (
            <div className="sch-chips">
              {freeTimes.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="sch-chip"
                  aria-pressed={t === v.time}
                  onClick={() => set("time", t)}
                >
                  {t}
                </button>
              ))}
            </div>
          ) : (
            <p className="dos-hint" style={{ margin: 0 }}>
              {availability.error
                ? "Free times couldn't be loaded; you can still pick a time."
                : "No free time for this duration, dentist and chair on this date."}
            </p>
          )}
        </fieldset>

        <div className="dos-form-grid">
          <SelectField
            label="Duration"
            value={v.durationMin}
            onChange={(e) => set("durationMin", e.target.value)}
          >
            {[...new Set([...DURATIONS, duration])]
              .sort((a, b) => a - b)
              .map((d) => (
                <option key={d} value={d}>
                  {d} min
                </option>
              ))}
          </SelectField>
          {isReschedule ? null : (
            <SelectField
              label="Type"
              value={v.appointmentType}
              onChange={(e) => set("appointmentType", e.target.value)}
            >
              {APPOINTMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </SelectField>
          )}
          <SelectField
            label="Dentist"
            value={v.dentistUserId}
            error={errors.dentistUserId}
            hint={[
              settings && !settings.allowUnassignedDentist
                ? "Required at this branch."
                : "Optional.",
              limited ? LIMITED_DENTISTS_HINT : null,
            ]
              .filter(Boolean)
              .join(" ")}
            onChange={(e) => set("dentistUserId", e.target.value)}
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
            value={v.chairId}
            error={errors.chairId}
            hint="Optional"
            onChange={(e) => set("chairId", e.target.value)}
          >
            <option value="">No chair</option>
            {chairs.map((c) => (
              <option key={c.id} value={c.id}>
                {chairText(c)}
              </option>
            ))}
          </SelectField>
        </div>

        {!isReschedule && patient ? (
          <SelectField
            label="Treatment-plan item"
            hint={
              planItems.loading
                ? "Loading accepted plan items…"
                : (planItems.data?.length ?? 0) === 0
                  ? "No accepted plan items for this patient."
                  : "Optional: links this visit to an accepted item."
            }
            value={v.planItemId}
            error={errors.planItemId}
            disabled={(planItems.data?.length ?? 0) === 0}
            onChange={(e) => set("planItemId", e.target.value)}
          >
            <option value="">None</option>
            {(planItems.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </SelectField>
        ) : null}

        {isReschedule ? (
          <TextareaField
            label="Reason for rescheduling"
            required
            rows={2}
            maxLength={500}
            value={v.reason}
            error={errors.reason}
            onChange={(e) => set("reason", e.target.value)}
          />
        ) : (
          <TextareaField
            label="Notes"
            rows={2}
            maxLength={2000}
            value={v.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        )}

        {showOverride ? (
          <TextareaField
            label="Reason for booking outside working hours"
            required
            rows={2}
            maxLength={500}
            hint="Recorded on the appointment (you have schedule management rights)."
            value={v.outsideHoursReason}
            error={errors.outsideHoursReason}
            onChange={(e) => set("outsideHoursReason", e.target.value)}
          />
        ) : null}
      </form>
    </Drawer>
  );
}

/**
 * Walk-in / urgent quick intake (POST /appointments/walk-in): starts now and is checked in straight
 * away by default. Urgent visits go to the top of the waiting queue.
 */
export function WalkInDialog({
  branchId,
  timeZone,
  onClose,
  onDone,
}: {
  branchId: string;
  timeZone: string;
  onClose: () => void;
  onDone: (a: AppointmentResponse) => void;
}) {
  const uid = useId();
  const formId = `${uid}-walkin`;
  const { toast } = useToast();
  const { dentists, limited } = useDentists(branchId);
  const { active: chairs } = useChairs(branchId);
  const canCheckIn = canDo("appointment:checkin", { branchId });
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [source, setSource] = useState<"WALK_IN" | "URGENT">("WALK_IN");
  const [durationMin, setDuration] = useState("30");
  const [dentistUserId, setDentist] = useState("");
  const [chairId, setChair] = useState("");
  // Until the user picks a type, it follows the source and is left out of the request so the API
  // default applies (EMERGENCY for URGENT, else CONSULTATION).
  const [pickedType, setType] = useState<string | null>(null);
  const appointmentType = pickedType ?? (source === "URGENT" ? "EMERGENCY" : "CONSULTATION");
  const [notes, setNotes] = useState("");
  const [checkIn, setCheckIn] = useState(canCheckIn);
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!patient) {
      setError("Choose a patient.");
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const body: CreateWalkInRequest = {
        patientId: patient.id,
        branchId,
        source,
        durationMin: Number(durationMin),
        ...(pickedType
          ? { appointmentType: pickedType as CreateWalkInRequest["appointmentType"] }
          : {}),
        checkIn,
        ...(dentistUserId ? { dentistUserId } : {}),
        ...(chairId ? { chairId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      const a = await schedulingApi.appointments.walkIn(body);
      const dropped = [
        dentistUserId && !a.dentistUserId ? "dentist" : null,
        chairId && !a.chairId ? "chair" : null,
      ].filter(Boolean);
      toast({
        tone: "success",
        title: `${patientName(patient)} ${checkIn ? "checked in" : "added"} as ${source === "URGENT" ? "urgent" : "walk-in"}`,
        description: dropped.length
          ? `The ${dropped.join(" and ")} you picked is busy now, so it was left unassigned.`
          : undefined,
      });
      onDone(a);
    } catch (e) {
      const p = describeSchedulingError(e, { timeZone });
      setProblem(p);
      if (p.field === "patientId") setError(p.title);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="Walk-in or urgent visit"
      description="Starts now. The dentist and chair are optional and can be assigned later."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {checkIn ? "Add and check in" : "Add visit"}
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
        <PatientPicker
          value={patient}
          onChange={(p) => {
            setPatient(p);
            setError(undefined);
          }}
          error={error}
          autoFocus
        />
        <RadioGroup
          legend="Visit"
          name={`${uid}-source`}
          value={source}
          onChange={(s) => setSource(s as "WALK_IN" | "URGENT")}
          options={[
            { value: "WALK_IN", label: "Walk-in", hint: "Joins the queue in arrival order" },
            { value: "URGENT", label: "Urgent", hint: "Goes to the top of the waiting queue" },
          ]}
        />
        <div className="dos-form-grid">
          <SelectField
            label="Type"
            value={appointmentType}
            onChange={(e) => setType(e.target.value)}
          >
            {APPOINTMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Expected duration"
            value={durationMin}
            onChange={(e) => setDuration(e.target.value)}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} min
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Dentist"
            hint={limited ? `Optional. ${LIMITED_DENTISTS_HINT}` : "Optional"}
            value={dentistUserId}
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
            hint="Optional"
            value={chairId}
            onChange={(e) => setChair(e.target.value)}
          >
            <option value="">No chair</option>
            {chairs.map((c) => (
              <option key={c.id} value={c.id}>
                {chairText(c)}
              </option>
            ))}
          </SelectField>
        </div>
        <TextareaField
          label="Notes"
          hint="e.g. the complaint, for the dentist"
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {canCheckIn ? (
          <Checkbox
            label="Check in now"
            checked={checkIn}
            onChange={(e) => setCheckIn(e.target.checked)}
          />
        ) : (
          <Alert tone="info">
            Your role can't check patients in; the visit is added as booked.
          </Alert>
        )}
      </form>
    </Dialog>
  );
}
