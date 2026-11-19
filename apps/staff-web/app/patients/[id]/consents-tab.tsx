"use client";
import {
  Badge,
  Button,
  type ColumnDef,
  DataTable,
  Dialog,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  COMM_CHANNELS,
  COMM_PURPOSES,
  CONSENT_METHODS,
  type ConsentResponse,
  RECORDABLE_CONSENT_TYPES,
  recordConsentRequest,
  setCommunicationPreferencesRequest,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Loadable, Section } from "../../../components/common";
import { api } from "../../../lib/api/endpoints";
import { errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import type { CommunicationPreference } from "../../../lib/api/types";
import { formatDateTime, humanize } from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { canDo, userLabel } from "../../../lib/session";
import { useProfile } from "./profile-context";

export function ConsentsTab() {
  return (
    <div className="dos-stack" data-gap="lg">
      <ConsentsSection />
      <PreferencesSection />
    </div>
  );
}

function ConsentsSection() {
  const { patient, readOnly, onWriteError } = useProfile();
  const q = useQuery(() => api.patients.consents(patient.id), [patient.id]);
  const writable = canDo("consent:manage") && !readOnly;
  const [recording, setRecording] = useState(false);
  const [withdrawing, setWithdrawing] = useState<ConsentResponse | null>(null);

  const columns: ColumnDef<ConsentResponse, unknown>[] = [
    {
      accessorKey: "type",
      header: "Consent",
      cell: ({ getValue }) => humanize(getValue() as string),
    },
    { accessorKey: "version", header: "Form version" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue }) => {
        const s = getValue() as string;
        return (
          <Badge tone={s === "GRANTED" ? "success" : s === "WITHDRAWN" ? "warning" : "neutral"}>
            {humanize(s)}
          </Badge>
        );
      },
    },
    {
      accessorKey: "method",
      header: "Captured",
      cell: ({ getValue }) => humanize(getValue() as string | null),
    },
    {
      id: "when",
      header: "When",
      accessorFn: (c) => c.withdrawnAt ?? c.grantedAt ?? "",
      cell: ({ row }) =>
        row.original.withdrawnAt
          ? `Withdrawn ${formatDateTime(row.original.withdrawnAt)}`
          : formatDateTime(row.original.grantedAt),
    },
    { id: "by", header: "Recorded by", accessorFn: (c) => userLabel(c.capturedBy) },
    ...(writable
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: ConsentResponse } }) =>
              row.original.status === "GRANTED" ? (
                <Button size="sm" variant="ghost" onClick={() => setWithdrawing(row.original)}>
                  Withdraw
                  <span className="dos-sr-only"> {humanize(row.original.type)} consent</span>
                </Button>
              ) : null,
          } satisfies ColumnDef<ConsentResponse, unknown>,
        ]
      : []),
  ];

  return (
    <Section
      title="Consents"
      description="Consent is versioned and never deleted; withdrawing keeps the original grant on record."
      actions={
        writable ? (
          <Button size="sm" variant="secondary" onClick={() => setRecording(true)}>
            <Plus size={16} aria-hidden="true" /> Record consent
          </Button>
        ) : undefined
      }
    >
      <DataTable
        caption="Consents"
        columns={columns}
        data={q.data?.items ?? []}
        getRowId={(c) => c.id}
        loading={q.loading && !q.data}
        error={q.error ? errorStateFor(q.error) : undefined}
        searchable={false}
        emptyTitle="No consents recorded"
        emptyDescription="Record data-processing consent at registration."
      />
      {recording ? (
        <RecordDialog
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            q.reload();
          }}
          onError={onWriteError}
        />
      ) : null}
      {withdrawing ? (
        <WithdrawDialog
          consent={withdrawing}
          onClose={() => setWithdrawing(null)}
          onSaved={() => {
            setWithdrawing(null);
            q.reload();
          }}
        />
      ) : null}
    </Section>
  );
}

function RecordDialog({
  onClose,
  onSaved,
  onError,
}: {
  onClose: () => void;
  onSaved: () => void;
  onError: (e: import("../../../lib/api/errors").ApiError) => void;
}) {
  const { patient } = useProfile();
  const [v, setV] = useState({
    type: "DATA_PROCESSING",
    version: "2026-01",
    status: "GRANTED",
    method: "DIGITAL",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    (b: ReturnType<typeof recordConsentRequest.parse>) => api.patients.recordConsent(patient.id, b),
    { success: "Consent recorded", onSuccess: onSaved, onError },
  );
  const submit = () => {
    const r = validate(recordConsentRequest, v);
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record consent"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Record
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <SelectField
          label="Consent type"
          value={v.type}
          onChange={(e) => setV({ ...v, type: e.target.value })}
        >
          {RECORDABLE_CONSENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {humanize(t)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Form version"
          required
          hint="The version of the consent text the patient saw"
          value={v.version}
          onChange={(e) => setV({ ...v, version: e.target.value })}
          error={errors.version}
        />
        <SelectField
          label="Decision"
          value={v.status}
          onChange={(e) => setV({ ...v, status: e.target.value })}
        >
          <option value="GRANTED">Granted</option>
          <option value="DECLINED">Declined</option>
        </SelectField>
        <SelectField
          label="How it was captured"
          value={v.method}
          onChange={(e) => setV({ ...v, method: e.target.value })}
        >
          {CONSENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {humanize(m)}
            </option>
          ))}
        </SelectField>
      </div>
    </Dialog>
  );
}

function WithdrawDialog({
  consent,
  onClose,
  onSaved,
}: {
  consent: ConsentResponse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { patient, onWriteError } = useProfile();
  const [reason, setReason] = useState("");
  const save = useMutation(
    () => api.patients.withdrawConsent(patient.id, consent.id, reason.trim() || undefined),
    {
      success: "Consent withdrawn",
      onSuccess: onSaved,
      onError: onWriteError,
    },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Withdraw ${humanize(consent.type)} consent?`}
      description="Takes effect immediately. The original grant stays on record."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" loading={save.pending} onClick={() => void save.run()}>
            Withdraw consent
          </Button>
        </>
      }
    >
      <TextareaField
        label="Reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Dialog>
  );
}

type PrefKey = `${(typeof COMM_CHANNELS)[number]}:${(typeof COMM_PURPOSES)[number]}`;

function PreferencesSection() {
  const { patient, readOnly, onWriteError } = useProfile();
  const q = useQuery(() => api.patients.commPrefs(patient.id), [patient.id]);
  const writable = canDo("consent:manage") && !readOnly;
  const [state, setState] = useState<Record<PrefKey, boolean>>({} as Record<PrefKey, boolean>);
  useEffect(() => {
    if (!q.data) return;
    const next = {} as Record<PrefKey, boolean>;
    for (const p of q.data.items) next[`${p.channel}:${p.purpose}`] = p.optIn;
    setState(next);
  }, [q.data]);
  const save = useMutation(
    (b: { preferences: CommunicationPreference[] }) => api.patients.setCommPrefs(patient.id, b),
    { success: "Communication preferences saved", onSuccess: q.reload, onError: onWriteError },
  );
  const submit = () => {
    const preferences = COMM_CHANNELS.flatMap((channel) =>
      COMM_PURPOSES.map((purpose) => ({
        channel,
        purpose,
        optIn: state[`${channel}:${purpose}`] ?? false,
      })),
    );
    const r = validate(setCommunicationPreferencesRequest, { preferences });
    if (r.ok) void save.run(r.data);
  };
  return (
    <Section
      title="Communication preferences"
      description="Marketing messages are only sent where the patient opted in. Transactional messages (e.g. receipts) may still be sent."
    >
      <Loadable state={q} rows={3}>
        {() => (
          <div className="dos-stack">
            <div className="dos-table-scroll">
              <table className="dos-table">
                <caption className="dos-sr-only">Opt-in by channel and purpose</caption>
                <thead>
                  <tr>
                    <th scope="col">Channel</th>
                    {COMM_PURPOSES.map((p) => (
                      <th key={p} scope="col">
                        {humanize(p)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMM_CHANNELS.map((c) => (
                    <tr key={c}>
                      <th scope="row">{c === "SMS" ? "SMS" : humanize(c)}</th>
                      {COMM_PURPOSES.map((p) => {
                        const key = `${c}:${p}` as PrefKey;
                        return (
                          <td key={p}>
                            <input
                              type="checkbox"
                              className="dos-check__input"
                              aria-label={`${humanize(c)} ${humanize(p).toLowerCase()} messages`}
                              checked={state[key] ?? false}
                              disabled={!writable}
                              onChange={(e) => setState({ ...state, [key]: e.target.checked })}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {writable ? (
              <div>
                <Button variant="secondary" loading={save.pending} onClick={submit}>
                  Save preferences
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </Loadable>
    </Section>
  );
}
