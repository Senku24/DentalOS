"use client";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  Timeline,
  type TimelineItem,
  useLink,
} from "@dentalos/ui";
import {
  type InvoiceDetailResponse,
  type InvoiceLineResponse,
  isInterStateSupply,
} from "@dentalos/validation";
import { Ban, CheckCircle2, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  InvoiceStatusBadge,
  LinkButton,
  Money,
  TotalsList,
} from "../../../components/billing/bits";
import {
  AddLineDrawer,
  DeleteLineDialog,
  EditLineDialog,
  HeaderDialog,
  InvoiceDiscountDialog,
} from "../../../components/billing/draft-editor";
import {
  AdjustmentDialog,
  IssueDialog,
  UseAdvanceDialog,
  VoidDialog,
} from "../../../components/billing/invoice-dialogs";
import { PaymentDrawer } from "../../../components/billing/payment-drawer";
import { RefundRequestDialog } from "../../../components/billing/refund-dialogs";
import { RefundMiniTable } from "../../../components/billing/refund-table";
import { useBillingBranches, useBillingSettings } from "../../../components/billing/use-billing";
import { MockNotice, RequirePermission, Section } from "../../../components/common";
import { billingApi } from "../../../lib/api/billing";
import { isImmutableInvoiceError } from "../../../lib/api/billing-errors";
import { invoiceCapabilities, methodLabel } from "../../../lib/api/billing-rules";
import { api } from "../../../lib/api/endpoints";
import { type ApiError, errorStateFor } from "../../../lib/api/errors";
import { useQuery } from "../../../lib/api/hooks";
import {
  formatDate,
  formatDateTime,
  formatPaise,
  humanize,
  patientName,
} from "../../../lib/format";
import { canDo, userLabel } from "../../../lib/session";

export function InvoicePage({ id }: { id: string }) {
  return (
    <RequirePermission permission="billing:read">
      <Inner id={id} />
    </RequirePermission>
  );
}

type Dlg =
  | "issue"
  | "void"
  | "pay"
  | "adjust"
  | "refund"
  | "advance"
  | "header"
  | "addLine"
  | "discount"
  | null;

function Inner({ id }: { id: string }) {
  const Link = useLink();
  const inv = useQuery(() => billingApi.invoices.get(id), [id]);
  const data = inv.data;
  const branches = useBillingBranches();
  const { effective: settings } = useBillingSettings(data?.branchId);
  const patient = useQuery(
    () => api.patients.get((data as InvoiceDetailResponse).patientId),
    [data?.patientId],
    Boolean(data),
  );
  const credit = useQuery(
    () => billingApi.patients.credit((data as InvoiceDetailResponse).patientId, 1),
    [data?.patientId, data?.paidPaise, data?.status],
    Boolean(data),
  );
  const paymentKey = data
    ? [...new Set(data.allocations.map((a) => a.paymentId))].sort().join(",")
    : "";
  const payments = useQuery(
    () =>
      Promise.all(
        paymentKey
          .split(",")
          .filter(Boolean)
          .map((p) => billingApi.payments.get(p)),
      ),
    [paymentKey],
    Boolean(data),
  );
  const refunds = useQuery(
    async () =>
      (
        await billingApi.refunds.list({
          patientId: (data as InvoiceDetailResponse).patientId,
          limit: 100,
        })
      ).items.filter((r) => r.invoiceId === id),
    [data?.patientId, data?.paidPaise],
    Boolean(data),
  );

  const [dlg, setDlg] = useState<Dlg>(null);
  const [editing, setEditing] = useState<InvoiceLineResponse | null>(null);
  const [deleting, setDeleting] = useState<InvoiceLineResponse | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const reloadAll = () => {
    inv.reload();
    credit.reload();
    payments.reload();
    refunds.reload();
  };
  /** A frozen invoice (issued elsewhere meanwhile) drops the edit controls on reload. */
  const onError = (e: ApiError) => {
    if (isImmutableInvoiceError(e)) {
      setBanner(e.message);
      setDlg(null);
      setEditing(null);
      setDeleting(null);
      inv.reload();
    }
  };
  const onDone = () => {
    setBanner(null);
    reloadAll();
  };

  if (inv.error) {
    const e = errorStateFor(inv.error);
    return (
      <ErrorState
        title={inv.error.kind === "not_found" ? "Invoice not found" : e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={inv.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!data)
    return (
      <div className="dos-stack" aria-busy="true">
        <span className="dos-sr-only">Loading invoice</span>
        <Skeleton height="2rem" width="40%" />
        <Skeleton height="10rem" />
      </div>
    );

  const caps = invoiceCapabilities(data);
  const branchId = data.branchId;
  const canWrite = canDo("invoice:write", { branchId });
  const inter = isInterStateSupply(data.supplierStateCode, data.placeOfSupplyStateCode);
  const advance = credit.data?.balancePaise ?? 0;
  const pname = patient.data ? patientName(patient.data) : (data.patientName ?? "Patient");
  const paymentById = new Map((payments.data ?? []).map((p) => [p.id, p]));

  const actions = (
    <div className="bil-actions bil-no-print">
      {caps.editable && canWrite ? (
        <>
          <Button variant="secondary" onClick={() => setDlg("addLine")}>
            <Plus size={16} aria-hidden="true" /> Add line
          </Button>
          <Button variant="secondary" onClick={() => setDlg("header")}>
            <Pencil size={16} aria-hidden="true" /> Details
          </Button>
          {canDo("discount:apply", { branchId }) ? (
            <Button variant="secondary" onClick={() => setDlg("discount")}>
              Discount
            </Button>
          ) : null}
          <Button disabled={!caps.canIssue} onClick={() => setDlg("issue")}>
            <CheckCircle2 size={16} aria-hidden="true" /> Issue invoice
          </Button>
        </>
      ) : null}
      {caps.canPay && canDo("payment:record", { branchId }) ? (
        <Button onClick={() => setDlg("pay")}>Record payment</Button>
      ) : null}
      {caps.canPay && advance > 0 && canDo("payment:record", { branchId }) ? (
        <Button variant="secondary" onClick={() => setDlg("advance")}>
          Use advance ({formatPaise(advance)})
        </Button>
      ) : null}
      {caps.canAdjust && canDo("invoice:adjust", { branchId }) ? (
        <Button variant="secondary" onClick={() => setDlg("adjust")}>
          Credit / debit note
        </Button>
      ) : null}
      {caps.canRefund && canDo("refund:issue", { branchId }) ? (
        <Button variant="secondary" onClick={() => setDlg("refund")}>
          Request refund
        </Button>
      ) : null}
      {data.status !== "DRAFT" && data.status !== "VOID" ? (
        <LinkButton href={`/invoices/${data.id}/print`}>
          <Printer size={16} aria-hidden="true" /> Print
        </LinkButton>
      ) : null}
      {caps.canVoid && canWrite ? (
        <Button variant="danger" onClick={() => setDlg("void")}>
          <Ban size={16} aria-hidden="true" /> Void
        </Button>
      ) : null}
    </div>
  );

  const timeline: TimelineItem[] = [
    ...(data.voidedAt
      ? [
          {
            id: "void",
            at: data.voidedAt,
            title: "Voided",
            meta: `${formatDateTime(data.voidedAt)} · ${userLabel(data.voidedBy ?? "")}`,
            description: data.voidReason ?? undefined,
            tone: "danger" as const,
          },
        ]
      : []),
    ...data.adjustments.map((a) => ({
      id: a.id,
      at: a.issuedAt,
      title: `${a.kind === "CREDIT" ? "Credit" : "Debit"} note ${a.number}: ${formatPaise(a.amountPaise)}`,
      meta: `${formatDateTime(a.issuedAt)} · ${userLabel(a.issuedBy)}`,
      description: a.reason,
      tone: "warning" as const,
    })),
    ...data.allocations.map((a) => ({
      id: a.id,
      at: a.createdAt,
      title:
        a.amountPaise >= 0
          ? `Payment of ${formatPaise(a.amountPaise)} applied`
          : `Refund of ${formatPaise(-a.amountPaise)} reopened the balance`,
      meta: `${formatDateTime(a.createdAt)} · ${userLabel(a.allocatedBy)}`,
      tone: a.amountPaise >= 0 ? ("success" as const) : ("warning" as const),
    })),
    ...(data.issuedAt
      ? [
          {
            id: "issued",
            at: data.issuedAt,
            title: `Issued as ${data.number}`,
            meta: `${formatDateTime(data.issuedAt)} · ${userLabel(data.issuedBy ?? "")}`,
            tone: "info" as const,
          },
        ]
      : []),
    {
      id: "created",
      at: data.createdAt,
      title: "Draft created",
      meta: `${formatDateTime(data.createdAt)} · ${userLabel(data.createdBy)}`,
      tone: "neutral" as const,
    },
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ at: _at, ...t }) => t);

  const cgst = data.lines.reduce((s, l) => s + l.cgstPaise, 0);
  const sgst = data.lines.reduce((s, l) => s + l.sgstPaise, 0);
  const igst = data.lines.reduce((s, l) => s + l.igstPaise, 0);

  return (
    <div className="dos-stack" data-gap="lg">
      <header className="dos-page-head">
        <div>
          <Breadcrumbs
            items={[
              { label: "Home", href: "/" },
              { label: "Billing", href: "/billing" },
              { label: "Invoices", href: "/invoices" },
              { label: data.number ?? "Draft" },
            ]}
          />
          <h1 className="dos-cluster" style={{ gap: 12 }}>
            {data.number ?? "Draft invoice"} <InvoiceStatusBadge status={data.status} />
          </h1>
          <p>
            <Link href={`/patients/${data.patientId}`}>{pname}</Link> ·{" "}
            {branches.name(data.branchId)}
            {data.issuedAt
              ? ` · issued ${formatDate(data.issuedAt)}`
              : ` · created ${formatDate(data.createdAt)}`}
            {data.dueDate ? ` · due ${formatDate(data.dueDate)}` : ""}
          </p>
        </div>
      </header>
      <MockNotice />
      {actions}
      {banner ? <Alert tone="warning">{banner}</Alert> : null}
      {data.status === "VOID" ? (
        <Alert tone="danger">
          Voided {formatDateTime(data.voidedAt)} by {userLabel(data.voidedBy ?? "")}. Reason:{" "}
          {data.voidReason}
        </Alert>
      ) : null}
      {data.status === "DRAFT" ? (
        <Alert tone="info">
          This is a draft: it has no number yet and can still be edited. Issuing assigns the number
          and locks it.
        </Alert>
      ) : null}

      <div className="bil-grid-2">
        <Section title="Lines">
          {data.lines.length === 0 ? (
            <EmptyState title="No lines" description="Add at least one line before issuing." />
          ) : (
            <div className="dos-table-scroll">
              <table className="dos-table">
                <caption className="dos-sr-only">Invoice lines with GST</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="bil-money">
                      Qty
                    </th>
                    <th scope="col" className="bil-money">
                      Price
                    </th>
                    <th scope="col" className="bil-money">
                      Discount
                    </th>
                    <th scope="col" className="bil-money">
                      Taxable
                    </th>
                    <th scope="col" className="bil-money">
                      GST %
                    </th>
                    {inter ? (
                      <th scope="col" className="bil-money">
                        IGST
                      </th>
                    ) : (
                      <>
                        <th scope="col" className="bil-money">
                          CGST
                        </th>
                        <th scope="col" className="bil-money">
                          SGST
                        </th>
                      </>
                    )}
                    <th scope="col" className="bil-money">
                      Total
                    </th>
                    {caps.editable && canWrite ? <th scope="col">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{l.lineNo}</td>
                      <td>
                        {l.description}
                        <div className="dos-hint">
                          {[
                            l.toothCode ? `Tooth ${l.toothCode}` : null,
                            l.hsnSac ? `HSN/SAC ${l.hsnSac}` : null,
                            l.dentistUserId ? userLabel(l.dentistUserId) : null,
                            l.discountReason ? `Discount: ${l.discountReason}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </td>
                      <td className="bil-money">{l.quantity}</td>
                      <td>
                        <Money paise={l.unitPricePaise} />
                      </td>
                      <td>
                        <Money paise={l.discountPaise + l.allocatedDiscountPaise} />
                      </td>
                      <td>
                        <Money paise={l.taxableValuePaise} />
                      </td>
                      <td className="bil-money">
                        {(l.taxRateBp / 100).toFixed(l.taxRateBp % 100 ? 2 : 0)}%
                      </td>
                      {inter ? (
                        <td>
                          <Money paise={l.igstPaise} />
                        </td>
                      ) : (
                        <>
                          <td>
                            <Money paise={l.cgstPaise} />
                          </td>
                          <td>
                            <Money paise={l.sgstPaise} />
                          </td>
                        </>
                      )}
                      <td>
                        <Money paise={l.totalPaise} bold />
                      </td>
                      {caps.editable && canWrite ? (
                        <td>
                          <div className="bil-actions">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>
                              <Pencil size={14} aria-hidden="true" />
                              <span className="dos-sr-only">Edit line {l.lineNo}</span>
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleting(l)}>
                              <Trash2 size={14} aria-hidden="true" />
                              <span className="dos-sr-only">Remove line {l.lineNo}</span>
                            </Button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.notes ? (
            <p>
              <strong>Notes:</strong> {data.notes}
            </p>
          ) : null}
        </Section>

        <div className="dos-stack">
          <Section title="Amounts">
            <TotalsList
              rows={[
                { label: "Subtotal", paise: data.subtotalPaise },
                {
                  label: data.invoiceDiscountPaise
                    ? `Discounts (incl. invoice discount ${formatPaise(data.invoiceDiscountPaise)})`
                    : "Discounts",
                  paise: -data.discountPaise,
                  hide: data.discountPaise === 0,
                },
                { label: "CGST", paise: cgst, hide: inter || data.taxPaise === 0 },
                { label: "SGST", paise: sgst, hide: inter || data.taxPaise === 0 },
                { label: "IGST", paise: igst, hide: !inter || data.taxPaise === 0 },
                {
                  label: data.taxInclusive ? "Invoice total (GST included)" : "Invoice total",
                  paise: data.totalPaise,
                  strong: true,
                },
                {
                  label: "Credit / debit notes",
                  paise: data.adjustmentPaise,
                  hide: data.adjustmentPaise === 0,
                },
                { label: "Paid", paise: data.paidPaise },
                { label: "Balance due", paise: data.balancePaise, strong: true },
              ]}
            />
            <p className="dos-hint">
              Supplier state {data.supplierStateCode ?? "unknown"}
              {data.supplierGstin ? ` · GSTIN ${data.supplierGstin}` : ""} · place of supply{" "}
              {data.placeOfSupplyStateCode ?? "—"} · {inter ? "IGST (inter-state)" : "CGST + SGST"}
              {data.planId ? <> · from plan v{data.planVersion ?? "?"}</> : null}
            </p>
            {data.invoiceDiscountPaise > 0 && data.discountReason ? (
              <p className="dos-hint">Invoice discount reason: {data.discountReason}</p>
            ) : null}
          </Section>
          <Section title="History">
            <Timeline items={timeline} label="Invoice history" />
          </Section>
        </div>
      </div>

      <Section title="Payments applied">
        {data.allocations.length === 0 ? (
          <p className="dos-muted">No payments have been applied to this invoice.</p>
        ) : (
          <div className="dos-table-scroll">
            <table className="dos-table">
              <caption className="dos-sr-only">Payment allocations</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Receipt</th>
                  <th scope="col">Method</th>
                  <th scope="col" className="bil-money">
                    Applied
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.allocations.map((a) => {
                  const p = paymentById.get(a.paymentId);
                  return (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.createdAt)}</td>
                      <td>
                        <Link href={`/payments/${a.paymentId}`}>
                          {p?.receiptNumber ?? "Payment"}
                        </Link>
                        {a.amountPaise < 0 ? " (refund reversal)" : ""}
                      </td>
                      <td>{p ? methodLabel(p.method) : "…"}</td>
                      <td>
                        <Money paise={a.amountPaise} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {data.adjustments.length > 0 ? (
        <Section title="Credit and debit notes">
          <div className="dos-table-scroll">
            <table className="dos-table">
              <caption className="dos-sr-only">Credit and debit notes</caption>
              <thead>
                <tr>
                  <th scope="col">Number</th>
                  <th scope="col">Type</th>
                  <th scope="col">Date</th>
                  <th scope="col">Reason</th>
                  <th scope="col" className="bil-money">
                    Amount
                  </th>
                  <th scope="col" className="bil-money">
                    GST part
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.adjustments.map((a) => (
                  <tr key={a.id}>
                    <td>{a.number}</td>
                    <td>
                      <Badge tone={a.kind === "CREDIT" ? "info" : "warning"}>
                        {humanize(a.kind)} note
                      </Badge>
                    </td>
                    <td>{formatDate(a.issuedAt)}</td>
                    <td>{a.reason}</td>
                    <td>
                      <Money paise={a.kind === "CREDIT" ? -a.amountPaise : a.amountPaise} />
                    </td>
                    <td>
                      <Money paise={a.taxPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {(refunds.data ?? []).length > 0 ? (
        <Section title="Refunds" actions={<Link href="/payments/refunds">All refunds</Link>}>
          <RefundMiniTable refunds={refunds.data ?? []} />
        </Section>
      ) : null}

      {/* Dialogs */}
      <IssueDialog
        invoice={data}
        open={dlg === "issue"}
        onOpenChange={(o) => !o && setDlg(null)}
        onDone={onDone}
        onError={onError}
      />
      <VoidDialog
        invoice={data}
        open={dlg === "void"}
        onOpenChange={(o) => !o && setDlg(null)}
        onDone={onDone}
        onError={onError}
      />
      <HeaderDialog
        invoice={data}
        open={dlg === "header"}
        onOpenChange={(o) => !o && setDlg(null)}
        onDone={onDone}
        onError={onError}
      />
      <AddLineDrawer
        invoice={data}
        settings={settings}
        open={dlg === "addLine"}
        onOpenChange={(o) => !o && setDlg(null)}
        onDone={onDone}
        onError={onError}
      />
      <InvoiceDiscountDialog
        invoice={data}
        settings={settings}
        open={dlg === "discount"}
        onOpenChange={(o) => !o && setDlg(null)}
        onDone={onDone}
        onError={onError}
      />
      <EditLineDialog
        invoice={data}
        line={editing}
        settings={settings}
        onClose={() => setEditing(null)}
        onDone={onDone}
        onError={onError}
      />
      <DeleteLineDialog
        invoice={data}
        line={deleting}
        onClose={() => setDeleting(null)}
        onDone={onDone}
        onError={onError}
      />
      <AdjustmentDialog
        invoice={data}
        open={dlg === "adjust"}
        onOpenChange={(o) => !o && setDlg(null)}
        onDone={onDone}
      />
      <UseAdvanceDialog
        invoice={data}
        advancePaise={advance}
        open={dlg === "advance"}
        onOpenChange={(o) => !o && setDlg(null)}
        onDone={onDone}
      />
      <RefundRequestDialog
        open={dlg === "refund"}
        onOpenChange={(o) => !o && setDlg(null)}
        invoice={data}
        onDone={onDone}
      />
      <PaymentDrawer
        open={dlg === "pay"}
        onOpenChange={(o) => !o && setDlg(null)}
        patient={patient.data ?? null}
        branchId={data.branchId}
        invoiceId={data.id}
        onRecorded={onDone}
      />
    </div>
  );
}
