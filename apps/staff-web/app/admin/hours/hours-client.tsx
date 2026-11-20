"use client";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DescriptionList,
  Drawer,
  PageHeader,
  RadioGroup,
  SelectField,
  Tabs,
  TextField,
  TextareaField,
  useToast,
} from "@dentalos/ui";
import {
  type SchedulingSettingsResponse,
  type UpdateSchedulingSettingsRequest,
  type WorkingHoursSession,
  setWorkingHoursRequest,
} from "@dentalos/validation";
import { useId, useMemo, useState } from "react";
import {
  BranchOptions,
  Loadable,
  MockNotice,
  RequirePermission,
  Section,
} from "../../../components/common";
import { ProblemAlert } from "../../../components/scheduling/appointment-actions";
import { BranchGate } from "../../../components/scheduling/bits";
import { WeeklySessionsEditor, sessionsText } from "../../../components/scheduling/hours-editor";
import {
  LIMITED_DENTISTS_HINT,
  chairText,
  useChairs,
  useDentists,
  useFocusReturn,
  useSchedulingBranch,
} from "../../../components/scheduling/use-scheduling";
import { useQuery } from "../../../lib/api/hooks";
import { schedulingApi } from "../../../lib/api/scheduling";
import {
  type HoursPeriod,
  WEEKDAY_NAMES,
  WEEKDAY_ORDER,
  branchJsonHours,
  hoursPeriods,
  scheduleOn,
} from "../../../lib/api/scheduling-hours";
import { type SchedulingProblem, describeSchedulingError } from "../../../lib/api/scheduling-rules";
import { addDays, fullDayLabel, todayIn } from "../../../lib/api/scheduling-time";
import { validate } from "../../../lib/forms";
import { canDo } from "../../../lib/session";

type Scope = "BRANCH" | "DENTIST" | "CHAIR";

/** Working hours (branch / dentist / chair, effective-dated) and per-branch scheduling settings. */
export function HoursClient() {
  const sb = useSchedulingBranch();
  const [tab, setTab] = useState("hours");
  return (
    <RequirePermission permission="appointment:read">
      <PageHeader
        title="Working hours"
        description="Bookable hours and scheduling rules per branch"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Administration" },
          { label: "Working hours" },
        ]}
      />
      <div className="dos-stack">
        <MockNotice />
        <BranchGate sb={sb}>
          <div className="sch-filters">
            <SelectField
              label="Branch"
              value={sb.branchId}
              onChange={(e) => sb.setBranchId(e.target.value)}
            >
              <BranchOptions branches={sb.branches} ids={sb.scoped} />
            </SelectField>
          </div>
          <Tabs
            label="Scheduling administration"
            items={[
              { id: "hours", label: "Working hours" },
              { id: "settings", label: "Scheduling settings" },
            ]}
            value={tab}
            onValueChange={setTab}
          >
            {sb.branchId ? (
              tab === "hours" ? (
                <HoursPanel key={sb.branchId} sb={sb} />
              ) : (
                <SettingsPanel key={sb.branchId} branchId={sb.branchId} />
              )
            ) : null}
          </Tabs>
        </BranchGate>
      </div>
    </RequirePermission>
  );
}

function HoursPanel({ sb }: { sb: ReturnType<typeof useSchedulingBranch> }) {
  const uid = useId();
  const { branchId, timeZone: tz, branch } = sb;
  const manage = canDo("schedule:manage", { branchId });
  const today = todayIn(tz);
  const [scope, setScope] = useState<Scope>("BRANCH");
  const [subject, setSubject] = useState("");
  const dentists = useDentists(branchId);
  const chairs = useChairs(branchId);
  const subjects =
    scope === "DENTIST"
      ? dentists.dentists.map((d) => ({ id: d.userId, label: d.label }))
      : scope === "CHAIR"
        ? chairs.chairs.map((c) => ({
            id: c.id,
            label: chairText(c) + (c.active ? "" : " (inactive)"),
          }))
        : [];
  const subjectId = scope === "BRANCH" ? "" : subject || subjects[0]?.id || "";
  const subjectName =
    scope === "BRANCH"
      ? (branch?.name ?? "Branch")
      : (subjects.find((s) => s.id === subjectId)?.label ?? "");

  const rows = useQuery(
    () =>
      schedulingApi.hours.list({
        branchId,
        scope,
        ...(scope === "DENTIST" ? { userId: subjectId } : {}),
        ...(scope === "CHAIR" ? { chairId: subjectId } : {}),
        includeHistory: true,
      }),
    [branchId, scope, subjectId],
    scope === "BRANCH" || Boolean(subjectId),
  );
  const periods = useMemo(() => hoursPeriods(rows.data?.items ?? [], today), [rows.data, today]);
  const current = useMemo(() => scheduleOn(rows.data?.items ?? [], today), [rows.data, today]);
  const [editing, setEditingState] = useState(false);
  // The drawer has no Radix trigger: return focus to "Change hours" on close.
  const focus = useFocusReturn();
  const setEditing = (v: boolean) => {
    if (v) focus.remember();
    setEditingState(v);
    if (!v) focus.restore();
  };

  // A branch record whose hours were never configured (null or {}) is unrestricted in the API.
  const branchUnset = scope === "BRANCH" && branchJsonHours(branch, 1) === null;
  const weekSummary = (p: HoursPeriod | undefined) =>
    WEEKDAY_ORDER.map((wd) => {
      const json = scope === "BRANCH" ? branchJsonHours(branch, wd) : null;
      const s = p
        ? p.sessions.filter((x) => x.weekday === wd)
        : json
          ? json.map((i) => ({ startMinute: i.start, endMinute: i.end }))
          : null;
      return {
        term: WEEKDAY_NAMES[wd],
        detail:
          s !== null
            ? sessionsText(s)
            : scope === "BRANCH"
              ? "Not set: bookable any time"
              : "Not set: whenever the branch is open",
      };
    });

  const fallbackNote =
    scope === "BRANCH"
      ? branchUnset
        ? "No hours set for this branch: bookings are accepted at any time until you set them."
        : "No effective-dated hours yet: bookings use the hours on the branch record (shown below)."
      : scope === "DENTIST"
        ? "No hours set: this dentist is bookable whenever the branch is open."
        : "No hours set: this chair is bookable whenever the branch is open.";

  return (
    <div className="dos-stack">
      <div className="dos-form-grid">
        <RadioGroup
          legend="Hours for"
          name={`${uid}-scope`}
          value={scope}
          onChange={(v) => {
            setScope(v as Scope);
            setSubject("");
          }}
          options={[
            { value: "BRANCH", label: "The branch", hint: "Opening hours" },
            { value: "DENTIST", label: "A dentist", hint: "Within branch hours" },
            { value: "CHAIR", label: "A chair", hint: "Within branch hours" },
          ]}
        />
        {scope !== "BRANCH" ? (
          <SelectField
            label={scope === "DENTIST" ? "Dentist" : "Chair"}
            hint={scope === "DENTIST" && dentists.limited ? LIMITED_DENTISTS_HINT : undefined}
            value={subjectId}
            onChange={(e) => setSubject(e.target.value)}
          >
            {subjects.length === 0 ? <option value="">None at this branch</option> : null}
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </SelectField>
        ) : null}
      </div>

      {scope !== "BRANCH" && !subjectId ? null : (
        <Loadable state={rows}>
          {() => (
            <>
              <Section
                title={`${subjectName}: in force today`}
                description={
                  current ? `Since ${fullDayLabel(current.effectiveFrom)}` : fallbackNote
                }
                actions={
                  manage ? (
                    <Button onClick={() => setEditing(true)}>Change hours</Button>
                  ) : undefined
                }
              >
                <DescriptionList columns={2} items={weekSummary(current)} />
              </Section>
              <Section
                title="Scheduled changes and history"
                description="Changes take effect from a date; past periods are kept for the record."
              >
                {periods.length === 0 ? (
                  <p className="dos-muted" style={{ margin: 0 }}>
                    No effective-dated hours recorded.
                  </p>
                ) : (
                  <ul className="dos-stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {periods.map((p) => (
                      <li
                        key={`${p.effectiveFrom}-${p.effectiveTo}`}
                        className="dos-stack"
                        data-gap="sm"
                      >
                        <div className="dos-cluster">
                          <strong>
                            {fullDayLabel(p.effectiveFrom)}
                            {p.effectiveTo
                              ? ` – ${fullDayLabel(addDays(p.effectiveTo, -1))}`
                              : " onwards"}
                          </strong>
                          <Badge
                            tone={
                              p.state === "current"
                                ? "success"
                                : p.state === "scheduled"
                                  ? "info"
                                  : "neutral"
                            }
                          >
                            {p.state === "current"
                              ? "In force"
                              : p.state === "scheduled"
                                ? "Scheduled"
                                : "Ended"}
                          </Badge>
                        </div>
                        <p className="dos-muted" style={{ margin: 0 }}>
                          {WEEKDAY_ORDER.map((wd) => {
                            const s = p.sessions.filter((x) => x.weekday === wd);
                            return s.length
                              ? `${WEEKDAY_NAMES[wd].slice(0, 3)} ${sessionsText(s)}`
                              : null;
                          })
                            .filter(Boolean)
                            .join(" · ") || "Closed all week"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
        </Loadable>
      )}

      {editing ? (
        <HoursDrawer
          branchId={branchId}
          scope={scope}
          subjectId={subjectId}
          subjectName={subjectName}
          today={today}
          scheduled={periods.filter((p) => p.state === "scheduled").map((p) => p.effectiveFrom)}
          initial={
            scheduleOn(rows.data?.items ?? [], addDays(today, 1))?.sessions ??
            (scope === "BRANCH"
              ? WEEKDAY_ORDER.flatMap((wd) =>
                  (branchJsonHours(branch, wd) ?? []).map((i) => ({
                    weekday: wd,
                    startMinute: i.start,
                    endMinute: i.end,
                  })),
                )
              : [])
          }
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            rows.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function HoursDrawer({
  branchId,
  scope,
  subjectId,
  subjectName,
  today,
  scheduled,
  initial,
  onClose,
  onSaved,
}: {
  branchId: string;
  scope: Scope;
  subjectId: string;
  subjectName: string;
  today: string;
  /** effectiveFrom of scheduled (future) periods: the API supersedes those on/after the new date. */
  scheduled: string[];
  initial: WorkingHoursSession[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [effectiveFrom, setFrom] = useState(addDays(today, 1));
  const [sessions, setSessions] = useState<WorkingHoursSession[]>(initial);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [pending, setPending] = useState(false);
  const formId = "hours-form";
  const superseded = scheduled.filter((d) => d >= effectiveFrom);

  const submit = async () => {
    const body = {
      scope,
      branchId,
      ...(scope === "DENTIST" ? { userId: subjectId } : {}),
      ...(scope === "CHAIR" ? { chairId: subjectId } : {}),
      effectiveFrom,
      sessions,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    const r = validate(setWorkingHoursRequest, body);
    const e: Record<string, string> = r.ok ? {} : { ...r.errors };
    if (effectiveFrom < today) e.effectiveFrom = "Choose today or a later date.";
    if (Object.keys(e).length) {
      const sessionError = Object.entries(e).find(([k]) => k.startsWith("sessions"))?.[1];
      setErrors({ ...e, ...(sessionError ? { sessions: sessionError } : {}) });
      return;
    }
    setErrors({});
    setProblem(null);
    setPending(true);
    try {
      await schedulingApi.hours.set(body as Parameters<typeof schedulingApi.hours.set>[0]);
      toast({
        tone: "success",
        title: "Working hours saved",
        description: `${subjectName}: from ${fullDayLabel(effectiveFrom)}`,
      });
      onSaved();
    } catch (err) {
      const p = describeSchedulingError(err);
      setProblem(p);
      if (p.field) setErrors({ [p.field]: p.message });
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Change hours: ${subjectName}`}
      description="The new weekly sessions replace the current ones from the date you choose. Existing appointments are not moved."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            Save hours
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
        <TextField
          label="Effective from"
          type="date"
          required
          min={today}
          hint="Hours already in force today can only change from tomorrow."
          value={effectiveFrom}
          error={errors.effectiveFrom}
          onChange={(e) => setFrom(e.target.value)}
        />
        {superseded.length ? (
          <Alert tone="warning">
            This replaces the scheduled change{superseded.length > 1 ? "s" : ""} from{" "}
            {superseded.map(fullDayLabel).join(", ")}: future hours that have not taken effect are
            superseded.
          </Alert>
        ) : null}
        <WeeklySessionsEditor value={sessions} onChange={setSessions} error={errors.sessions} />
        <TextareaField
          label="Reason"
          hint="Optional, e.g. “Winter timings”"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </form>
    </Drawer>
  );
}

const SLOT_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;

function SettingsPanel({ branchId }: { branchId: string }) {
  const q = useQuery(() => schedulingApi.settings.get(branchId), [branchId]);
  return (
    <Loadable state={q}>
      {(s) => <SettingsForm branchId={branchId} initial={s} onSaved={q.reload} />}
    </Loadable>
  );
}

function SettingsForm({
  branchId,
  initial,
  onSaved,
}: {
  branchId: string;
  initial: SchedulingSettingsResponse;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const manage = canDo("schedule:manage", { branchId });
  const [grace, setGrace] = useState(String(initial.noShowGraceMinutes));
  const [slot, setSlot] = useState(String(initial.slotMinutes));
  const [unassigned, setUnassigned] = useState(initial.allowUnassignedDentist);
  const [outside, setOutside] = useState(initial.allowOutsideHoursBooking);
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    const g = Number(grace);
    if (!Number.isInteger(g) || g < 0 || g > 240) {
      setError("Enter whole minutes from 0 to 240.");
      return;
    }
    const patch: UpdateSchedulingSettingsRequest = {};
    if (g !== initial.noShowGraceMinutes) patch.noShowGraceMinutes = g;
    if (Number(slot) !== initial.slotMinutes) patch.slotMinutes = Number(slot);
    if (unassigned !== initial.allowUnassignedDentist) patch.allowUnassignedDentist = unassigned;
    if (outside !== initial.allowOutsideHoursBooking) patch.allowOutsideHoursBooking = outside;
    if (Object.keys(patch).length === 0) {
      toast({ tone: "info", title: "Nothing to save" });
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      await schedulingApi.settings.update(branchId, patch);
      toast({ tone: "success", title: "Scheduling settings saved" });
      onSaved();
    } catch (e) {
      setProblem(describeSchedulingError(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      className="dos-stack"
      style={{ maxWidth: 640 }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <ProblemAlert problem={problem} />
      <div className="dos-form-grid">
        <TextField
          label="No-show grace (minutes)"
          type="number"
          inputMode="numeric"
          min={0}
          max={240}
          hint="How long after the start time a visit can be marked as a no-show."
          disabled={!manage}
          value={grace}
          error={error}
          onChange={(e) => {
            setGrace(e.target.value);
            setError(undefined);
          }}
        />
        <SelectField
          label="Calendar slot"
          hint="Grid and free-time step."
          disabled={!manage}
          value={slot}
          onChange={(e) => setSlot(e.target.value)}
        >
          {[...new Set([...SLOT_OPTIONS, initial.slotMinutes])]
            .sort((a, b) => a - b)
            .map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
        </SelectField>
      </div>
      <Checkbox
        switch
        label="Allow bookings without a dentist"
        hint="When off, every booking must name a dentist."
        disabled={!manage}
        checked={unassigned}
        onChange={(e) => setUnassigned(e.target.checked)}
      />
      <Checkbox
        switch
        label="Allow bookings outside working hours"
        hint="Managers can then book outside hours with a recorded reason. When off, nobody can."
        disabled={!manage}
        checked={outside}
        onChange={(e) => setOutside(e.target.checked)}
      />
      {manage ? (
        <div>
          <Button type="submit" loading={pending}>
            Save settings
          </Button>
        </div>
      ) : (
        <p className="dos-muted">Only users who manage schedules can change these settings.</p>
      )}
    </form>
  );
}
