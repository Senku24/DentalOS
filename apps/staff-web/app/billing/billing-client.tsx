"use client";
import {
  Alert,
  Button,
  type ColumnDef,
  DataTable,
  StatCard,
  StatGrid,
  useLink,
} from "@dentalos/ui";
import type { InvoiceSummary, PaymentResponse } from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
  BillingSubnav,
  BranchFilter,
  InvoiceStatusBadge,
  LinkButton,
  Money,
} from "../../components/billing/bits";
import { collectAll, useOutstandingAll } from "../../components/billing/outstanding";
import { PaymentDrawer } from "../../components/billing/payment-drawer";
import { useBillingBranches } from "../../components/billing/use-billing";
import { MockNotice, RequirePermission, Section } from "../../components/common";
import { billingApi } from "../../lib/api/billing";
import { agingBuckets, methodLabel } from "../../lib/api/billing-rules";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { formatDate, formatPaise, todayISO } from "../../lib/format";
import { canDo } from "../../lib/session";

export function BillingDashboard() {
  return (
    <RequirePermission permission="billing:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const Link = useLink();
  const branches = useBillingBranches();
  const [branchId, setBranchId] = useState("");
  const [recording, setRecording] = useState(false);
  const today = todayISO();

  const collections = useQuery(
    () =>
      collectAll<PaymentResponse>(
        (cursor) =>
          billingApi.payments.list({
            from: today,
            to: today,
            branchId: branchId || undefined,
            cursor,
            limit: 100,
          }),
        10,
      ),
    [branchId, today],
  );
  const outstanding = useOutstandingAll(branchId);
  const awaiting = useQuery(
    () =>
      billingApi.refunds.list({ status: "REQUESTED", branchId: branchId || undefined, limit: 100 }),
    [branchId],
  );
  const recent = useQuery(
    () => billingApi.invoices.list({ branchId: branchId || undefined, limit: 8 }),
    [branchId],
  );

  const recorded = (collections.data?.items ?? []).filter((p) => p.status === "RECORDED");
  const collected = recorded.reduce((s, p) => s + p.amountPaise, 0);
  const byMethod = new Map<string, number>();
  for (const p of recorded) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amountPaise);
  const owed = (outstanding.data?.items ?? []).reduce((s, i) => s + i.balancePaise, 0);
  const aging = agingBuckets(outstanding.data?.items ?? [], today);
  const overdue = aging.slice(1).reduce((s, r) => s + r.balancePaise, 0);
  const overdueCount = aging.slice(1).reduce((s, r) => s + r.count, 0);

  const columns: ColumnDef<InvoiceSummary, unknown>[] = [
    {
      header: "Invoice",
      cell: ({ row: { original: i } }) => (
        <Link href={`/invoices/${i.id}`}>{i.number ?? "Draft"}</Link>
      ),
    },
    { header: "Patient", cell: ({ row: { original: i } }) => i.patientName ?? "Patient" },
    { header: "Date", cell: ({ row: { original: i } }) => formatDate(i.issuedAt ?? i.createdAt) },
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
      <BillingSubnav />
      <MockNotice />
      <div className="bil-filters" style={{ justifyContent: "space-between" }}>
        <BranchFilter branches={branches.scoped} value={branchId} onChange={setBranchId} />
        <div className="bil-actions">
          {canDo("invoice:write") ? (
            <LinkButton href="/invoices/new" variant="primary">
              <Plus size={16} aria-hidden="true" /> New invoice
            </LinkButton>
          ) : null}
          {canDo("payment:record") ? (
            <Button variant="secondary" onClick={() => setRecording(true)}>
              Record payment
            </Button>
          ) : null}
        </div>
      </div>

      <StatGrid>
        <StatCard
          label="Collected today"
          loading={collections.loading && !collections.data}
          value={collections.error ? "—" : formatPaise(collected)}
          hint={
            collections.error
              ? errorStateFor(collections.error).description
              : `${recorded.length} payment${recorded.length === 1 ? "" : "s"} recorded`
          }
        />
        <StatCard
          label="Outstanding"
          loading={outstanding.loading && !outstanding.data}
          value={outstanding.error ? "—" : formatPaise(owed)}
          hint={
            outstanding.error
              ? errorStateFor(outstanding.error).description
              : `${outstanding.data?.items.length ?? 0} open invoice${outstanding.data?.items.length === 1 ? "" : "s"}`
          }
        />
        <StatCard
          label="Overdue"
          loading={outstanding.loading && !outstanding.data}
          value={outstanding.error ? "—" : formatPaise(overdue)}
          hint={`${overdueCount} invoice${overdueCount === 1 ? "" : "s"} past due`}
        />
        <StatCard
          label="Refunds awaiting approval"
          loading={awaiting.loading && !awaiting.data}
          value={awaiting.error ? "—" : (awaiting.data?.items.length ?? 0)}
          hint={<Link href="/payments/refunds">Open refunds</Link>}
        />
      </StatGrid>
      {collections.data?.truncated || outstanding.data?.truncated ? (
        <Alert tone="warning">
          There are more records than this overview loads, so the totals above are partial. Use the
          reports for exact figures.
        </Alert>
      ) : null}

      <div className="bil-grid-2">
        <Section title="Recent invoices" actions={<Link href="/invoices">All invoices</Link>}>
          <DataTable
            caption="Recent invoices"
            columns={columns}
            data={recent.data?.items ?? []}
            getRowId={(i) => i.id}
            loading={recent.loading && !recent.data}
            error={recent.error ? errorStateFor(recent.error) : undefined}
            searchable={false}
            hidePagination
            emptyTitle="No invoices yet"
            emptyDescription="Create the first invoice to see it here."
          />
        </Section>
        <div className="dos-stack">
          <Section title="Collected today by method">
            {byMethod.size === 0 ? (
              <p className="dos-muted">No payments recorded today.</p>
            ) : (
              <dl className="bil-totals">
                {[...byMethod.entries()].map(([m, v]) => (
                  <div key={m} style={{ display: "contents" }}>
                    <dt>{methodLabel(m)}</dt>
                    <dd>{formatPaise(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>
          <Section title="Outstanding by age" description="Days past the due date">
            <div className="dos-table-scroll">
              <table className="dos-table">
                <caption className="dos-sr-only">Outstanding balances by age</caption>
                <thead>
                  <tr>
                    <th scope="col">Age</th>
                    <th scope="col" className="bil-money">
                      Invoices
                    </th>
                    <th scope="col" className="bil-money">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aging.map((r) => (
                    <tr key={r.bucket}>
                      <td>{r.bucket}</td>
                      <td className="bil-money">{r.count}</td>
                      <td>
                        <Money paise={r.balancePaise} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </div>

      <PaymentDrawer
        open={recording}
        onOpenChange={setRecording}
        onRecorded={() => {
          collections.reload();
          outstanding.reload();
        }}
      />
    </div>
  );
}
