"use client";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type EncounterDetailResponse,
  TOOTH_CONDITIONS,
  type ToothRecordResponse,
  type ToothSurface,
  chartTeethRequest,
  toothName,
  validSurfaces,
} from "@dentalos/validation";
import { useMemo, useState } from "react";
import { clinicalApi } from "../../lib/api/clinical";
import { chartAsOf, splitChart } from "../../lib/api/clinical-chart";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { formatDateTime } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import { canDo } from "../../lib/session";
import { Loadable, Section } from "../common";
import { personLabel } from "./bits";
import {
  FDI,
  Odontogram,
  type OdontogramDentition,
  conditionLabel,
  isToothLevel,
  surfaceName,
  toothLabel,
  toothShort,
} from "./fdi";

/**
 * Odontogram tab: the patient's current chart (or with history), tooth selection and charting into
 * the OPEN encounter. History is preserved server-side: a change charts a new record that
 * supersedes the old one; "charted in error" retires a record without a replacement.
 */
export function ChartPanel({
  patientId,
  encounter,
  onChanged,
}: {
  patientId: string;
  encounter: EncounterDetailResponse | undefined;
  onChanged: () => void;
}) {
  const [history, setHistory] = useState(false);
  // A signed encounter shows the chart as it stood when it was signed (later charting excluded);
  // the user can switch to today's chart, which is then labelled as such.
  const [showToday, setShowToday] = useState(false);
  const signed = encounter?.status === "SIGNED" ? encounter : undefined;
  const asOf = chartAsOf(encounter, showToday);
  const chart = useQuery(
    () => clinicalApi.odontogram.get(patientId, { includeHistory: history, asOf }),
    [patientId, history, asOf],
  );
  const [selected, setSelected] = useState<number[]>([]);
  const [dentition, setDentition] = useState<OdontogramDentition | undefined>(undefined);
  const [surfaces, setSurfaces] = useState<string[]>([]);

  const open = encounter?.status === "OPEN";
  const writable = open && encounter && canDo("clinical:write", { branchId: encounter.branchId });
  const records = chart.data?.records;
  const { current, past } = useMemo(() => splitChart(records ?? [], asOf), [records, asOf]);
  const autoDentition: OdontogramDentition =
    current.length > 0 && current.every((r) => r.toothCode >= 50) ? "PRIMARY" : "PERMANENT";
  const single = selected.length === 1 ? selected[0] : undefined;

  const select = (teeth: number[]) => {
    setSelected(teeth);
    if (teeth.length !== 1) setSurfaces([]);
    else if (teeth[0] !== single) setSurfaces([]);
  };

  const toggleSurface = (tooth: number, surface: string) => {
    if (!writable) return;
    if (single !== tooth) {
      setSelected([tooth]);
      setSurfaces([surface]);
      return;
    }
    const valid = validSurfaces(tooth);
    setSurfaces((s) =>
      s.includes(surface)
        ? s.filter((x) => x !== surface)
        : valid.filter((v) => v === surface || s.includes(v)),
    );
  };

  return (
    <Section
      title="Odontogram"
      description={
        open
          ? "Select teeth to chart findings into this open encounter. Arrow keys move between teeth; Enter selects; Shift+Enter adds to the selection."
          : signed
            ? asOf
              ? `Read-only: the chart as it stood when this encounter was signed (${formatDateTime(signed.signedAt)}). Later findings are not shown.`
              : "Read-only: today's current chart, including findings charted after this encounter was signed."
            : "Read-only. Open an encounter to chart findings."
      }
      actions={
        signed ? (
          <Checkbox
            label="Show today's chart"
            checked={showToday}
            onChange={(e) => setShowToday(e.target.checked)}
          />
        ) : undefined
      }
    >
      <Loadable state={chart} rows={6}>
        {() => (
          <div className="cw-chart-host">
            <div className="cw-chart">
              <div className="dos-stack" style={{ minWidth: 0 }}>
                <Odontogram
                  fdi={FDI}
                  records={current}
                  dentition={dentition ?? autoDentition}
                  onDentitionChange={(d) => {
                    setDentition(d);
                    select([]);
                  }}
                  selected={selected}
                  onSelectionChange={select}
                  onSurfaceClick={writable ? toggleSurface : undefined}
                  pendingSurfaces={
                    single !== undefined && surfaces.length ? { [single]: surfaces } : undefined
                  }
                  label={asOf ? "Patient odontogram as at signing" : "Patient odontogram"}
                  legend="present"
                  toolbar={
                    <Checkbox
                      label="Show history"
                      checked={history}
                      onChange={(e) => setHistory(e.target.checked)}
                    />
                  }
                />
                {history ? <HistoryTable rows={past} /> : null}
              </div>
              <div className="cw-chart__side">
                <SelectedTeeth
                  patientId={patientId}
                  teeth={selected}
                  records={current}
                  encounterId={writable ? encounter?.id : undefined}
                  onChanged={() => {
                    chart.reload();
                    onChanged();
                  }}
                />
                {writable && encounter ? (
                  <ChartForm
                    patientId={patientId}
                    encounterId={encounter.id}
                    teeth={selected}
                    surfaces={surfaces}
                    onSurfaces={setSurfaces}
                    current={current}
                    onCharted={() => {
                      select([]);
                      chart.reload();
                      onChanged();
                    }}
                  />
                ) : null}
              </div>
            </div>
          </div>
        )}
      </Loadable>
    </Section>
  );
}

function SelectedTeeth({
  patientId,
  teeth,
  records,
  encounterId,
  onChanged,
}: {
  patientId: string;
  teeth: number[];
  records: ToothRecordResponse[];
  encounterId: string | undefined;
  onChanged: () => void;
}) {
  const [retiring, setRetiring] = useState<ToothRecordResponse | null>(null);
  if (teeth.length === 0)
    return (
      <p className="dos-muted" style={{ margin: 0 }}>
        No tooth selected.
      </p>
    );
  return (
    <div className="dos-stack" data-gap="sm" aria-live="polite">
      <h3 style={{ fontSize: "var(--text-md)", margin: 0 }}>
        {teeth.length === 1 ? toothLabel(teeth[0] ?? 0) : `${teeth.length} teeth selected`}
      </h3>
      {teeth.map((t) => {
        const rows = records.filter((r) => r.toothCode === t);
        return (
          <div key={t} className="dos-stack" data-gap="sm">
            {teeth.length > 1 ? (
              <strong style={{ fontSize: "var(--text-sm)" }}>{toothLabel(t)}</strong>
            ) : null}
            {rows.length === 0 ? (
              <span className="cw-meta">No findings charted.</span>
            ) : (
              <ul className="cw-list">
                {rows.map((r) => (
                  <li key={r.id} className="cw-item">
                    <strong>
                      {conditionLabel(r.condition)}
                      {r.surfaces.length
                        ? ` · ${r.surfaces.map(surfaceName).join(", ")}`
                        : " · whole tooth"}
                    </strong>
                    {r.notes ? <span>{r.notes}</span> : null}
                    <span className="cw-meta">
                      {formatDateTime(r.recordedAt)} · {personLabel(r.recordedBy)}
                    </span>
                    {encounterId ? (
                      <div>
                        <Button size="sm" variant="ghost" onClick={() => setRetiring(r)}>
                          Charted in error
                          <span className="dos-sr-only">
                            {" "}
                            ({conditionLabel(r.condition)} on tooth {r.toothCode})
                          </span>
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {retiring && encounterId ? (
        <RetireDialog
          patientId={patientId}
          encounterId={encounterId}
          record={retiring}
          onClose={() => setRetiring(null)}
          onDone={() => {
            setRetiring(null);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function ChartForm({
  patientId,
  encounterId,
  teeth,
  surfaces,
  onSurfaces,
  current,
  onCharted,
}: {
  patientId: string;
  encounterId: string;
  teeth: number[];
  surfaces: string[];
  onSurfaces: (s: string[]) => void;
  current: ToothRecordResponse[];
  onCharted: () => void;
}) {
  const [condition, setCondition] = useState<string>("CARIES");
  const [notes, setNotes] = useState("");
  const [supersedesId, setSupersedesId] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const single = teeth.length === 1 ? teeth[0] : undefined;
  const toothLevel = isToothLevel(condition);
  const replaceable = single === undefined ? [] : current.filter((r) => r.toothCode === single);

  const save = useMutation(
    (body: Parameters<typeof clinicalApi.odontogram.chart>[1]) =>
      clinicalApi.odontogram.chart(patientId, body),
    {
      success: (r) => `Charted ${r.items.length} finding${r.items.length === 1 ? "" : "s"}`,
      onSuccess: () => {
        setNotes("");
        setSupersedesId("");
        setErrors({});
        onCharted();
      },
      onError: (e) => setErrors({ ...flatten(e.fieldErrors), _form: e.message }),
    },
  );

  const submit = () => {
    if (teeth.length === 0) return setErrors({ _form: "Select at least one tooth on the chart." });
    const r = validate(chartTeethRequest, {
      encounterId,
      records: teeth.map((t) => ({
        toothCode: t,
        condition,
        surfaces: toothLevel || t !== single ? [] : surfaces,
        notes,
        supersedesId: t === single ? supersedesId : undefined,
      })),
    });
    if (!r.ok) return setErrors(flatten(r.errors));
    void save.run(r.data);
  };

  return (
    <form
      className="dos-stack cw-item"
      aria-label="Chart finding"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3 style={{ fontSize: "var(--text-md)", margin: 0 }}>Chart finding</h3>
      <SelectField
        label="Condition"
        value={condition}
        onChange={(e) => setCondition(e.target.value)}
      >
        {TOOTH_CONDITIONS.map((c) => (
          <option key={c} value={c}>
            {conditionLabel(c)}
            {isToothLevel(c) ? " (whole tooth)" : ""}
          </option>
        ))}
      </SelectField>
      {single !== undefined && !toothLevel ? (
        <fieldset className="cw-surfaces">
          <legend>Surfaces of {single} (none = whole tooth)</legend>
          {validSurfaces(single).map((s) => (
            <Checkbox
              key={s}
              label={`${s} · ${surfaceName(s)}`}
              checked={surfaces.includes(s)}
              onChange={(e) =>
                onSurfaces(
                  e.target.checked
                    ? validSurfaces(single).filter(
                        (v) => v === s || surfaces.includes(v as ToothSurface),
                      )
                    : surfaces.filter((v) => v !== s),
                )
              }
            />
          ))}
        </fieldset>
      ) : teeth.length > 1 && !toothLevel ? (
        <p className="cw-meta" style={{ margin: 0 }}>
          Surfaces can be picked when one tooth is selected; this charts the whole tooth on each.
        </p>
      ) : null}
      {errors.surfaces ? <div className="dos-error">{errors.surfaces}</div> : null}
      {replaceable.length ? (
        <SelectField
          label="Replaces"
          hint="The replaced entry stays in the chart history."
          value={supersedesId}
          onChange={(e) => setSupersedesId(e.target.value)}
        >
          <option value="">Nothing (add a new finding)</option>
          {replaceable.map((r) => (
            <option key={r.id} value={r.id}>
              {conditionLabel(r.condition)} {toothShort(r.toothCode, r.surfaces)}
            </option>
          ))}
        </SelectField>
      ) : null}
      <TextField
        label="Notes"
        value={notes}
        error={errors.notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {errors._form ? <Alert tone="danger">{errors._form}</Alert> : null}
      <div>
        <Button type="submit" loading={save.pending} disabled={teeth.length === 0}>
          {teeth.length > 1 ? `Chart on ${teeth.length} teeth` : "Chart finding"}
        </Button>
      </div>
    </form>
  );
}

/** "records.0.surfaces" → "surfaces" so per-record errors land on the single form. */
function flatten(errors: FieldErrors): FieldErrors {
  const out: FieldErrors = {};
  for (const [k, v] of Object.entries(errors)) {
    const key = k.replace(/^records\.\d+\./, "");
    if (!(key in out)) out[key] = v;
  }
  return out;
}

function RetireDialog({
  patientId,
  encounterId,
  record,
  onClose,
  onDone,
}: {
  patientId: string;
  encounterId: string;
  record: ToothRecordResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const save = useMutation(
    () =>
      clinicalApi.odontogram.supersede(patientId, {
        recordIds: [record.id],
        encounterId,
        reason: reason.trim() || undefined,
      }),
    { success: "Chart entry retired", onSuccess: onDone },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Retire ${conditionLabel(record.condition)} on ${record.toothCode}?`}
      description={`${toothName(record.toothCode)}: the entry leaves the current chart but stays in its history with your name and the time.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" loading={save.pending} onClick={() => void save.run()}>
            Retire entry
          </Button>
        </>
      }
    >
      <TextareaField
        label="Reason"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Dialog>
  );
}

function HistoryTable({ rows }: { rows: ToothRecordResponse[] }) {
  if (rows.length === 0)
    return (
      <p className="cw-meta" style={{ margin: 0 }}>
        No earlier chart entries.
      </p>
    );
  return (
    <div className="cw-table-wrap">
      <table className="cw-table">
        <caption className="dos-sr-only">Chart history (replaced or retired entries)</caption>
        <thead>
          <tr>
            <th scope="col">Tooth</th>
            <th scope="col">Finding</th>
            <th scope="col">Charted</th>
            <th scope="col">Replaced</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{toothShort(r.toothCode, r.surfaces)}</td>
              <td>
                {conditionLabel(r.condition)}
                {r.notes ? <div className="cw-meta">{r.notes}</div> : null}
              </td>
              <td>
                {formatDateTime(r.recordedAt)}
                <div className="cw-meta">{personLabel(r.recordedBy)}</div>
              </td>
              <td>
                {formatDateTime(r.supersededAt)}
                <div className="cw-meta">{personLabel(r.supersededBy)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
