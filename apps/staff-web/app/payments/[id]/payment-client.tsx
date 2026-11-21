"use client";
import { Alert, Breadcrumbs, Button, ErrorState, Skeleton, useLink } from "@dentalos/ui";
import { Dialog } from "@dentalos/ui";
import type { PaymentDetailResponse } from "@dentalos/validation";
import { Printer } from "lucide-react";
import { useState } from "react";
import { PaymentStatusBadge } from "../../../components/billing/bits";
import {
  AllocationList,
  parsePicks,
  useOutstandingInvoices,
} from "../../../components/billing/payment-drawer";
import { ReceiptSheet } from "../../../components/billing/print-sheets";
import { RefundRequestDialog } from "../../../components/billing/refund-dialogs";
import { RefundMiniTable } from "../../../components/billing/refund-table";
import {
  useBillingBranches,
  useKeyer,
  usePatientNames,
} from "../../../components/billing/use-billing";
import { MockNotice, RequirePermission, Section } from "../../../components/common";
import { billingApi } from "../../../lib/api/billing";
import { type ApiError, errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { formatDateTime, formatPaise } from "../../../lib/format";
import { canDo } from "../../../lib/session";

export function PaymentPage({ id }: { id: string }) {
  return (
    <RequirePermission permission="billing:read">
      <Inner id={id} />
    </RequirePermission>
  );
}

function Inner({ id }: { id: string }) {
  const Link = useLink();
  const pay = useQuery(() => billingApi.payments.get(id), [id]);
  const p = pay.data;
  const branches = useBillingBranches();
  const nameOf = usePatientNames(p ? [p.patientId] : []);
  const invoiceIds = p ? [...new Set(p.allocations.map((a) => a.invoiceId))].sort().join(",") : "";
  const invoices = useQuery(
    async () => {
      const rows = await Promise.all(
        invoiceIds
          .split(",")
          .filter(Boolean)
          .map((i) => billingApi.invoices.get(i)),
      );
      return Object.fromEntries(rows.map((r) => [r.id, r.number]));
    },
    [invoiceIds],
    Boolean(p),
  );
  const [refunding, setRefunding] = useState(false);
  const [allocating, setAllocating] = useState(false);

  if (pay.error) {
    const e = errorStateFor(pay.error);
    return (
      <ErrorState
        title={pay.error.kind === "not_found" ? "Payment not found" : e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={pay.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!p)
    return (
      <div className="dos-stack" aria-busy="true">
        <span className="dos-sr-only">Loading payment</span>
        <Skeleton height="2rem" width="40%" />
        <Skeleton height="10rem" />
      </div>
    );

  const canRecord = canDo("payment:record", { branchId: p.branchId });
  const canRefund = canDo("refund:issue", { branchId: p.branchId });
  const advance = p.status === "RECORDED" ? p.unallocatedPaise : 0;

  return (
    <div className="dos-stack" data-gap="lg">
      <header className="dos-page-head">
        <div>
          <Breadcrumbs
            items={[
              { label: "Home", href: "/" },
              { label: "Billing", href: "/billing" },
              { label: "Payments", href: "/payments" },
              { label: p.receiptNumber ?? "Payment" },
            ]}
          />
          <h1 className="dos-cluster" style={{ gap: 12 }}>
            {p.receiptNumber ?? "Payment"} <PaymentStatusBadge status={p.status} />
          </h1>
          <p>
            {formatDateTime(p.receivedAt)} · {formatPaise(p.amountPaise)} ·{" "}
            <Link href={`/patients/${p.patientId}`}>{nameOf(p.patientId)}</Link>
          </p>
        </div>
      </header>
      <MockNotice />
      <div className="bil-actions bil-no-print">
        <Button onClick={() => window.print()} disabled={p.status !== "RECORDED"}>
          <Printer size={16} aria-hidden="true" /> Print receipt
        </Button>
        {p.status === "RECORDED" && advance > 0 && canRecord ? (
          <Button variant="secondary" onClick={() => setAllocating(true)}>
            Apply advance ({formatPaise(advance)})
          </Button>
        ) : null}
        {p.status === "RECORDED" && advance > 0 && canRefund ? (
          <Button variant="secondary" onClick={() => setRefunding(true)}>
            Refund advance
          </Button>
        ) : null}
        {p.status === "PENDING" ? (
          <Button variant="secondary" onClick={pay.reload} loading={pay.loading}>
            Check gateway status
          </Button>
        ) : null}
      </div>
      {p.status === "PENDING" ? (
        <Alert tone="warning">
          Waiting for the gateway to confirm this payment. It isn't recorded, and nothing is applied
          to invoices, until it does.
        </Alert>
      ) : null}
      {p.status === "FAILED" ? (
        <Alert tone="danger">
          The gateway reported this payment as failed. No money was received.
        </Alert>
      ) : null}
      {advance > 0 ? (
        <Alert tone="info">
          {formatPaise(advance)} of this payment is held as the patient's advance.
        </Alert>
      ) : null}

      <ReceiptSheet
        payment={p}
        patientName={nameOf(p.patientId)}
        branchName={branches.name(p.branchId)}
        invoiceNumbers={invoices.data ?? {}}
      />

      {p.refunds.length > 0 ? (
        <div className="bil-no-print">
          <Section
            title="Refunds of this payment"
            actions={<Link href="/payments/refunds">All refunds</Link>}
          >
            <RefundMiniTable refunds={p.refunds} />
          </Section>
        </div>
      ) : null}

      <RefundRequestDialog
        open={refunding}
        onOpenChange={setRefunding}
        payment={p}
        onDone={pay.reload}
      />
      <AllocateDialog
        payment={p}
        open={allocating}
        onOpenChange={setAllocating}
        onDone={pay.reload}
      />
    </div>
  );
}

/** Apply the unapplied part of a recorded payment to the patient's open invoices. */
function AllocateDialog({
  payment,
  open,
  onOpenChange,
  onDone,
}: {
  payment: PaymentDetailResponse;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const keyer = useKeyer("alloc");
  const outstanding = useOutstandingInvoices(payment.patientId, payment.branchId);
  const invoices = outstanding.data ?? [];
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string>();
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const run = useMutation(billingApi.payments.allocate, {
    success: "Payment applied",
    onSuccess: () => {
      keyer.reset();
      onDone();
      onOpenChange(false);
    },
    onError: setServerError,
  });
  const { allocations, errors } = parsePicks(picks, invoices);
  const total = allocations.reduce((s, a) => s + a.amountPaise, 0);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Apply advance to invoices"
      description={`${formatPaise(payment.unallocatedPaise)} of this payment isn't applied yet.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={run.pending}
            onClick={() => {
              setServerError(null);
              if (allocations.length === 0 || Object.keys(errors).length)
                return setErr("Tick an invoice and enter valid amounts");
              if (total > payment.unallocatedPaise)
                return setErr(
                  `At most ${formatPaise(payment.unallocatedPaise)} is left on this payment`,
                );
              setErr(undefined);
              void run.run(payment.id, {
                allocations,
                idempotencyKey: keyer.keyFor(JSON.stringify(allocations)),
              });
            }}
          >
            Apply {total ? formatPaise(total) : ""}
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}
        {err ? (
          <div className="dos-error" role="alert">
            {err}
          </div>
        ) : null}
        <AllocationList invoices={invoices} picks={picks} setPicks={setPicks} errors={errors} />
      </div>
    </Dialog>
  );
}
