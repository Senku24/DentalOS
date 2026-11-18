"use client";
import {
  Badge,
  Button,
  Checkbox,
  DescriptionList,
  Dialog,
  EmptyState,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type AlertResponse,
  type AllergyResponse,
  type MedicalHistoryResponse,
  SEVERITIES,
  addAlertRequest,
  addAllergyRequest,
  addMedicalHistoryRequest,
  resolveRequest,
} from "@dentalos/validation";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Loadable, Section } from "../../../components/common";
import { api } from "../../../lib/api/endpoints";
import type { ApiError } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { formatDateTime, humanize, severityTone } from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { canDo, userLabel } from "../../../lib/session";
import { useProfile } from "./profile-context";

/** Questionnaire keys used by staff-web (answers are form-defined JSON, PRD 4.2). */
const MEDICAL_QUESTIONS: { key: string; label: string }[] = [
  { key: "diabetes", label: "Diabetes" },
  { key: "hypertension", label: "High blood pressure" },
  { key: "heartCondition", label: "Heart condition / pacemaker" },
  { key: "bleedingDisorder", label: "Bleeding disorder or on blood thinners" },
  { key: "pregnant", label: "Pregnant or breastfeeding" },
  { key: "asthma", label: "Asthma / respiratory condition" },
];
const DENTAL_QUESTIONS: { key: string; label: string }[] = [
  { key: "sensitivity", label: "Tooth sensitivity" },
  { key: "bleedingGums", label: "Bleeding gums" },
  { key: "bruxism", label: "Grinds teeth (bruxism)" },
];

const answerText = (v: unknown) =>
  typeof v === "boolean" ? (v ? "Yes" : "No") : Array.isArray(v) ? v.join(", ") : String(v);
const labelFor = (key: string) =>
  [...MEDICAL_QUESTIONS, ...DENTAL_QUESTIONS].find((q) => q.key === key)?.label ?? humanize(key);

export function MedicalTab({ onAlertsChanged }: { onAlertsChanged: () => void }) {
  return (
    <div className="dos-split">
      <HistorySection />
      <div className="dos-stack">
        <AllergiesSection onChanged={onAlertsChanged} />
        <AlertsSection onChanged={onAlertsChanged} />
      </div>
    </div>
  );
}

function HistorySection() {
  const { patient, readOnly, onWriteError } = useProfile();
  const q = useQuery(() => api.patients.medicalHistory(patient.id), [patient.id]);
  const [version, setVersion] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const writable = canDo("medical:write") && !readOnly;
  return (
    <Section
      title="Medical & dental history"
      description="Each update creates a new version; earlier versions are never changed."
      actions={
        writable ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" /> New version
          </Button>
        ) : undefined
      }
    >
      <Loadable state={q}>
        {(d) => {
          if (d.items.length === 0)
            return (
              <EmptyState
                title="No history recorded"
                description="Record the patient's medical history before treatment."
              />
            );
          const sorted = [...d.items].sort((a, b) => b.version - a.version);
          const current =
            sorted.find((h) => h.version === version) ?? (sorted[0] as MedicalHistoryResponse);
          return (
            <div className="dos-stack">
              <SelectField
                label="Version"
                value={String(current.version)}
                onChange={(e) => setVersion(Number(e.target.value))}
              >
                {sorted.map((h, i) => (
                  <option key={h.id} value={h.version}>
                    v{h.version} · {formatDateTime(h.recordedAt)}
                    {i === 0 ? " (latest)" : ""}
                  </option>
                ))}
              </SelectField>
              <p className="dos-muted" style={{ margin: 0 }}>
                Recorded by {userLabel(current.recordedBy)} on {formatDateTime(current.recordedAt)}
              </p>
              <h3 style={{ fontSize: "var(--text-md)" }}>Medical</h3>
              <DescriptionList
                items={Object.entries(current.medical).map(([k, val]) => ({
                  term: labelFor(k),
                  detail: answerText(val),
                }))}
              />
              <h3 style={{ fontSize: "var(--text-md)" }}>Dental</h3>
              <DescriptionList
                items={Object.entries(current.dental).map(([k, val]) => ({
                  term: labelFor(k),
                  detail: answerText(val),
                }))}
              />
              <h3 style={{ fontSize: "var(--text-md)" }}>Medications</h3>
              {current.medications.length ? (
                <ul style={{ margin: 0 }}>
                  {current.medications.map((m) => (
                    <li key={m.name}>
                      {m.name}
                      {m.dose ? ` — ${m.dose}` : ""}
                      {m.frequency ? `, ${m.frequency}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dos-muted" style={{ margin: 0 }}>
                  None recorded
                </p>
              )}
              {current.notes ? (
                <>
                  <h3 style={{ fontSize: "var(--text-md)" }}>Notes</h3>
                  <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{current.notes}</p>
                </>
              ) : null}
            </div>
          );
        }}
      </Loadable>
      {adding ? (
        <HistoryDialog
          latest={q.data?.items.slice().sort((a, b) => b.version - a.version)[0]}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setVersion(null);
            q.reload();
          }}
          onError={onWriteError}
        />
      ) : null}
    </Section>
  );
}

function HistoryDialog({
  latest,
  onClose,
  onSaved,
  onError,
}: {
  latest: MedicalHistoryResponse | undefined;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: ApiError) => void;
}) {
  const { patient } = useProfile();
  const bool = (src: Record<string, unknown> | undefined, k: string) => src?.[k] === true;
  const [medical, setMedical] = useState<Record<string, boolean>>(
    Object.fromEntries(MEDICAL_QUESTIONS.map((q) => [q.key, bool(latest?.medical, q.key)])),
  );
  const [dental, setDental] = useState<Record<string, boolean>>(
    Object.fromEntries(DENTAL_QUESTIONS.map((q) => [q.key, bool(latest?.dental, q.key)])),
  );
  const [meds, setMeds] = useState(
    (latest?.medications ?? []).map((m) => ({
      name: m.name,
      dose: m.dose ?? "",
      frequency: m.frequency ?? "",
    })),
  );
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    (b: ReturnType<typeof addMedicalHistoryRequest.parse>) =>
      api.patients.addMedicalHistory(patient.id, b),
    { success: "Medical history saved as a new version", onSuccess: onSaved, onError },
  );
  const submit = () => {
    const r = validate(addMedicalHistoryRequest, {
      medical,
      dental,
      medications: meds.filter((m) => m.name.trim()),
      notes,
    });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="New medical history version"
      description={`Pre-filled from ${latest ? `v${latest.version}` : "a blank form"}. Saving creates v${(latest?.version ?? 0) + 1}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Save version
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <fieldset className="dos-fieldset">
          <legend className="dos-label">Medical conditions</legend>
          <div className="dos-choice-grid" data-columns={2}>
            {MEDICAL_QUESTIONS.map((q) => (
              <Checkbox
                key={q.key}
                label={q.label}
                checked={medical[q.key] ?? false}
                onChange={(e) => setMedical({ ...medical, [q.key]: e.target.checked })}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="dos-fieldset">
          <legend className="dos-label">Dental</legend>
          <div className="dos-choice-grid" data-columns={2}>
            {DENTAL_QUESTIONS.map((q) => (
              <Checkbox
                key={q.key}
                label={q.label}
                checked={dental[q.key] ?? false}
                onChange={(e) => setDental({ ...dental, [q.key]: e.target.checked })}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="dos-fieldset">
          <legend className="dos-label">Current medications</legend>
          {meds.map((m, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id while editing
              key={i}
              className="dos-form-grid"
              style={{ gridTemplateColumns: "2fr 1fr 1fr auto", alignItems: "end" }}
            >
              <TextField
                label={`Medicine ${i + 1}`}
                value={m.name}
                onChange={(e) =>
                  setMeds(meds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
                error={errors[`medications.${i}.name`]}
              />
              <TextField
                label="Dose"
                value={m.dose}
                onChange={(e) =>
                  setMeds(meds.map((x, j) => (j === i ? { ...x, dose: e.target.value } : x)))
                }
              />
              <TextField
                label="Frequency"
                value={m.frequency}
                onChange={(e) =>
                  setMeds(meds.map((x, j) => (j === i ? { ...x, frequency: e.target.value } : x)))
                }
              />
              <Button
                variant="ghost"
                iconOnly
                aria-label={`Remove medicine ${i + 1}`}
                onClick={() => setMeds(meds.filter((_, j) => j !== i))}
              >
                <X size={16} aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setMeds([...meds, { name: "", dose: "", frequency: "" }])}
            >
              <Plus size={16} aria-hidden="true" /> Add medicine
            </Button>
          </div>
        </fieldset>
        <TextareaField
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={errors.notes}
        />
      </div>
    </Dialog>
  );
}

function AllergiesSection({ onChanged }: { onChanged: () => void }) {
  const { patient, readOnly, onWriteError } = useProfile();
  const q = useQuery(() => api.patients.allergies(patient.id, true), [patient.id]);
  const [adding, setAdding] = useState(false);
  const [resolving, setResolving] = useState<AllergyResponse | null>(null);
  const writable = canDo("medical:write") && !readOnly;
  const resolve = useMutation(
    (a: AllergyResponse, reason?: string) => api.patients.resolveAllergy(patient.id, a.id, reason),
    {
      success: "Allergy marked resolved",
      onSuccess: () => {
        setResolving(null);
        q.reload();
        onChanged();
      },
      onError: onWriteError,
    },
  );
  return (
    <Section
      title="Allergies"
      actions={
        writable ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" /> Add
          </Button>
        ) : undefined
      }
    >
      <Loadable state={q} rows={2}>
        {(d) =>
          d.items.length === 0 ? (
            <p className="dos-muted" style={{ margin: 0 }}>
              No known allergies recorded.
            </p>
          ) : (
            <ul
              className="dos-stack"
              data-gap="sm"
              style={{ listStyle: "none", margin: 0, padding: 0 }}
            >
              {d.items.map((a) => (
                <li
                  key={a.id}
                  className="dos-cluster"
                  style={{ justifyContent: "space-between", opacity: a.active ? 1 : 0.75 }}
                >
                  <div>
                    <div className="dos-cluster">
                      <strong>{a.substance}</strong>
                      <Badge tone={a.active ? severityTone(a.severity) : "neutral"}>
                        {a.active ? humanize(a.severity) : "Resolved"}
                      </Badge>
                    </div>
                    <div className="dos-muted" style={{ fontSize: "var(--text-sm)" }}>
                      {a.reaction ?? "Reaction not recorded"} · noted {formatDateTime(a.notedAt)} by{" "}
                      {userLabel(a.notedBy)}
                    </div>
                  </div>
                  {writable && a.active ? (
                    <Button size="sm" variant="ghost" onClick={() => setResolving(a)}>
                      Resolve<span className="dos-sr-only"> {a.substance} allergy</span>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
      {adding ? (
        <AddSeverityItemDialog
          kind="allergy"
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            q.reload();
            onChanged();
          }}
        />
      ) : null}
      {resolving ? (
        <ResolveDialog
          title={`Resolve ${resolving.substance} allergy?`}
          description="It stays in the record history but no longer shows as an active warning."
          confirmLabel="Mark resolved"
          loading={resolve.pending}
          onClose={() => setResolving(null)}
          onConfirm={(reason) => void resolve.run(resolving, reason)}
        />
      ) : null}
    </Section>
  );
}

function AlertsSection({ onChanged }: { onChanged: () => void }) {
  const { patient, readOnly, onWriteError } = useProfile();
  const q = useQuery(() => api.patients.alerts(patient.id, true), [patient.id]);
  const [adding, setAdding] = useState(false);
  const [resolving, setResolving] = useState<AlertResponse | null>(null);
  const writable = canDo("medical:write") && !readOnly;
  const resolve = useMutation(
    (a: AlertResponse, reason?: string) => api.patients.resolveAlert(patient.id, a.id, reason),
    {
      success: "Alert resolved",
      onSuccess: () => {
        setResolving(null);
        q.reload();
        onChanged();
      },
      onError: onWriteError,
    },
  );
  return (
    <Section
      title="Clinical alerts"
      actions={
        writable ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" /> Add
          </Button>
        ) : undefined
      }
    >
      <Loadable state={q} rows={2}>
        {(d) =>
          d.items.length === 0 ? (
            <p className="dos-muted" style={{ margin: 0 }}>
              No clinical alerts.
            </p>
          ) : (
            <ul
              className="dos-stack"
              data-gap="sm"
              style={{ listStyle: "none", margin: 0, padding: 0 }}
            >
              {d.items.map((a) => (
                <li key={a.id} className="dos-cluster" style={{ justifyContent: "space-between" }}>
                  <div>
                    <div className="dos-cluster">
                      <strong>{a.title}</strong>
                      <Badge tone={a.active ? severityTone(a.severity) : "neutral"}>
                        {a.active ? humanize(a.severity) : "Resolved"}
                      </Badge>
                    </div>
                    {a.details ? (
                      <div style={{ fontSize: "var(--text-sm)" }}>{a.details}</div>
                    ) : null}
                    <div className="dos-muted" style={{ fontSize: "var(--text-sm)" }}>
                      Added {formatDateTime(a.createdAt)} by {userLabel(a.createdBy)}
                    </div>
                  </div>
                  {writable && a.active ? (
                    <Button size="sm" variant="ghost" onClick={() => setResolving(a)}>
                      Resolve<span className="dos-sr-only"> alert {a.title}</span>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
      {adding ? (
        <AddSeverityItemDialog
          kind="alert"
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            q.reload();
            onChanged();
          }}
        />
      ) : null}
      {resolving ? (
        <ResolveDialog
          title={`Resolve alert "${resolving.title}"?`}
          description="It stays in the record history but no longer shows on the patient header."
          confirmLabel="Resolve alert"
          loading={resolve.pending}
          onClose={() => setResolving(null)}
          onConfirm={(reason) => void resolve.run(resolving, reason)}
        />
      ) : null}
    </Section>
  );
}

/** Resolving keeps the row (never deleted); the optional reason is stored with it. */
function ResolveDialog({
  title,
  description,
  confirmLabel,
  loading,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  loading: boolean;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const submit = () => {
    const r = validate(resolveRequest, { reason });
    if (!r.ok) return setError(r.errors.reason);
    onConfirm(r.data.reason);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button loading={loading} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <TextareaField
        label="Reason (optional)"
        hint="e.g. Re-tested negative, condition resolved"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={error}
      />
    </Dialog>
  );
}

function AddSeverityItemDialog({
  kind,
  onClose,
  onSaved,
}: {
  kind: "allergy" | "alert";
  onClose: () => void;
  onSaved: () => void;
}) {
  const { patient, onWriteError } = useProfile();
  const [v, setV] = useState({
    main: "",
    detail: "",
    severity: kind === "allergy" ? "MODERATE" : "HIGH",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    (body: { main: string; detail: string; severity: string }): Promise<unknown> =>
      kind === "allergy"
        ? api.patients.addAllergy(
            patient.id,
            addAllergyRequest.parse({
              substance: body.main,
              reaction: body.detail || undefined,
              severity: body.severity,
            }),
          )
        : api.patients.addAlert(
            patient.id,
            addAlertRequest.parse({
              title: body.main,
              details: body.detail || undefined,
              severity: body.severity,
            }),
          ),
    {
      success: kind === "allergy" ? "Allergy added" : "Alert added",
      onSuccess: onSaved,
      onError: onWriteError,
    },
  );
  const submit = () => {
    const r =
      kind === "allergy"
        ? validate(addAllergyRequest, {
            substance: v.main,
            reaction: v.detail,
            severity: v.severity,
          })
        : validate(addAlertRequest, { title: v.main, details: v.detail, severity: v.severity });
    if (!r.ok) {
      const e = r.errors;
      return setErrors({
        main: e.substance ?? e.title ?? "",
        detail: e.reaction ?? e.details ?? "",
      });
    }
    void save.run(v);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={kind === "allergy" ? "Add allergy" : "Add clinical alert"}
      description="Shown prominently on the patient header for every clinician."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <TextField
          label={kind === "allergy" ? "Substance" : "Title"}
          required
          hint={
            kind === "allergy" ? "e.g. Penicillin, latex, lignocaine" : "e.g. On anticoagulants"
          }
          value={v.main}
          onChange={(e) => setV({ ...v, main: e.target.value })}
          error={errors.main || undefined}
        />
        <TextareaField
          label={kind === "allergy" ? "Reaction" : "Details"}
          value={v.detail}
          onChange={(e) => setV({ ...v, detail: e.target.value })}
          error={errors.detail || undefined}
        />
        <SelectField
          label="Severity"
          value={v.severity}
          onChange={(e) => setV({ ...v, severity: e.target.value })}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </SelectField>
      </div>
    </Dialog>
  );
}
