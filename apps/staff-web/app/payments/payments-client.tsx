"use client";
import {
  Button,
  Checkbox,
  type ColumnDef,
  CursorPager,
  DataTable,
  SelectField,
  TextField,
  useLink,
} from "@dentalos/ui";
import {
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type PatientSummary,
  type PaymentResponse,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BillingSubnav,
  BranchFilter,
  Money,
  PaymentStatusBadge,
} from "../../components/billing/bits";
import { PaymentDrawer } from "../../components/billing/payment-drawer";
import { useBillingBranches, usePatientNames } from "../../components/billing/use-billing";
import { MockNotice, RequirePermission } from "../../components/common";
import { PatientPicker } from "../../components/scheduling/patient-picker";
import { billingApi } from "../../lib/api/billing";
import { methodLabel, paymentStatusLabel } from "../../lib/api/billing-rules";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { formatDateTime } from "../../lib/format";
import { canDo } from "../../lib/session";
import { useCursorPaging } from "../../lib/use-cursor";

export function PaymentsClient() {
  return (
    <RequirePermission permission="billing:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const Link = useLink();
  const router = useRouter();
  const branches = useBillingBranches();
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("");
  const [branchId, setBranchId] = useState("");
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [advanceOnly, setAdvanceOnly] = useState(false);
  const [recording, setRecording] = useState(false);
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [method, status, branchId, patient?.id, from, to, advanceOnly]);

  const badRange = Boolean(from && to && to < from);
  const list = useQuery(
    () =>
      billingApi.payments.list({
        method: (method || undefined) as PaymentResponse["method"] | undefined,
        status: (status || undefined) as PaymentResponse["status"] | undefined,
        branchId: branchId || undefined,
        patientId: patient?.id,
        from: from || undefined,
        to: to || undefined,
        hasAdvance: advanceOnly || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [method, status, branchId, patient?.id, from, to, advanceOnly, paging.cursor],
    !badRange,
  );
  const items = list.data?.items ?? [];
  const nameOf = usePatientNames(items.map((p) => p.patientId));

  const columns: ColumnDef<PaymentResponse, unknown>[] = [
    {
      header: "Receipt",
      cell: ({ row: { original: p } }) => (
        <Link href={`/payments/${p.id}`}>{p.receiptNumber ?? "Awaiting gateway"}</Link>
      ),
    },
    { header: "Received", cell: ({ row: { original: p } }) => formatDateTime(p.receivedAt) },
    {
      header: "Patient",
      cell: ({ row: { original: p } }) => (
        <Link href={`/patients/${p.patientId}`}>{nameOf(p.patientId)}</Link>
      ),
    },
    { header: "Branch", cell: ({ row: { original: p } }) => branches.name(p.branchId) },
    {
      header: "Method",
      cell: ({ row: { original: p } }) =>
        `${methodLabel(p.method)}${p.gateway !== "MANUAL" ? ` (${p.gateway.toLowerCase()})` : ""}`,
    },
    { header: "Amount", cell: ({ row: { original: p } }) => <Money paise={p.amountPaise} bold /> },
    { header: "Applied", cell: ({ row: { original: p } }) => <Money paise={p.allocatedPaise} /> },
    {
      header: "Advance held",
      cell: ({ row: { original: p } }) => (
        <Money paise={p.status === "RECORDED" ? p.unallocatedPaise : 0} />
      ),
    },
    {
      header: "Status",
      cell: ({ row: { original: p } }) => <PaymentStatusBadge status={p.status} />,
    },
  ];

  return (
    <div className="dos-stack" data-gap="lg">
      <BillingSubnav />
      <MockNotice />
      <div className="bil-filters">
        <BranchFilter branches={branches.scoped} value={branchId} onChange={setBranchId} />
        <SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">All methods</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {methodLabel(m)}
            </option>
          ))}
        </SelectField>
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {paymentStatusLabel(s)}
            </option>
          ))}
        </SelectField>
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
        <Checkbox
          label="Holding advance"
          checked={advanceOnly}
          onChange={(e) => setAdvanceOnly(e.target.checked)}
        />
      </div>
      <PatientPicker value={patient} onChange={setPatient} label="Filter by patient" />
      <DataTable
        caption="Payments"
        columns={columns}
        data={items}
        getRowId={(p) => p.id}
        loading={list.loading && !list.data}
        error={list.error ? errorStateFor(list.error) : undefined}
        searchable={false}
        hidePagination
        emptyTitle="No payments found"
        emptyDescription="Change the filters, or record a payment."
        toolbarActions={
          canDo("payment:record") ? (
            <Button onClick={() => setRecording(true)}>
              <Plus size={16} aria-hidden="true" /> Record payment
            </Button>
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
        itemCount={items.length}
      />
      <PaymentDrawer
        open={recording}
        onOpenChange={setRecording}
        patient={patient}
        onRecorded={(p) => router.push(`/payments/${p.id}`)}
      />
    </div>
  );
}
