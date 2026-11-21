"use client";
import {
  Alert,
  Badge,
  Button,
  type ColumnDef,
  DataTable,
  Dialog,
  SelectField,
  StatCard,
  StatGrid,
  TextField,
  TextareaField,
  useLink,
} from "@dentalos/ui";
import {
  type InvoiceSummary,
  type LedgerEntryResponse,
  adjustPatientCreditRequest,
} from "@dentalos/validation";
import { useState } from "react";
import { billingApi } from "../../lib/api/billing";
import { api } from "../../lib/api/endpoints";
import { type ApiError, errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { formatDate, formatDateTime, formatPaise, humanize } from "../../lib/format";
import { rupeesToPaise, validate } from "../../lib/forms";
import { canDo } from "../../lib/session";
import { InvoiceStatusBadge, LinkButton, Money } from "./bits";
import { RupeeField } from "./fields";
import { collectAll } from "./outstanding";
import { PaymentDrawer } from "./payment-drawer";
import { useBillingBranches, useKeyer } from "./use-billing";

const LEDGER_LABELS: Record<LedgerEntryResponse["kind"], string> = {
  INVOICE: "Invoice",
  INVOICE_VOID: "Invoice voided",
  PAYMENT: "Payment",
  REFUND: "Refund",
  CREDIT_NOTE: "Credit note",
  DEBIT_NOTE: "Debit note",
};

/**
 * Finance tab of a patient profile: what is owed, advance balance, statement, open invoices and the actions
 * to bill or take payment. Mount it inside the profile (`<PatientFinanceTab patientId={id} />`); it checks
 * billing permissions itself and shows nothing sensitive without `billing:read`.
 */
export function PatientFinanceTab({
  patientId,
  readOnly,
}: {
  patientId: string;
  /** Hide the write actions (for example a merged patient record). */
  readOnly?: boolean;
}) {
  const Link = useLink();
  const branches = useBillingBranches();
  const patient = useQuery(() => api.patients.get(patientId), [patientId]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [branchId, setBranchId] = useState("");
  const [paying, setPaying] = useState(false);
  const [adjusting, setAdjusting] = useState(false);

  const canRead = canDo("billing:read");
  const canReport = canDo("finance:report");
  const badRange = Boolean(from && to && to < from);

  const credit = useQuery(() => billingApi.patients.credit(patientId, 20), [patientId], canRead);
  const statement = useQuery(
    () =>
      billingApi.patients.statement(patientId, {
        from: from || undefined,
        to: to || undefined,
        branchId: branchId || undefined,
      }),
    [patientId, from, to, branchId],
    canRead && canReport && !badRange,
  );
  // Without finance:report there is no statement: fall back to the patient's invoices.
  const invoices = useQuery(
    async () =>
      (
        await collectAll<InvoiceSummary>(
          (cursor) => billingApi.invoices.list({ patientId, cursor, limit: 50 }),
          4,
        )
      ).items,
    [patientId],
    canRead && !canReport,
  );

  if (!canRead)
    return (
      <Alert tone="info">
        Your role doesn't include billing, so this patient's finances aren't shown.
      </Alert>
    );

  const open: InvoiceSummary[] = canReport
    ? (statement.data?.outstandingInvoices ?? [])
    : (invoices.data ?? []).filter((i) => i.status === "ISSUED" || i.status === "PARTIALLY_PAID");
  const owed = open.reduce((s, i) => s + i.balancePaise, 0);
  const advance = credit.data?.balancePaise ?? statement.data?.advanceBalancePaise ?? 0;
  const reload = () => {
    credit.reload();
    statement.reload();
    invoices.reload();
  };

  const ledgerColumns: ColumnDef<LedgerEntryResponse & { runningBalancePaise: number }, unknown>[] =
    [
      { header: "Date", cell: ({ row: { original: e } }) => formatDateTime(e.occurredAt) },
      {
        header: "Entry",
        cell: ({ row: { original: e } }) => (
          <>
            {LEDGER_LABELS[e.kind]}
            {e.invoiceId ? (
              <>
                {" · "}
                <Link href={`/invoices/${e.invoiceId}`}>invoice</Link>
              </>
            ) : null}
            {e.paymentId ? (
              <>
                {" · "}
                <Link href={`/payments/${e.paymentId}`}>payment</Link>
              </>
            ) : null}
          </>
        ),
      },
      { header: "Branch", cell: ({ row: { original: e } }) => branches.name(e.branchId) },
      {
        header: "Charged",
        cell: ({ row: { original: e } }) =>
          e.amountPaise > 0 ? <Money paise={e.amountPaise} /> : "",
      },
      {
        header: "Paid / credited",
        cell: ({ row: { original: e } }) =>
          e.amountPaise < 0 ? <Money paise={-e.amountPaise} /> : "",
      },
      {
        header: "Balance",
        cell: ({ row: { original: e } }) => <Money paise={e.runningBalancePaise} bold />,
      },
    ];
  const invoiceColumns: ColumnDef<InvoiceSummary, unknown>[] = [
    {
      header: "Invoice",
      cell: ({ row: { original: i } }) => (
        <Link href={`/invoices/${i.id}`}>{i.number ?? "Draft"}</Link>
      ),
    },
    { header: "Date", cell: ({ row: { original: i } }) => formatDate(i.issuedAt ?? i.createdAt) },
    { header: "Due", cell: ({ row: { original: i } }) => formatDate(i.dueDate) },
    {
      header: "Total",
      cell: ({ row: { original: i } }) => <Money paise={i.totalPaise + i.adjustmentPaise} />,
    },
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
      <StatGrid>
        <StatCard
          label="Owes"
          loading={(canReport ? statement.loading : invoices.loading) && open.length === 0}
          value={formatPaise(owed)}
          hint={`${open.length} open invoice${open.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Advance balance"
          loading={credit.loading && !credit.data}
          value={credit.error ? "—" : formatPaise(advance)}
          hint={advance > 0 ? "Can be applied to an invoice" : "No advance held"}
        />
      </StatGrid>

      {!readOnly ? (
        <div className="bil-actions">
          {canDo("payment:record") && patient.data ? (
            <Button onClick={() => setPaying(true)}>Record payment</Button>
          ) : null}
          {canDo("invoice:write") ? (
            <LinkButton
              href={`/invoices/new?patientId=${encodeURIComponent(patientId)}`}
              variant="secondary"
            >
              New invoice
            </LinkButton>
          ) : null}
          {canDo("invoice:adjust") ? (
            <Button variant="secondary" onClick={() => setAdjusting(true)}>
              Adjust advance
            </Button>
          ) : null}
        </div>
      ) : null}

      <section className="dos-card dos-stack" aria-labelledby="pf-open">
        <h2 className="dos-section-title" id="pf-open">
          Open invoices
        </h2>
        <DataTable
          caption="Open invoices"
          columns={invoiceColumns}
          data={open}
          getRowId={(i) => i.id}
          loading={(canReport ? statement.loading : invoices.loading) && open.length === 0}
          error={
            (canReport ? statement.error : invoices.error)
              ? errorStateFor(canReport ? statement.error : invoices.error)
              : undefined
          }
          searchable={false}
          pageSize={10}
          emptyTitle="Nothing is owed"
          emptyDescription="This patient has no invoices with a balance."
        />
      </section>

      {canReport ? (
        <section className="dos-card dos-stack" aria-labelledby="pf-stmt">
          <h2 className="dos-section-title" id="pf-stmt">
            Statement
          </h2>
          <div className="bil-filters">
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
            <SelectField
              label="Branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">All my branches</option>
              {branches.scoped.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
          </div>
          {statement.data ? (
            <p className="dos-hint">
              Opening balance {formatPaise(statement.data.openingBalancePaise)} · closing balance{" "}
              {formatPaise(statement.data.closingBalancePaise)} (positive = the patient owes).
            </p>
          ) : null}
          <DataTable
            caption="Account statement"
            columns={ledgerColumns}
            data={statement.data?.entries ?? []}
            getRowId={(e) => e.id}
            loading={statement.loading && !statement.data}
            error={statement.error ? errorStateFor(statement.error) : undefined}
            searchable={false}
            pageSize={15}
            emptyTitle="No account activity"
            emptyDescription="Invoices, payments, refunds and notes appear here."
          />
        </section>
      ) : null}

      <section className="dos-card dos-stack" aria-labelledby="pf-adv">
        <h2 className="dos-section-title" id="pf-adv">
          Advance history
        </h2>
        {credit.error ? (
          <Alert tone="danger">{errorStateFor(credit.error).description}</Alert>
        ) : (credit.data?.entries ?? []).length === 0 ? (
          <p className="dos-muted">No advance has been taken from this patient.</p>
        ) : (
          <div className="dos-table-scroll">
            <table className="dos-table">
              <caption className="dos-sr-only">Advance history</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Type</th>
                  <th scope="col">Branch</th>
                  <th scope="col">Note</th>
                  <th scope="col" className="bil-money">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {(credit.data?.entries ?? []).map((c) => (
                  <tr key={c.id}>
                    <td>{formatDateTime(c.createdAt)}</td>
                    <td>
                      <Badge tone={c.amountPaise >= 0 ? "success" : "neutral"}>
                        {humanize(c.kind)}
                      </Badge>
                    </td>
                    <td>{branches.name(c.branchId)}</td>
                    <td>
                      {c.reason ?? ""}
                      {c.paymentId ? (
                        <>
                          {" "}
                          <Link href={`/payments/${c.paymentId}`}>payment</Link>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <Money paise={c.amountPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {patient.data ? (
        <PaymentDrawer
          open={paying}
          onOpenChange={setPaying}
          patient={patient.data}
          onRecorded={reload}
        />
      ) : null}
      <AdjustAdvanceDialog
        patientId={patientId}
        open={adjusting}
        onOpenChange={setAdjusting}
        advancePaise={advance}
        onDone={reload}
      />
    </div>
  );
}

/** Manual correction of the advance balance (reason required; audited; never below zero). */
function AdjustAdvanceDialog({
  patientId,
  advancePaise,
  open,
  onOpenChange,
  onDone,
}: {
  patientId: string;
  advancePaise: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Adjust advance balance"
      description={`Current advance ${formatPaise(advancePaise)}. Use this only to correct a mistake; it is recorded with your reason.`}
    >
      {open ? (
        <AdjustForm
          patientId={patientId}
          advancePaise={advancePaise}
          onClose={() => onOpenChange(false)}
          onDone={onDone}
        />
      ) : null}
    </Dialog>
  );
}

function AdjustForm({
  patientId,
  advancePaise,
  onClose,
  onDone,
}: {
  patientId: string;
  advancePaise: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const keyer = useKeyer("cadj");
  const branches = useBillingBranches();
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [branchId, setBranchId] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const run = useMutation(
    (b: Parameters<typeof billingApi.patients.adjustCredit>[1]) =>
      billingApi.patients.adjustCredit(patientId, b),
    {
      success: "Advance balance adjusted",
      onSuccess: () => {
        keyer.reset();
        onDone();
        onClose();
      },
      onError: setServerError,
    },
  );
  const submit = () => {
    setServerError(null);
    const paise = rupeesToPaise(amount);
    const errs: Record<string, string> = {};
    if (paise === null || paise < 1) errs.amount = "Enter an amount";
    else if (direction === "remove" && paise > advancePaise)
      errs.amount = `The advance is only ${formatPaise(advancePaise)}`;
    if (!branchId) errs.branch = "Choose the branch this belongs to";
    if (reason.trim().length < 3) errs.reason = "Give a reason (at least 3 characters)";
    if (Object.keys(errs).length) return setErrors(errs);
    const body = {
      amountPaise: (direction === "add" ? 1 : -1) * (paise as number),
      branchId,
      reason: reason.trim(),
    };
    const v = validate(adjustPatientCreditRequest, {
      ...body,
      idempotencyKey: keyer.keyFor(JSON.stringify(body)),
    });
    if (!v.ok)
      return setErrors({ reason: v.errors.reason ?? "", amount: v.errors.amountPaise ?? "" });
    setErrors({});
    void run.run(v.data);
  };
  return (
    <div className="dos-stack">
      {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}
      <SelectField
        label="Change"
        value={direction}
        onChange={(e) => setDirection(e.target.value as "add" | "remove")}
      >
        <option value="add">Add to the advance</option>
        <option value="remove">Remove from the advance</option>
      </SelectField>
      <RupeeField
        label="Amount"
        required
        value={amount}
        onChange={setAmount}
        error={errors.amount}
      />
      <SelectField
        label="Branch"
        required
        value={branchId}
        onChange={(e) => setBranchId(e.target.value)}
        error={errors.branch}
      >
        <option value="">Select a branch</option>
        {branches.scoped.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </SelectField>
      <TextareaField
        label="Reason"
        required
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors.reason}
      />
      <div className="bil-actions">
        <Button onClick={submit} loading={run.pending}>
          Save adjustment
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
