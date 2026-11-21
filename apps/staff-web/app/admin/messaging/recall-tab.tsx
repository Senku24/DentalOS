"use client";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Dialog,
  SelectField,
  TextField,
} from "@dentalos/ui";
import { type RecallSettingResponse, upsertRecallSettingRequest } from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Section } from "../../../components/common";
import { collectPages } from "../../../lib/api/clinical-client";
import { api } from "../../../lib/api/endpoints";
import { type ApiError, errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { notificationsApi as nApi } from "../../../lib/api/notifications";
import { formatDate } from "../../../lib/format";
import { type FieldErrors, validate } from "../../../lib/forms";

const approx = (days: number) =>
  days % 365 === 0
    ? `${days / 365} year${days === 365 ? "" : "s"}`
    : days % 30 === 0
      ? `${days / 30} months`
      : days >= 60
        ? `about ${Math.round(days / 30)} months`
        : `${days} days`;

/** Per-service recall intervals (never deleted: switch off instead) and an on-demand recall sweep. */
export function RecallTab() {
  const list = useQuery(
    () => collectPages((cursor) => nApi.recall.list({ cursor, limit: 100 })),
    [],
  );
  const services = useQuery(
    () => collectPages((cursor) => api.catalog.services({ cursor, limit: 100 })),
    [],
  );
  const [editing, setEditing] = useState<RecallSettingResponse | "new" | null>(null);
  const [sweepAsk, setSweepAsk] = useState(false);

  const toggle = useMutation(
    (r: RecallSettingResponse) =>
      nApi.recall.upsert({
        serviceId: r.serviceId,
        intervalDays: r.intervalDays,
        active: !r.active,
      }),
    {
      success: (r) => (r.active ? "Recall switched on" : "Recall switched off"),
      onSuccess: list.reload,
    },
  );
  const sweep = useMutation(() => nApi.recall.sweep(), {
    success: (r) =>
      r.queued ? "Recall sweep queued" : "A recall sweep is already waiting; no new one was queued",
    onSuccess: () => setSweepAsk(false),
    onError: () => setSweepAsk(false),
  });

  const columns: ColumnDef<RecallSettingResponse, unknown>[] = [
    {
      id: "service",
      header: "Service",
      accessorFn: (r) => r.serviceName ?? "Service",
    },
    {
      accessorKey: "intervalDays",
      header: "Recall after",
      cell: ({ row }) => (
        <span className="dos-num">
          {row.original.intervalDays} days{" "}
          <span className="dos-muted">({approx(row.original.intervalDays)})</span>
        </span>
      ),
    },
    {
      accessorKey: "active",
      header: "Status",
      cell: ({ getValue }) =>
        getValue() ? <Badge tone="success">On</Badge> : <Badge tone="neutral">Off</Badge>,
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      cell: ({ getValue }) => formatDate(getValue() as string),
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="dos-cluster">
          <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>
            Edit<span className="dos-sr-only"> {row.original.serviceName}</span>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void toggle.run(row.original)}>
            {row.original.active ? "Switch off" : "Switch on"}
            <span className="dos-sr-only"> {row.original.serviceName}</span>
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="dos-stack">
      <Section
        title="Recall intervals"
        description="After a patient completes a procedure of one of these services, a recall reminder is sent when the interval (less the lead days in Settings) has passed."
        actions={
          <>
            <Button variant="secondary" onClick={() => setSweepAsk(true)}>
              Run recall sweep now
            </Button>
            <Button onClick={() => setEditing("new")}>
              <Plus size={16} aria-hidden="true" /> Add interval
            </Button>
          </>
        }
      >
        <DataTable
          caption="Recall intervals by service"
          columns={columns}
          data={list.data ?? []}
          getRowId={(r) => r.id}
          loading={list.loading}
          error={list.error ? errorStateFor(list.error) : undefined}
          pageSize={50}
          searchable={false}
          hidePagination
          emptyTitle="No recall intervals"
          emptyDescription="Add one, for example 180 days for scaling and polishing."
        />
      </Section>
      <RecallDialog
        target={editing}
        existing={list.data ?? []}
        services={services.data ?? []}
        servicesLoading={services.loading}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          list.reload();
        }}
      />
      <ConfirmDialog
        open={sweepAsk}
        onOpenChange={setSweepAsk}
        title="Run the recall sweep now?"
        description="It looks for patients whose recall is due and queues reminders (consent and quiet hours still apply). The sweep also runs automatically every day."
        confirmLabel="Run sweep"
        loading={sweep.pending}
        onConfirm={() => void sweep.run()}
      />
    </div>
  );
}

function RecallDialog({
  target,
  existing,
  services,
  servicesLoading,
  onClose,
  onSaved,
}: {
  target: RecallSettingResponse | "new" | null;
  existing: RecallSettingResponse[];
  services: { id: string; name: string; active: boolean }[];
  servicesLoading: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const edit = target && target !== "new" ? target : null;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      title={edit ? `Recall: ${edit.serviceName ?? "service"}` : "Add recall interval"}
      description="One interval per service."
    >
      {target ? (
        <RecallForm
          key={edit?.id ?? "new"}
          edit={edit}
          existing={existing}
          services={services}
          servicesLoading={servicesLoading}
          onClose={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </Dialog>
  );
}

function RecallForm({
  edit,
  existing,
  services,
  servicesLoading,
  onClose,
  onSaved,
}: {
  edit: RecallSettingResponse | null;
  existing: RecallSettingResponse[];
  services: { id: string; name: string; active: boolean }[];
  servicesLoading: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [serviceId, setServiceId] = useState(edit?.serviceId ?? "");
  const [days, setDays] = useState(edit ? String(edit.intervalDays) : "180");
  const [active, setActive] = useState(edit?.active ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const taken = new Set(existing.map((r) => r.serviceId));
  const options = services.filter((s) => s.active && !taken.has(s.id));

  const save = useMutation(nApi.recall.upsert, {
    success: edit ? "Recall interval saved" : "Recall interval added",
    onSuccess: onSaved,
    onError: (e: ApiError) => {
      if (Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
      else if (e.code === "service_not_found") setErrors({ serviceId: e.message });
      else setFormError(e.message);
    },
  });

  return (
    <form
      className="dos-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setFormError(null);
        const r = validate(upsertRecallSettingRequest, {
          serviceId,
          intervalDays: days.trim() === "" ? undefined : Number(days),
          active,
        });
        if (!r.ok) return setErrors(r.errors);
        setErrors({});
        void save.run(r.data);
      }}
    >
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      {edit ? (
        <TextField label="Service" value={edit.serviceName ?? ""} readOnly disabled />
      ) : (
        <SelectField
          label="Service"
          required
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          error={errors.serviceId}
          disabled={servicesLoading}
          hint={
            servicesLoading
              ? "Loading services"
              : options.length === 0
                ? "Every active service already has an interval."
                : undefined
          }
        >
          <option value="">Select a service</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        label="Recall after (days)"
        required
        type="number"
        inputMode="numeric"
        min={1}
        max={3650}
        value={days}
        onChange={(e) => {
          setDays(e.target.value);
          setErrors((x) => ({ ...x, intervalDays: "" }));
        }}
        error={errors.intervalDays || undefined}
        hint="Days after a completed procedure of this service, 1 to 3650."
      />
      <Checkbox
        label="Send recall reminders for this service"
        checked={active}
        onChange={(e) => setActive(e.target.checked)}
      />
      <div className="dos-cluster" style={{ justifyContent: "flex-end" }}>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={save.pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
