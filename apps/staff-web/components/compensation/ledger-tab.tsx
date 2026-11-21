"use client";
import {
  Alert,
  Badge,
  Button,
  type ColumnDef,
  CursorPager,
  DataTable,
  Dialog,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  COMMISSION_ENTRY_KINDS,
  type CommissionEntryResponse,
  createCommissionAdjustmentRequest,
} from "@dentalos/validation";
import { Plus, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { type AccrualResult, commissionsApi } from "../../lib/api/commissions";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { formatDateTime, humanize } from "../../lib/format";
import { type FieldErrors, rupeesToPaise, validate } from "../../lib/forms";
import { useCursorPaging } from "../../lib/use-cursor";
import { BranchOptions, useBranches } from "../common";
import {
  DentistField,
  entryTone,
  formatSigned,
  newKey,
  short,
  useCompensationScope,
  useDentists,
} from "./bits";

type Name = (userId: string | null | undefined) => string;

/** Ledger columns shared by the statement, the ledger and the frozen settlement items. */
export function entryColumns(opts: {
  showDentist: boolean;
  dentistName: Name;
  branchName?: (id: string) => string;
}): ColumnDef<CommissionEntryResponse, unknown>[] {
  const cols: ColumnDef<CommissionEntryResponse, unknown>[] = [
    {
      id: "when",
      header: "When",
      accessorFn: (e) => e.createdAt,
      cell: ({ row }) => formatDateTime(row.original.createdAt),
    },
  ];
  if (opts.showDentist)
    cols.push({
      id: "dentist",
      header: "Dentist",
      accessorFn: (e) => opts.dentistName(e.dentistUserId),
    });
  if (opts.branchName) {
    const bn = opts.branchName;
    cols.push({ id: "branch", header: "Branch", accessorFn: (e) => bn(e.branchId) });
  }
  cols.push(
    {
      id: "kind",
      header: "Type",
      accessorFn: (e) => e.kind,
      cell: ({ row }) => (
        <Badge tone={entryTone(row.original.kind)}>{humanize(row.original.kind)}</Badge>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      accessorFn: (e) => e.amountPaise,
      cell: ({ row }) => <span className="dos-num">{formatSigned(row.original.amountPaise)}</span>,
    },
    {
      id: "invoice",
      header: "Invoice",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.invoiceId ? (
          <span className="dos-mono" title={row.original.invoiceId}>
            {short(row.original.invoiceId)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "settled",
      header: "Settlement",
      accessorFn: (e) => e.settled,
      cell: ({ row }) =>
        row.original.kind === "SETTLEMENT" ? (
          <Badge tone="info">Payout</Badge>
        ) : row.original.settled ? (
          <Badge tone="success">Settled</Badge>
        ) : (
          <Badge tone="neutral">Unsettled</Badge>
        ),
    },
    {
      id: "reason",
      header: "Reason",
      enableSorting: false,
      cell: ({ row }) => row.original.reason ?? "—",
    },
  );
  return cols;
}

/** Commission ledger: accruals, reversals, adjustments and payouts (append-only). */
export function LedgerTab({ rev, onChanged }: { rev: number; onChanged: () => void }) {
  const { all, manage } = useCompensationScope();
  const { dentists, name: dentistName } = useDentists();
  const { branches, name: branchName } = useBranches();
  const [dentist, setDentist] = useState("");
  const [branchId, setBranchId] = useState("");
  const [kind, setKind] = useState("");
  const [settled, setSettled] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [dentist, branchId, kind, settled, from, to]);
  const list = useQuery(
    () =>
      commissionsApi.entries.list({
        dentistUserId: all ? dentist || undefined : undefined,
        branchId: branchId || undefined,
        kind: kind || undefined,
        settled: settled === "" ? undefined : settled === "true",
        from: from || undefined,
        to: to || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [all, dentist, branchId, kind, settled, from, to, paging.cursor, rev],
  );
  const [adjusting, setAdjusting] = useState(false);
  const [recovering, setRecovering] = useState(false);

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter ledger">
        {all ? (
          <DentistField
            value={dentist}
            onChange={setDentist}
            dentists={dentists}
            allLabel="All dentists"
          />
        ) : null}
        <SelectField label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">All branches</option>
          <BranchOptions branches={branches} />
        </SelectField>
        <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {COMMISSION_ENTRY_KINDS.map((k) => (
            <option key={k} value={k}>
              {humanize(k)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Settlement"
          value={settled}
          onChange={(e) => setSettled(e.target.value)}
        >
          <option value="">Any</option>
          <option value="false">Unsettled</option>
          <option value="true">Settled</option>
        </SelectField>
        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {manage ? (
          <div className="dos-field">
            <span className="dos-label">&nbsp;</span>
            <div className="dos-cluster">
              <Button onClick={() => setAdjusting(true)}>
                <Plus size={16} aria-hidden="true" /> Adjustment
              </Button>
              <Button variant="secondary" onClick={() => setRecovering(true)}>
                <Wrench size={16} aria-hidden="true" /> Recover accrual
              </Button>
            </div>
          </div>
        ) : null}
      </search>
      <div>
        <DataTable
          caption="Commission ledger"
          columns={entryColumns({ showDentist: all, dentistName, branchName })}
          data={list.data?.items ?? []}
          getRowId={(e) => e.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No ledger entries"
          emptyDescription="Commission accrues when payments are allocated to invoices with a dentist and a matching rule."
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
      {adjusting ? (
        <AdjustmentDialog
          dentists={dentists}
          onClose={() => setAdjusting(false)}
          onDone={() => {
            setAdjusting(false);
            onChanged();
          }}
        />
      ) : null}
      {recovering ? <AccrueDialog onClose={() => setRecovering(false)} onDone={onChanged} /> : null}
    </div>
  );
}

// ---- Manual adjustment ----------------------------------------------------------------------------------
function AdjustmentDialog({
  dentists,
  onClose,
  onDone,
}: {
  dentists: { userId: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { branches } = useBranches();
  const [dentistUserId, setDentist] = useState("");
  const [branchId, setBranchId] = useState("");
  const [direction, setDirection] = useState<"CREDIT" | "DEDUCT">("CREDIT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  // Same key while the payload is unchanged so a retry can't post the adjustment twice.
  const [attempt, setAttempt] = useState<{ sig: string; key: string } | null>(null);
  const save = useMutation(commissionsApi.entries.adjust, {
    success: "Adjustment recorded",
    onSuccess: onDone,
    onError: (e) => setErrors(e.fieldErrors),
  });

  const submit = () => {
    const paise = rupeesToPaise(amount);
    const body = {
      dentistUserId,
      branchId,
      amountPaise: paise === null ? undefined : direction === "DEDUCT" ? -paise : paise,
      reason,
    };
    const sig = JSON.stringify(body);
    const key = attempt?.sig === sig ? attempt.key : newKey();
    setAttempt({ sig, key });
    const r = validate(createCommissionAdjustmentRequest, { ...body, idempotencyKey: key });
    if (!r.ok) {
      const e = r.errors;
      if (amount.trim() !== "" && paise === null) e.amountPaise = "Enter an amount like 1,250.50";
      return setErrors(e);
    }
    setErrors({});
    void save.run(r.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Manual adjustment"
      description="Corrects a dentist's commission balance. It is added to the ledger as a signed entry with your name and reason; nothing is rewritten."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Record adjustment
          </Button>
        </>
      }
    >
      <form
        className="dos-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DentistField
          required
          dentists={dentists}
          value={dentistUserId}
          onChange={setDentist}
          error={errors.dentistUserId}
        />
        <SelectField
          label="Branch"
          required
          value={branchId}
          error={errors.branchId}
          onChange={(e) => setBranchId(e.target.value)}
        >
          <option value="">Select a branch</option>
          <BranchOptions branches={branches} />
        </SelectField>
        <div className="dos-form-grid">
          <SelectField
            label="Effect"
            value={direction}
            onChange={(e) => setDirection(e.target.value as "CREDIT" | "DEDUCT")}
          >
            <option value="CREDIT">Add to what the clinic owes</option>
            <option value="DEDUCT">Deduct from what the clinic owes</option>
          </SelectField>
          <TextField
            label="Amount (₹)"
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.amountPaise}
          />
        </div>
        <TextareaField
          label="Reason"
          required
          hint="At least 3 characters. Shown on the dentist's statement."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />
      </form>
    </Dialog>
  );
}

// ---- Manual accrual recovery -----------------------------------------------------------------------------
function AccrueDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [allocationId, setAllocationId] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<AccrualResult | null>(null);
  const run = useMutation((id: string) => commissionsApi.accrue(id), {
    onSuccess: (r) => {
      setResult(r);
      if (r.status === "accrued") onDone();
    },
  });
  const submit = () => {
    const id = allocationId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      return setError("Enter the payment allocation id (a UUID).");
    setError(undefined);
    setResult(null);
    void run.run(id);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Recover a missed accrual"
      description="Re-runs commission accrual for one payment allocation. It is safe to repeat: nothing is booked twice."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button loading={run.pending} onClick={submit}>
            Run accrual
          </Button>
        </>
      }
    >
      <form
        className="dos-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Payment allocation id"
          required
          autoComplete="off"
          value={allocationId}
          onChange={(e) => setAllocationId(e.target.value)}
          error={error}
          hint="Found on the payment in Billing. Accrual normally runs automatically; use this if it was skipped."
        />
        {result ? (
          <Alert tone={result.status === "accrued" ? "success" : "info"}>
            {result.status === "accrued"
              ? `Commission accrued (${result.entries.length} ledger entr${result.entries.length === 1 ? "y" : "ies"}).`
              : result.status === "noop"
                ? "Nothing to book: this allocation was already accrued, or no rule applies."
                : "No payment allocation with that id."}
            {result.skipped.length ? (
              <ul>
                {result.skipped.map((s, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list of reasons
                  <li key={i}>{skipReason(s.reason)}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
      </form>
    </Dialog>
  );
}

const SKIP_REASONS: Record<string, string> = {
  allocation_not_found: "The allocation was not found.",
  invoice_not_issued: "The invoice is not issued yet.",
  no_dentist: "A line has no dentist attributed, so it earns no commission.",
  no_rule: "No commission rule applied to a line on the invoice date.",
};
const skipReason = (code: string) => SKIP_REASONS[code] ?? humanize(code);
