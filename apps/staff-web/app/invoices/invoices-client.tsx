"use client";
import {
  Checkbox,
  type ColumnDef,
  CursorPager,
  DataTable,
  SelectField,
  TextField,
  useLink,
} from "@dentalos/ui";
import { INVOICE_STATUSES, type InvoiceSummary } from "@dentalos/validation";
import type { PatientSummary } from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import {
  BillingSubnav,
  BranchFilter,
  InvoiceStatusBadge,
  LinkButton,
  Money,
} from "../../components/billing/bits";
import { useBillingBranches } from "../../components/billing/use-billing";
import { MockNotice, RequirePermission } from "../../components/common";
import { PatientPicker } from "../../components/scheduling/patient-picker";
import { billingApi } from "../../lib/api/billing";
import { invoiceStatusLabel } from "../../lib/api/billing-rules";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { formatDate, todayISO } from "../../lib/format";
import { canDo } from "../../lib/session";
import { useCursorPaging, useDebounced } from "../../lib/use-cursor";

export function InvoicesClient() {
  return (
    <RequirePermission permission="billing:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const Link = useLink();
  const branches = useBillingBranches();
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [number, setNumber] = useState("");
  const [overdue, setOverdue] = useState(false);
  const dnumber = useDebounced(number.trim());
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [status, branchId, patient?.id, from, to, dnumber, overdue]);

  const badRange = Boolean(from && to && to < from);
  const list = useQuery(
    () =>
      billingApi.invoices.list({
        status: (status || undefined) as InvoiceSummary["status"] | undefined,
        branchId: branchId || undefined,
        patientId: patient?.id,
        from: from || undefined,
        to: to || undefined,
        q: dnumber || undefined,
        overdue: overdue || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [status, branchId, patient?.id, from, to, dnumber, overdue, paging.cursor],
    !badRange,
  );

  const columns: ColumnDef<InvoiceSummary, unknown>[] = [
    {
      header: "Invoice",
      cell: ({ row: { original: i } }) => (
        <Link href={`/invoices/${i.id}`}>{i.number ?? "Draft (no number yet)"}</Link>
      ),
    },
    {
      header: "Patient",
      cell: ({ row: { original: i } }) => (
        <Link href={`/patients/${i.patientId}`}>{i.patientName ?? "Patient"}</Link>
      ),
    },
    { header: "Branch", cell: ({ row: { original: i } }) => branches.name(i.branchId) },
    {
      header: "Date",
      cell: ({ row: { original: i } }) => formatDate(i.issuedAt ?? i.createdAt),
    },
    {
      header: "Due",
      cell: ({ row: { original: i } }) =>
        i.dueDate && i.balancePaise > 0 && i.dueDate < todayISO() ? (
          <strong>{formatDate(i.dueDate)} (overdue)</strong>
        ) : (
          formatDate(i.dueDate)
        ),
    },
    {
      header: "Total",
      cell: ({ row: { original: i } }) => <Money paise={i.totalPaise + i.adjustmentPaise} />,
    },
    { header: "Paid", cell: ({ row: { original: i } }) => <Money paise={i.paidPaise} /> },
    {
      header: "Balance",
      cell: ({ row: { original: i } }) => <Money paise={i.balancePaise} bold />,
    },
    {
      header: "Status",
      cell: ({ row: { original: i } }) => <InvoiceStatusBadge status={i.status} />,
    },
  ];

  return (
    <div className="dos-stack" data-gap="lg">
      <BillingSubnav />
      <MockNotice />
      <div className="bil-filters">
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {invoiceStatusLabel(s)}
            </option>
          ))}
        </SelectField>
        <BranchFilter branches={branches.scoped} value={branchId} onChange={setBranchId} />
        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          error={badRange ? "Before the start date" : undefined}
        />
        <TextField
          label="Invoice number"
          type="search"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          hint="Starts with, e.g. SKT/26-27"
        />
        <Checkbox
          label="Overdue only"
          checked={overdue}
          onChange={(e) => setOverdue(e.target.checked)}
        />
      </div>
      <PatientPicker value={patient} onChange={setPatient} label="Filter by patient" />
      <DataTable
        caption="Invoices"
        columns={columns}
        data={list.data?.items ?? []}
        getRowId={(i) => i.id}
        loading={list.loading && !list.data}
        error={list.error ? errorStateFor(list.error) : undefined}
        searchable={false}
        hidePagination
        emptyTitle="No invoices found"
        emptyDescription="Change the filters, or create an invoice."
        toolbarActions={
          canDo("invoice:write") ? (
            <LinkButton href="/invoices/new" variant="primary">
              <Plus size={16} aria-hidden="true" /> New invoice
            </LinkButton>
          ) : undefined
        }
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
  );
}
