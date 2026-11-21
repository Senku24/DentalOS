"use client";
import {
  Alert,
  Button,
  type ColumnDef,
  ConfirmDialog,
  CursorPager,
  DataTable,
  SelectField,
  TextField,
  useLink,
} from "@dentalos/ui";
import { REFUND_STATUSES, type RefundResponse } from "@dentalos/validation";
import { useEffect, useState } from "react";
import {
  BillingSubnav,
  BranchFilter,
  Money,
  RefundStatusBadge,
} from "../../../components/billing/bits";
import {
  ProcessRefundDialog,
  RejectRefundDialog,
} from "../../../components/billing/refund-dialogs";
import {
  useBillingBranches,
  useBillingSettings,
  usePatientNames,
} from "../../../components/billing/use-billing";
import { MockNotice, RequirePermission } from "../../../components/common";
import { billingApi } from "../../../lib/api/billing";
import { methodLabel, refundNextSteps, refundStatusLabel } from "../../../lib/api/billing-rules";
import { errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { formatDateTime, formatPaise } from "../../../lib/format";
import { canDo, sessionPrincipal, userLabel } from "../../../lib/session";
import { useCursorPaging } from "../../../lib/use-cursor";

export function RefundsClient() {
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
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [status, branchId, from, to]);
  const { effective } = useBillingSettings(branchId || undefined);
  const me = sessionPrincipal().userId;

  const badRange = Boolean(from && to && to < from);
  const list = useQuery(
    () =>
      billingApi.refunds.list({
        status: (status || undefined) as RefundResponse["status"] | undefined,
        branchId: branchId || undefined,
        from: from || undefined,
        to: to || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [status, branchId, from, to, paging.cursor],
    !badRange,
  );
  const items = list.data?.items ?? [];
  const nameOf = usePatientNames(items.map((r) => r.patientId));

  const [approving, setApproving] = useState<RefundResponse | null>(null);
  const [rejecting, setRejecting] = useState<RefundResponse | null>(null);
  const [processing, setProcessing] = useState<RefundResponse | null>(null);
  const approve = useMutation((id: string) => billingApi.refunds.approve(id), {
    success: "Refund approved",
    onSuccess: () => {
      setApproving(null);
      list.reload();
    },
    onError: () => setApproving(null),
  });

  const columns: ColumnDef<RefundResponse, unknown>[] = [
    { header: "Requested", cell: ({ row: { original: r } }) => formatDateTime(r.requestedAt) },
    {
      header: "Patient",
      cell: ({ row: { original: r } }) => (
        <Link href={`/patients/${r.patientId}`}>{nameOf(r.patientId)}</Link>
      ),
    },
    {
      header: "Against",
      cell: ({ row: { original: r } }) => (
        <>
          <Link href={`/payments/${r.paymentId}`}>Payment</Link>
          {r.invoiceId ? (
            <>
              {" · "}
              <Link href={`/invoices/${r.invoiceId}`}>Invoice</Link>
            </>
          ) : (
            " · from advance"
          )}
        </>
      ),
    },
    { header: "Branch", cell: ({ row: { original: r } }) => branches.name(r.branchId) },
    {
      header: "Reason",
      cell: ({ row: { original: r } }) => (
        <>
          {r.reason}
          {r.rejectionReason ? <div className="dos-hint">Rejected: {r.rejectionReason}</div> : null}
          <div className="dos-hint">By {userLabel(r.requestedBy)}</div>
        </>
      ),
    },
    { header: "Method", cell: ({ row: { original: r } }) => methodLabel(r.method) },
    { header: "Amount", cell: ({ row: { original: r } }) => <Money paise={r.amountPaise} bold /> },
    {
      header: "Status",
      cell: ({ row: { original: r } }) => <RefundStatusBadge status={r.status} />,
    },
    {
      header: "Actions",
      cell: ({ row: { original: r } }) => {
        const n = refundNextSteps(r, me);
        const canApprove = canDo("refund:approve", { branchId: r.branchId });
        const canIssue = canDo("refund:issue", { branchId: r.branchId });
        return (
          <div className="bil-actions">
            {n.canApprove && canApprove ? (
              <Button size="sm" onClick={() => setApproving(r)}>
                Approve
              </Button>
            ) : null}
            {n.canReject && canApprove ? (
              <Button size="sm" variant="secondary" onClick={() => setRejecting(r)}>
                Reject
              </Button>
            ) : null}
            {n.canProcess && canIssue ? (
              <Button size="sm" onClick={() => setProcessing(r)}>
                Process
              </Button>
            ) : null}
            {n.waitsForGateway ? <span className="dos-hint">Waiting for the gateway</span> : null}
            {r.status === "REQUESTED" && !canApprove ? (
              <span className="dos-hint">Needs approval</span>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="dos-stack" data-gap="lg">
      <BillingSubnav />
      <MockNotice />
      {effective ? (
        <Alert tone="info">
          Refunds above {formatPaise(effective.refundApprovalThresholdPaise)} must be approved by{" "}
          {effective.separateApprover ? "a different person" : "someone"} with refund approval
          rights; smaller ones are approved automatically. Then process the refund once the money
          has been handed back. Refunds are requested from the invoice or payment they belong to.
        </Alert>
      ) : null}
      <div className="bil-filters">
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {REFUND_STATUSES.map((s) => (
            <option key={s} value={s}>
              {refundStatusLabel(s)}
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
      </div>
      <DataTable
        caption="Refunds"
        columns={columns}
        data={items}
        getRowId={(r) => r.id}
        loading={list.loading && !list.data}
        error={list.error ? errorStateFor(list.error) : undefined}
        searchable={false}
        hidePagination
        emptyTitle="No refunds"
        emptyDescription="Refunds appear here once requested from an invoice or a payment."
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
      <ConfirmDialog
        open={Boolean(approving)}
        onOpenChange={(o) => !o && setApproving(null)}
        title="Approve this refund?"
        description={
          approving
            ? `${formatPaise(approving.amountPaise)} to ${nameOf(approving.patientId)}. Reason given: ${approving.reason}.${
                approving.requestedBy === me && effective?.separateApprover
                  ? " You requested this refund, so the system will refuse your approval: ask a colleague."
                  : ""
              }`
            : ""
        }
        confirmLabel="Approve refund"
        loading={approve.pending}
        onConfirm={() => approving && void approve.run(approving.id)}
      />
      <RejectRefundDialog
        refund={rejecting}
        onClose={() => setRejecting(null)}
        onDone={list.reload}
      />
      <ProcessRefundDialog
        refund={processing}
        onClose={() => setProcessing(null)}
        onDone={list.reload}
      />
    </div>
  );
}
