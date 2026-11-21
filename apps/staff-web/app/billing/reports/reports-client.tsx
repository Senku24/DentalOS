"use client";
import { Alert, SelectField, TextField } from "@dentalos/ui";
import { REVENUE_GROUPS } from "@dentalos/validation";
import { useState } from "react";
import { BillingSubnav, BranchFilter, Money } from "../../../components/billing/bits";
import { useOutstandingAll } from "../../../components/billing/outstanding";
import { useBillingBranches } from "../../../components/billing/use-billing";
import { Loadable, MockNotice, RequirePermission, Section } from "../../../components/common";
import { billingApi } from "../../../lib/api/billing";
import { agingBuckets, dateMinusDays, methodLabel } from "../../../lib/api/billing-rules";
import { useQuery } from "../../../lib/api/hooks";
import { formatDate, todayISO } from "../../../lib/format";
import { userLabel } from "../../../lib/session";

const GROUP_LABELS: Record<(typeof REVENUE_GROUPS)[number], string> = {
  branch: "Branch",
  day: "Day",
  method: "Payment method",
  dentist: "Dentist",
};

export function ReportsClient() {
  return (
    <RequirePermission permission="finance:report">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const branches = useBillingBranches();
  const today = todayISO();
  const [from, setFrom] = useState(dateMinusDays(today, 29));
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState("");
  const [groupBy, setGroupBy] = useState<(typeof REVENUE_GROUPS)[number]>("branch");

  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const rangeError =
    !from || !to
      ? "Pick both dates"
      : to < from
        ? "The end is before the start"
        : days > 800
          ? "At most about two years"
          : null;
  const report = useQuery(
    () => billingApi.reports.revenue({ from, to, branchId: branchId || undefined, groupBy }),
    [from, to, branchId, groupBy],
    !rangeError,
  );
  const outstanding = useOutstandingAll(branchId);
  const aging = agingBuckets(outstanding.data?.items ?? [], today);

  const label = (key: string, apiLabel: string | null) => {
    if (apiLabel) return apiLabel;
    if (groupBy === "branch") return branches.name(key);
    if (groupBy === "day") return formatDate(key);
    if (groupBy === "method") return methodLabel(key);
    return key === "UNATTRIBUTED" ? "Not attributed" : userLabel(key);
  };
  const invoiceMeasures = groupBy !== "method";

  return (
    <div className="dos-stack" data-gap="lg">
      <BillingSubnav />
      <MockNotice />
      <div className="bil-filters">
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
          onChange={(e) => setTo(e.target.value)}
          error={rangeError ?? undefined}
        />
        <BranchFilter branches={branches.scoped} value={branchId} onChange={setBranchId} />
        <SelectField
          label="Group by"
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
        >
          {REVENUE_GROUPS.map((g) => (
            <option key={g} value={g}>
              {GROUP_LABELS[g]}
            </option>
          ))}
        </SelectField>
      </div>

      <Section
        title="Revenue and collections"
        description="Billed = issued invoices in the period (after credit/debit notes). Collected = payments received in the period; refunded = refunds processed in the period."
      >
        {rangeError ? (
          <p className="dos-muted">{rangeError}</p>
        ) : (
          <Loadable state={report}>
            {(r) => (
              <div className="dos-table-scroll">
                <table className="dos-table">
                  <caption className="dos-sr-only">
                    Revenue by {GROUP_LABELS[groupBy].toLowerCase()}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{GROUP_LABELS[groupBy]}</th>
                      {invoiceMeasures ? (
                        <th scope="col" className="bil-money">
                          Billed
                        </th>
                      ) : null}
                      {invoiceMeasures ? (
                        <th scope="col" className="bil-money">
                          Discounts
                        </th>
                      ) : null}
                      {invoiceMeasures ? (
                        <th scope="col" className="bil-money">
                          GST
                        </th>
                      ) : null}
                      <th scope="col" className="bil-money">
                        Collected
                      </th>
                      <th scope="col" className="bil-money">
                        Refunded
                      </th>
                      <th scope="col" className="bil-money">
                        Net collected
                      </th>
                      {invoiceMeasures ? (
                        <th scope="col" className="bil-money">
                          Outstanding
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.length === 0 ? (
                      <tr>
                        <td colSpan={8}>No activity in this period.</td>
                      </tr>
                    ) : (
                      r.rows.map((row) => (
                        <tr key={row.key}>
                          <th scope="row">{label(row.key, row.label)}</th>
                          {invoiceMeasures ? (
                            <td>
                              <Money paise={row.billedPaise} />
                            </td>
                          ) : null}
                          {invoiceMeasures ? (
                            <td>
                              <Money paise={row.discountPaise} />
                            </td>
                          ) : null}
                          {invoiceMeasures ? (
                            <td>
                              <Money paise={row.taxPaise} />
                            </td>
                          ) : null}
                          <td>
                            <Money paise={row.collectedPaise} />
                          </td>
                          <td>
                            <Money paise={row.refundedPaise} />
                          </td>
                          <td>
                            <Money paise={row.netCollectedPaise} bold />
                          </td>
                          {invoiceMeasures ? (
                            <td>
                              <Money paise={row.outstandingPaise} />
                            </td>
                          ) : null}
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      {invoiceMeasures ? (
                        <td>
                          <Money paise={r.totals.billedPaise} bold />
                        </td>
                      ) : null}
                      {invoiceMeasures ? (
                        <td>
                          <Money paise={r.totals.discountPaise} bold />
                        </td>
                      ) : null}
                      {invoiceMeasures ? (
                        <td>
                          <Money paise={r.totals.taxPaise} bold />
                        </td>
                      ) : null}
                      <td>
                        <Money paise={r.totals.collectedPaise} bold />
                      </td>
                      <td>
                        <Money paise={r.totals.refundedPaise} bold />
                      </td>
                      <td>
                        <Money paise={r.totals.netCollectedPaise} bold />
                      </td>
                      {invoiceMeasures ? (
                        <td>
                          <Money paise={r.totals.outstandingPaise} bold />
                        </td>
                      ) : null}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Loadable>
        )}
      </Section>

      <Section
        title="Outstanding balances by age"
        description="Every issued or partly paid invoice with a balance, by days past its due date, as of today."
      >
        <Loadable state={outstanding}>
          {(o) => (
            <>
              {o.truncated ? (
                <Alert tone="warning">
                  More invoices are open than could be loaded; these totals are partial.
                </Alert>
              ) : null}
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
                    {aging.map((a) => (
                      <tr key={a.bucket}>
                        <th scope="row">{a.bucket}</th>
                        <td className="bil-money">{a.count}</td>
                        <td>
                          <Money paise={a.balancePaise} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td className="bil-money">{aging.reduce((s, a) => s + a.count, 0)}</td>
                      <td>
                        <Money paise={aging.reduce((s, a) => s + a.balancePaise, 0)} bold />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </Loadable>
      </Section>
    </div>
  );
}
