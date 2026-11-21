"use client";
import {
  Alert,
  Button,
  type ColumnDef,
  ConfirmDialog,
  CursorPager,
  DataTable,
  PageHeader,
  SelectField,
  TextField,
  useLink,
} from "@dentalos/ui";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  type OutboxResponse,
  type PatientSummary,
} from "@dentalos/validation";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { MockNotice, RequirePermission } from "../../components/common";
import { OutboxDrawer } from "../../components/notifications/outbox-drawer";
import { DeliveryChip, OutboxStatusChip } from "../../components/notifications/status-chip";
import { usePatientNames } from "../../components/notifications/use-patient-names";
import { PatientPicker } from "../../components/scheduling/patient-picker";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { notificationsApi as nApi } from "../../lib/api/notifications";
import { channelLabel, purposeLabel, statusLabel } from "../../lib/api/notifications-labels";
import { patientName as fmtPatient, formatDateTime } from "../../lib/format";
import { canDo } from "../../lib/session";
import { useCursorPaging } from "../../lib/use-cursor";

export function NotificationsClient() {
  return (
    <RequirePermission permission="comms:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const Link = useLink();
  const mayAct = canDo("comms:send");
  const mayAdmin = canDo("comms:templates");
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<OutboxResponse | null>(null);
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [channel, status, patient?.id, from, to]);
  const rangeBad = Boolean(from && to && from > to);

  const list = useQuery(
    () =>
      nApi.outbox.list({
        channel: (channel || undefined) as never,
        status: (status || undefined) as never,
        patientId: patient?.id,
        from: from || undefined,
        to: to || undefined,
        cursor: paging.cursor,
      }),
    [channel, status, patient?.id, from, to, paging.cursor],
    !rangeBad,
  );
  const names = usePatientNames(list.data?.items.map((r) => r.patientId) ?? []);

  const retry = useMutation((r: OutboxResponse) => nApi.outbox.retry(r.id), {
    success: (r) =>
      r.status === "QUEUED" ? "Retry queued" : `Retry recorded: ${statusLabel(r.status)}`,
    onSuccess: list.reload,
  });
  const cancel = useMutation((r: OutboxResponse) => nApi.outbox.cancel(r.id), {
    success: "Message cancelled",
    onSuccess: () => {
      setCancelling(null);
      list.reload();
    },
    onError: () => {
      setCancelling(null);
      list.reload();
    },
  });

  const columns: ColumnDef<OutboxResponse, unknown>[] = [
    {
      accessorKey: "createdAt",
      header: "Queued",
      cell: ({ getValue }) => formatDateTime(getValue() as string),
    },
    {
      id: "patient",
      header: "Patient",
      cell: ({ row }) =>
        row.original.patientId ? (
          <Link href={`/patients/${row.original.patientId}`} className="dos-link">
            {names[row.original.patientId] ?? "Patient"}
          </Link>
        ) : (
          <span className="dos-muted">Test message</span>
        ),
    },
    {
      id: "to",
      header: "To",
      cell: ({ row }) => (
        <span>
          {channelLabel(row.original.channel)}{" "}
          <span className="dos-mono">{row.original.toAddressMasked}</span>
        </span>
      ),
    },
    {
      id: "template",
      header: "Message",
      cell: ({ row }) => (
        <div>
          <div className="dos-mono">{row.original.templateCode}</div>
          <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
            {purposeLabel(row.original.purpose)}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <div className="dos-cluster">
          <OutboxStatusChip status={row.original.status} />
          <DeliveryChip status={row.original.deliveryStatus} />
        </div>
      ),
    },
    { accessorKey: "attempts", header: "Attempts", cell: ({ getValue }) => String(getValue()) },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        const label = `${r.templateCode} to ${r.toAddressMasked}`;
        return (
          <div className="dos-cluster">
            <Button size="sm" variant="secondary" onClick={() => setSelected(r.id)}>
              Details<span className="dos-sr-only"> for {label}</span>
            </Button>
            {mayAct && r.status === "FAILED" ? (
              <Button size="sm" variant="ghost" onClick={() => void retry.run(r)}>
                Retry<span className="dos-sr-only"> {label}</span>
              </Button>
            ) : null}
            {mayAct && r.status === "QUEUED" ? (
              <Button size="sm" variant="ghost" onClick={() => setCancelling(r)}>
                Cancel<span className="dos-sr-only"> {label}</span>
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Messages"
        description="Every WhatsApp, SMS and email the system queued: what was sent, skipped or failed."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Messages" }]}
        actions={
          <>
            <Button variant="secondary" onClick={list.reload} loading={list.loading}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh
            </Button>
            {mayAdmin ? (
              <Link href="/admin/messaging" className="dos-link">
                Templates and settings
              </Link>
            ) : null}
          </>
        }
      />
      <div className="dos-stack">
        <MockNotice />
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form group */}
        <div className="dos-cluster" role="group" aria-label="Filter by status">
          <Button
            size="sm"
            variant={status === "" ? "primary" : "secondary"}
            aria-pressed={status === ""}
            onClick={() => setStatus("")}
          >
            All
          </Button>
          {NOTIFICATION_STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? "primary" : "secondary"}
              aria-pressed={status === s}
              onClick={() => setStatus(status === s ? "" : s)}
            >
              {statusLabel(s)}
            </Button>
          ))}
        </div>
        <search className="dos-toolbar" aria-label="Filter messages">
          <SelectField label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option>
            {NOTIFICATION_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {channelLabel(c)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="From"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            error={rangeBad ? "Must be on or after From" : undefined}
          />
          <div style={{ flex: "2 1 280px", minWidth: 240 }}>
            <PatientPicker label="Patient" value={patient} onChange={setPatient} />
          </div>
        </search>
        {patient ? <Alert tone="info">Showing messages for {fmtPatient(patient)}.</Alert> : null}
        <div>
          <DataTable
            caption="Messages"
            columns={columns}
            data={list.data?.items ?? []}
            getRowId={(r) => r.id}
            loading={list.loading}
            error={list.error ? errorStateFor(list.error) : undefined}
            searchable={false}
            hidePagination
            pageSize={100}
            emptyTitle="No messages match"
            emptyDescription="Messages appear here when appointments, invoices or recalls trigger them."
          />
          <CursorPager
            page={paging.page}
            hasPrev={paging.hasPrev}
            hasNext={Boolean(list.data?.nextCursor)}
            onPrev={paging.prev}
            onNext={() => paging.next(list.data?.nextCursor)}
            loading={list.loading}
            itemCount={list.data?.items.length}
          />
        </div>
      </div>
      <OutboxDrawer
        id={selected}
        onClose={() => setSelected(null)}
        onChanged={list.reload}
        onSelect={setSelected}
      />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel this message?"
        description="It will not be sent. You can retry it later as a new message."
        confirmLabel="Cancel message"
        tone="danger"
        loading={cancel.pending}
        onConfirm={() => cancelling && void cancel.run(cancelling)}
      />
    </>
  );
}
