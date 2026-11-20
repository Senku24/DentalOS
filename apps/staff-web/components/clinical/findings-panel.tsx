"use client";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type DiagnosisResponse,
  type EncounterDetailResponse,
  type ProcedureResponse,
  createDiagnosisRequest,
  createProcedureRequest,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useState } from "react";
import { clinicalApi } from "../../lib/api/clinical";
import { canDeleteAuthored, canEditAuthored } from "../../lib/api/clinical-authorship";
import { useMutation } from "../../lib/api/hooks";
import { formatDateTime, humanize } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import { canDo, sessionPrincipal } from "../../lib/session";
import { Section } from "../common";
import {
  StatusBadge,
  ToothSurfaceFields,
  personLabel,
  useLinkablePlanItems,
  useServiceDirectory,
} from "./bits";
import { toothLong, toothShort } from "./fdi";

/** Diagnoses and procedures of the encounter (immutable once signed). */
export function FindingsPanel({
  encounter,
  onChanged,
  defaultTooth,
}: {
  encounter: EncounterDetailResponse;
  onChanged: () => void;
  defaultTooth?: number;
}) {
  const writable =
    encounter.status === "OPEN" && canDo("clinical:write", { branchId: encounter.branchId });
  return (
    <div className="dos-stack" data-gap="lg">
      <Diagnoses
        encounter={encounter}
        writable={writable}
        onChanged={onChanged}
        defaultTooth={defaultTooth}
      />
      <Procedures
        encounter={encounter}
        writable={writable}
        onChanged={onChanged}
        defaultTooth={defaultTooth}
      />
    </div>
  );
}

function Diagnoses({
  encounter,
  writable,
  onChanged,
  defaultTooth,
}: {
  encounter: EncounterDetailResponse;
  writable: boolean;
  onChanged: () => void;
  defaultTooth?: number;
}) {
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<DiagnosisResponse | null>(null);
  const remove = useMutation(
    (d: DiagnosisResponse) => clinicalApi.encounters.deleteDiagnosis(encounter.id, d.id),
    {
      success: "Diagnosis removed",
      onSuccess: () => {
        setDeleting(null);
        onChanged();
      },
    },
  );
  return (
    <Section
      title="Diagnoses"
      actions={
        writable ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" /> Add diagnosis
          </Button>
        ) : undefined
      }
    >
      {encounter.diagnoses.length === 0 ? (
        <p className="dos-muted" style={{ margin: 0 }}>
          No diagnoses recorded.
        </p>
      ) : (
        <ul className="cw-list">
          {encounter.diagnoses.map((d) => (
            <li key={d.id} className="cw-item">
              <div className="cw-row">
                <strong>
                  <span className="dos-mono">{d.code}</span> {d.label}
                </strong>
                <Badge tone="neutral">
                  <span aria-hidden="true">{toothShort(d.toothCode, d.surfaces)}</span>
                  <span className="dos-sr-only">{toothLong(d.toothCode, d.surfaces)}</span>
                </Badge>
              </div>
              {d.notes ? <p className="cw-body">{d.notes}</p> : null}
              <span className="cw-meta">
                {personLabel(d.diagnosedBy)} · {formatDateTime(d.createdAt)}
              </span>
              {writable &&
              canDeleteAuthored(d.diagnosedBy, encounter, sessionPrincipal().userId) ? (
                <div>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(d)}>
                    Remove<span className="dos-sr-only"> diagnosis {d.label}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <DiagnosisDialog
          encounterId={encounter.id}
          defaultTooth={defaultTooth}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this diagnosis?"
        description="The draft diagnosis is removed from this open encounter. This is audited."
        confirmLabel="Remove diagnosis"
        tone="danger"
        loading={remove.pending}
        onConfirm={() => deleting && void remove.run(deleting)}
      />
    </Section>
  );
}

function DiagnosisDialog({
  encounterId,
  defaultTooth,
  onClose,
  onDone,
}: {
  encounterId: string;
  defaultTooth?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [tooth, setTooth] = useState<number | undefined>(defaultTooth);
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (b: Parameters<typeof clinicalApi.encounters.addDiagnosis>[1]) =>
      clinicalApi.encounters.addDiagnosis(encounterId, b),
    {
      success: "Diagnosis added",
      onSuccess: onDone,
      onError: (e) => setErrors({ ...e.fieldErrors, _form: e.message }),
    },
  );
  const submit = () => {
    const r = validate(createDiagnosisRequest, { code, label, toothCode: tooth, surfaces, notes });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add diagnosis"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Add diagnosis
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <div className="dos-form-grid">
          <TextField
            label="Code"
            hint="ICD-10 (e.g. K02.1) or a clinic code"
            required
            value={code}
            error={errors.code}
            onChange={(e) => setCode(e.target.value)}
          />
          <TextField
            label="Diagnosis"
            required
            value={label}
            error={errors.label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <ToothSurfaceFields
          tooth={tooth}
          surfaces={surfaces}
          error={errors.toothCode}
          surfacesError={errors.surfaces}
          onChange={(t, s) => {
            setTooth(t);
            setSurfaces(s);
          }}
        />
        <TextareaField
          label="Notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {errors._form && Object.keys(errors).length === 1 ? (
          <Alert tone="danger">{errors._form}</Alert>
        ) : null}
      </div>
    </Dialog>
  );
}

function Procedures({
  encounter,
  writable,
  onChanged,
  defaultTooth,
}: {
  encounter: EncounterDetailResponse;
  writable: boolean;
  onChanged: () => void;
  defaultTooth?: number;
}) {
  const services = useServiceDirectory(encounter.branchId);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ProcedureResponse | null>(null);
  const update = useMutation(
    (p: ProcedureResponse, status: "COMPLETED" | "ABANDONED") =>
      clinicalApi.encounters.updateProcedure(encounter.id, p.id, { status }),
    {
      success: (r) => `Procedure ${humanize(r.status).toLowerCase()}`,
      onSuccess: onChanged,
    },
  );
  const remove = useMutation(
    (p: ProcedureResponse) => clinicalApi.encounters.deleteProcedure(encounter.id, p.id),
    {
      success: "Procedure removed",
      onSuccess: () => {
        setDeleting(null);
        onChanged();
      },
    },
  );
  return (
    <Section
      title="Procedures"
      actions={
        writable ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" /> Record procedure
          </Button>
        ) : undefined
      }
    >
      {encounter.procedures.length === 0 ? (
        <p className="dos-muted" style={{ margin: 0 }}>
          No procedures recorded.
        </p>
      ) : (
        <ul className="cw-list">
          {encounter.procedures.map((p) => {
            const name = p.serviceId ? services.label(p.serviceId) : (p.description ?? "Procedure");
            // API: status changes need the author; delete needs the author or treating dentist.
            const me = sessionPrincipal().userId;
            const canStatus = writable && canEditAuthored(p.performedBy, me);
            const canDelete = writable && canDeleteAuthored(p.performedBy, encounter, me);
            return (
              <li key={p.id} className="cw-item">
                <div className="cw-row">
                  <strong>{name}</strong>
                  <StatusBadge status={p.status} />
                </div>
                {p.serviceId && p.description ? <span>{p.description}</span> : null}
                <span className="cw-meta">
                  {toothLong(p.toothCode, p.surfaces)} · {personLabel(p.performedBy)} ·{" "}
                  {formatDateTime(p.performedAt)}
                  {p.planItemId ? " · linked to a plan item" : ""}
                </span>
                {p.notes ? <p className="cw-body">{p.notes}</p> : null}
                {canStatus || canDelete ? (
                  <div className="dos-cluster">
                    {canStatus && p.status === "IN_PROGRESS" ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void update.run(p, "COMPLETED")}
                        >
                          Mark completed<span className="dos-sr-only"> ({name})</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void update.run(p, "ABANDONED")}
                        >
                          Abandon<span className="dos-sr-only"> ({name})</span>
                        </Button>
                      </>
                    ) : null}
                    {canDelete ? (
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(p)}>
                        Remove<span className="dos-sr-only"> ({name})</span>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <ProcedureDialog
          encounter={encounter}
          services={services}
          defaultTooth={defaultTooth}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Remove this procedure?"
        description="The procedure is removed from this open encounter. A completed procedure that is the only progress on its plan item can't be removed."
        confirmLabel="Remove procedure"
        tone="danger"
        loading={remove.pending}
        onConfirm={() => deleting && void remove.run(deleting)}
      />
    </Section>
  );
}

function ProcedureDialog({
  encounter,
  services,
  defaultTooth,
  onClose,
  onDone,
}: {
  encounter: EncounterDetailResponse;
  services: ReturnType<typeof useServiceDirectory>;
  defaultTooth?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const linkable = useLinkablePlanItems(encounter.patientId, canDo("plan:read"));
  const [serviceId, setServiceId] = useState("");
  const [description, setDescription] = useState("");
  const [planItemId, setPlanItemId] = useState("");
  const [tooth, setTooth] = useState<number | undefined>(defaultTooth);
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [status, setStatus] = useState<"COMPLETED" | "IN_PROGRESS">("COMPLETED");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (b: Parameters<typeof clinicalApi.encounters.addProcedure>[1]) =>
      clinicalApi.encounters.addProcedure(encounter.id, b),
    {
      success: "Procedure recorded",
      onSuccess: onDone,
      onError: (e) => setErrors({ ...e.fieldErrors, _form: e.message }),
    },
  );
  const pickItem = (id: string) => {
    setPlanItemId(id);
    const item = linkable.find((i) => i.id === id);
    if (item) {
      setServiceId(item.serviceId);
      setTooth(item.toothCode ?? undefined);
      setSurfaces(item.surfaces);
    }
  };
  const submit = () => {
    const r = validate(createProcedureRequest, {
      serviceId,
      planItemId,
      description,
      toothCode: tooth,
      surfaces,
      status,
      notes,
    });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record procedure"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Record procedure
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        {canDo("plan:read") ? (
          <SelectField
            label="Treatment plan item"
            hint="Only accepted, scheduled or in-progress items of open plans can be linked."
            value={planItemId}
            error={errors.planItemId}
            onChange={(e) => pickItem(e.target.value)}
          >
            <option value="">Not part of a plan</option>
            {linkable.map((i) => (
              <option key={i.id} value={i.id}>
                {i.planTitle}: {services.label(i.serviceId)}
                {i.toothCode ? ` · ${toothShort(i.toothCode, i.surfaces)}` : ""} (
                {humanize(i.status)})
              </option>
            ))}
          </SelectField>
        ) : null}
        <SelectField
          label="Service"
          value={serviceId}
          error={errors.serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">Other (describe below)</option>
          {services.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Description"
          hint={serviceId ? undefined : "Required when no service is selected"}
          value={description}
          error={errors.description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <ToothSurfaceFields
          tooth={tooth}
          surfaces={surfaces}
          error={errors.toothCode}
          surfacesError={errors.surfaces}
          onChange={(t, s) => {
            setTooth(t);
            setSurfaces(s);
          }}
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as "COMPLETED" | "IN_PROGRESS")}
        >
          <option value="COMPLETED">Completed</option>
          <option value="IN_PROGRESS">In progress (multi-visit)</option>
        </SelectField>
        <TextareaField
          label="Notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {errors._form && !errors.planItemId && !errors.serviceId ? (
          <Alert tone="danger">{errors._form}</Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
