"use client";
import { Alert, DataTable, SelectField, StatCard, StatGrid, TextField } from "@dentalos/ui";
import { useState } from "react";
import { commissionsApi } from "../../lib/api/commissions";
import { useQuery } from "../../lib/api/hooks";
import { formatPaise, todayISO } from "../../lib/format";
import { BranchOptions, Loadable, useBranches } from "../common";
import { DentistField, formatSigned, useCompensationScope, useDentists } from "./bits";
import { entryColumns } from "./ledger-tab";

/** A dentist's statement for a period: accrued, reversed, adjusted, settled, plus the all-time payable balance. */
export function StatementTab({ rev }: { rev: number }) {
  const { all, me } = useCompensationScope();
  const { dentists, name: dentistName } = useDentists();
  const { branches, name: branchName } = useBranches();
  const today = todayISO();
  const [dentist, setDentist] = useState("");
  const [branchId, setBranchId] = useState("");
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const rangeOk = from !== "" && to !== "" && to >= from;

  const q = useQuery(
    () =>
      commissionsApi.statement({
        // Dentists omit the id (the API answers for the caller and refuses anyone else).
        dentistUserId: all ? dentist || undefined : undefined,
        branchId: branchId || undefined,
        from,
        to,
      }),
    [all, dentist, branchId, from, to, rev],
    rangeOk,
  );

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Statement period">
        {all ? (
          <DentistField
            label="Dentist"
            value={dentist}
            onChange={setDentist}
            dentists={dentists}
            allLabel="Choose a dentist (defaults to you)"
          />
        ) : null}
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
          min={from}
          onChange={(e) => setTo(e.target.value)}
          error={from && to && to < from ? "Must not be before From" : undefined}
        />
        <SelectField label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">All branches</option>
          <BranchOptions branches={branches} />
        </SelectField>
      </search>
      {all && !dentist ? (
        <Alert tone="info">Showing your own statement. Pick a dentist above to see theirs.</Alert>
      ) : null}
      {rangeOk ? (
        <Loadable state={q} rows={5}>
          {(s) => (
            <>
              <p className="dos-muted" style={{ margin: 0 }}>
                {s.dentistUserId === me && !all
                  ? "Your statement"
                  : `Statement for ${dentistName(s.dentistUserId)}`}
              </p>
              <StatGrid>
                <StatCard
                  label="Accrued"
                  value={formatPaise(s.accruedPaise)}
                  hint="Earned on payments collected"
                />
                <StatCard
                  label="Reversed"
                  value={formatSigned(s.reversedPaise)}
                  hint="Refunds taken back"
                />
                <StatCard
                  label="Adjusted"
                  value={formatSigned(s.adjustedPaise)}
                  hint="Manual corrections"
                />
                <StatCard
                  label="Settled"
                  value={formatSigned(s.settledPaise)}
                  hint="Paid out in the period"
                />
                <StatCard
                  label="Net movement"
                  value={formatSigned(s.netPaise)}
                  hint="Sum of the four above"
                />
                <StatCard
                  label="Payable balance"
                  value={formatPaise(s.payableBalancePaise)}
                  hint={`Unsettled, all time, up to ${to}`}
                />
              </StatGrid>
              <DataTable
                caption="Statement entries"
                columns={entryColumns({ showDentist: false, dentistName, branchName })}
                data={s.entries}
                getRowId={(e) => e.id}
                searchable={false}
                pageSize={15}
                emptyTitle="No entries in this period"
                emptyDescription="Commission accrues when payments are collected for work you performed."
              />
            </>
          )}
        </Loadable>
      ) : (
        <Alert tone="warning">Choose a period where the end is not before the start.</Alert>
      )}
    </div>
  );
}
