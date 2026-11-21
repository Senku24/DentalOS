"use client";
import {
  Alert,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  CursorPager,
  DataTable,
  DescriptionList,
  Dialog,
  Drawer,
  SelectField,
  Steps,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  SETTLEMENT_STATUSES,
  type SettlementDetailResponse,
  type SettlementResponse,
  approveSettlementRequest,
  createSettlementRequest,
  paySettlementRequest,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { commissionsApi } from "../../lib/api/commissions";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { formatDate, formatDateTime, formatPaise, humanize, todayISO } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import { userLabel } from "../../lib/session";
import { useCursorPaging } from "../../lib/use-cursor";
import { Loadable, useBranches } from "../common";
import {
  DentistField,
  entryTone,
  formatSigned,
  newKey,
  short,
  useCompensationScope,
  useDentists,
} from "./bits";

const statusTone = (s: string) =>
  s === "PAID" ? "success" : s === "APPROVED" ? "info" : "warning";

/** Settlement runs: create for dentist + period, approve (maker-checker), mark paid. Items are frozen at creation. */
export function SettlementsTab({ rev, onChanged }: { rev: number; onChanged: () => void }) {
  const { all, manage } = useCompensationScope();
  const { dentists, name: dentistName } = useDentists();
  const [dentist, setDentist] = useState("");
  const [status, setStatus] = useState("");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [dentist, status]);
  const [local, setLocal] = useState(0);
  const list = useQuery(
    () =>
      commissionsApi.settlements.list({
        dentistUserId: all ? dentist || undefined : undefined,
        status: status || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [all, dentist, status, paging.cursor, rev, local],
  );
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const changed = () => {
    setLocal((n) => n + 1);
    onChanged();
  };

  const columns: ColumnDef<SettlementResponse, unknown>[] = [
    ...(all
      ? [
          {
            id: "dentist",
            header: "Dentist",
            accessorFn: (s: SettlementResponse) => dentistName(s.dentistUserId),
          } as ColumnDef<SettlementResponse, unknown>,
        ]
      : []),
    {
      id: "period",
      header: "Period (end excluded)",
      accessorFn: (s) => s.periodStart,
      cell: ({ row }) =>
        `${formatDate(row.original.periodStart)} to ${formatDate(row.original.periodEnd)}`,
    },
    { id: "items", header: "Entries", accessorFn: (s) => s.itemCount ?? 0 },
    {
      id: "total",
      header: "Total",
      accessorFn: (s) => s.totalPaise,
      cell: ({ row }) => <span className="dos-num">{formatPaise(row.original.totalPaise)}</span>,
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (s) => s.status,
      cell: ({ row }) => (
        <Badge tone={statusTone(row.original.status)}>{humanize(row.original.status)}</Badge>
      ),
    },
    {
      id: "created",
      header: "Created",
      accessorFn: (s) => s.createdAt,
      cell: ({ row }) => formatDate(row.original.createdAt),
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <Button size="sm" variant="secondary" onClick={() => setOpenId(row.original.id)}>
          Open
          <span className="dos-sr-only">
            {" "}
            settlement for {dentistName(row.original.dentistUserId)}
          </span>
        </Button>
      ),
    },
  ];

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter settlements">
        {all ? (
          <DentistField
            value={dentist}
            onChange={setDentist}
            dentists={dentists}
            allLabel="All dentists"
          />
        ) : null}
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {SETTLEMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </SelectField>
        {manage ? (
          <div className="dos-field">
            <span className="dos-label">&nbsp;</span>
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" /> New settlement
            </Button>
          </div>
        ) : null}
      </search>
      <div>
        <DataTable
          caption="Commission settlements"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(s) => s.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No settlements"
          emptyDescription="A settlement gathers a dentist's unsettled commission for a period so it can be approved and paid."
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
      {creating ? (
        <CreateDialog
          dentists={dentists}
          onClose={() => setCreating(false)}
          onDone={(s) => {
            setCreating(false);
            changed();
            setOpenId(s.id);
          }}
        />
      ) : null}
      {openId ? (
        <SettlementDrawer id={openId} onClose={() => setOpenId(null)} onChanged={changed} />
      ) : null}
    </div>
  );
}

// ---- Create ---------------------------------------------------------------------------------------------------
function CreateDialog({
  dentists,
  onClose,
  onDone,
}: {
  dentists: { userId: string; name: string }[];
  onClose: () => void;
  onDone: (s: SettlementResponse) => void;
}) {
  const today = todayISO();
  const [dentistUserId, setDentist] = useState("");
  const [periodStart, setStart] = useState(`${today.slice(0, 8)}01`);
  const [periodEnd, setEnd] = useState(today);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState<{ sig: string; key: string } | null>(null);
  const save = useMutation(commissionsApi.settlements.create, {
    success: (s) =>
      `Draft settlement created: ${formatPaise(s.totalPaise)} across ${s.itemCount ?? 0} entries`,
    onSuccess: onDone,
    onError: (e) => {
      setErrors(e.fieldErrors);
      setFormError(Object.keys(e.fieldErrors).length === 0 ? e.message : undefined);
    },
  });
  const submit = () => {
    const body = { dentistUserId, periodStart, periodEnd, notes };
    const sig = JSON.stringify(body);
    const key = attempt?.sig === sig ? attempt.key : newKey();
    setAttempt({ sig, key });
    const r = validate(createSettlementRequest, { ...body, idempotencyKey: key });
    if (!r.ok) return setErrors(r.errors);
    if (periodEnd <= periodStart) return setErrors({ periodEnd: "Must be after the period start" });
    setErrors({});
    setFormError(undefined);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New settlement"
      description="Collects every unsettled ledger entry created before the period end, including earlier carry-overs and late reversals. The entries are frozen into the settlement."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Create draft
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
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <DentistField
          required
          dentists={dentists}
          value={dentistUserId}
          onChange={setDentist}
          error={errors.dentistUserId}
        />
        <div className="dos-form-grid">
          <TextField
            label="Period starts"
            type="date"
            required
            value={periodStart}
            onChange={(e) => setStart(e.target.value)}
            error={errors.periodStart}
          />
          <TextField
            label="Period ends (excluded)"
            type="date"
            required
            value={periodEnd}
            onChange={(e) => setEnd(e.target.value)}
            error={errors.periodEnd}
            hint="Entries up to the day before are included."
          />
        </div>
        <p className="dos-muted" style={{ margin: 0 }}>
          A dentist's settlement periods never overlap.
        </p>
        <TextareaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </form>
    </Dialog>
  );
}

// ---- Detail: frozen items + workflow ---------------------------------------------------------------------------
function SettlementDrawer({
  id,
  onClose,
  onChanged,
}: { id: string; onClose: () => void; onChanged: () => void }) {
  const { manage, settle, me } = useCompensationScope();
  const { name: dentistName } = useDentists();
  const { name: branchName } = useBranches();
  const [local, setLocal] = useState(0);
  const q = useQuery(() => commissionsApi.settlements.get(id), [id, local]);
  const [action, setAction] = useState<"approve" | "pay" | "delete" | null>(null);
  const after = () => {
    setAction(null);
    setLocal((n) => n + 1);
    onChanged();
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Settlement"
      description="Items were frozen when the settlement was created."
    >
      <Loadable state={q} rows={6}>
        {(s) => {
          const itemsTotal = s.items.reduce((a, i) => a + i.amountPaise, 0);
          const step = s.status === "DRAFT" ? 0 : s.status === "APPROVED" ? 1 : 2;
          return (
            <div className="dos-stack">
              <Steps steps={["Draft", "Approved", "Paid"]} current={step === 2 ? 3 : step} />
              <DescriptionList
                columns={2}
                items={[
                  { term: "Dentist", detail: dentistName(s.dentistUserId) },
                  {
                    term: "Status",
                    detail: <Badge tone={statusTone(s.status)}>{humanize(s.status)}</Badge>,
                  },
                  {
                    term: "Period",
                    detail: `${formatDate(s.periodStart)} to ${formatDate(s.periodEnd)} (end excluded)`,
                  },
                  { term: "Total", detail: <strong>{formatPaise(s.totalPaise)}</strong> },
                  {
                    term: "Created",
                    detail: `${formatDateTime(s.createdAt)} by ${userLabel(s.createdBy)}`,
                  },
                  {
                    term: "Approved",
                    detail: s.approvedAt
                      ? `${formatDateTime(s.approvedAt)} by ${userLabel(s.approvedBy ?? "")}`
                      : "Not yet",
                  },
                  {
                    term: "Paid",
                    detail: s.paidAt
                      ? `${formatDateTime(s.paidAt)} by ${userLabel(s.paidBy ?? "")}`
                      : "Not yet",
                  },
                  { term: "Payment reference", detail: s.paymentReference ?? "—" },
                  { term: "Notes", detail: s.notes ?? "—" },
                ]}
              />
              {itemsTotal !== s.totalPaise ? (
                <Alert tone="danger">
                  The items add up to {formatPaise(itemsTotal)} but the settlement total is{" "}
                  {formatPaise(s.totalPaise)}. Approval will be refused. Delete this draft and
                  create a new one.
                </Alert>
              ) : null}
              <ActionBar
                s={s}
                manage={manage}
                settle={settle}
                madeByMe={s.createdBy === me}
                onAction={setAction}
              />
              <h3 className="dos-section-title" style={{ marginBottom: 0 }}>
                Frozen items ({s.items.length})
              </h3>
              <div className="dos-table-scroll">
                <table className="dos-table">
                  <caption className="dos-sr-only">Settlement items</caption>
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Branch</th>
                      <th scope="col">Type</th>
                      <th scope="col">Invoice</th>
                      <th scope="col">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.items.map((i) => (
                      <tr key={i.id}>
                        <td>{formatDate(i.entry.createdAt)}</td>
                        <td>{branchName(i.entry.branchId)}</td>
                        <td>
                          <Badge tone={entryTone(i.entry.kind)}>{humanize(i.entry.kind)}</Badge>
                          {i.entry.reason ? (
                            <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
                              {i.entry.reason}
                            </div>
                          ) : null}
                        </td>
                        <td className="dos-mono">{short(i.entry.invoiceId)}</td>
                        <td className="dos-num">{formatSigned(i.amountPaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={4}>
                        Total
                      </th>
                      <td className="dos-num">{formatPaise(itemsTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {action === "approve" ? (
                <ApproveDialog
                  s={s}
                  madeByMe={s.createdBy === me}
                  onClose={() => setAction(null)}
                  onDone={after}
                />
              ) : null}
              {action === "pay" ? (
                <PayDialog s={s} onClose={() => setAction(null)} onDone={after} />
              ) : null}
              {action === "delete" ? (
                <DeleteDialog
                  s={s}
                  onClose={() => setAction(null)}
                  onDone={() => {
                    onChanged();
                    onClose();
                  }}
                />
              ) : null}
            </div>
          );
        }}
      </Loadable>
    </Drawer>
  );
}

function ActionBar({
  s,
  manage,
  settle,
  madeByMe,
  onAction,
}: {
  s: SettlementDetailResponse;
  manage: boolean;
  settle: boolean;
  madeByMe: boolean;
  onAction: (a: "approve" | "pay" | "delete") => void;
}) {
  if (s.status === "PAID")
    return (
      <Alert tone="success">
        Paid. A payout entry of {formatPaise(s.totalPaise)} was written to the ledger.
      </Alert>
    );
  if (s.status === "APPROVED")
    return (
      <div className="dos-stack" data-gap="sm">
        <Alert tone="info">
          Approved and frozen. Pay out through your payroll, then mark it paid here to write the
          payout to the ledger.
        </Alert>
        {manage ? (
          <div>
            <Button onClick={() => onAction("pay")}>Mark as paid</Button>
          </div>
        ) : null}
      </div>
    );
  return (
    <div className="dos-stack" data-gap="sm">
      {settle && madeByMe ? (
        <Alert tone="warning">
          You created this settlement. If the organisation requires a separate approver, someone
          else must approve it.
        </Alert>
      ) : null}
      {!settle && manage ? (
        <Alert tone="info">Waiting for an approver (owner) to approve this draft.</Alert>
      ) : null}
      <div className="dos-cluster">
        {settle ? <Button onClick={() => onAction("approve")}>Approve</Button> : null}
        {manage ? (
          <Button variant="danger" onClick={() => onAction("delete")}>
            Delete draft
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ApproveDialog({
  s,
  madeByMe,
  onClose,
  onDone,
}: { s: SettlementResponse; madeByMe: boolean; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const save = useMutation(
    (body: { note?: string }) => commissionsApi.settlements.approve(s.id, body),
    {
      success: "Settlement approved",
      onSuccess: onDone,
      onError: (e) => {
        setErrors(e.fieldErrors);
        setFormError(e.message);
      },
    },
  );
  const submit = () => {
    const r = validate(approveSettlementRequest, { note });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Approve settlement"
      description={`Approving freezes ${formatPaise(s.totalPaise)} for payout. This can't be undone, and the entries can't be edited afterwards.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Approve {formatPaise(s.totalPaise)}
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
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        {madeByMe ? (
          <Alert tone="warning">
            You created this settlement. Approval is refused when the organisation requires a
            separate approver.
          </Alert>
        ) : null}
        <TextareaField
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
        />
      </form>
    </Dialog>
  );
}

function PayDialog({
  s,
  onClose,
  onDone,
}: { s: SettlementResponse; onClose: () => void; onDone: () => void }) {
  const today = todayISO();
  const [paymentReference, setRef] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const save = useMutation(
    (body: { paymentReference?: string; paidOn?: string }) =>
      commissionsApi.settlements.pay(s.id, body),
    {
      success: "Settlement marked as paid",
      onSuccess: onDone,
      onError: (e) => {
        setErrors(e.fieldErrors);
        setFormError(Object.keys(e.fieldErrors).length === 0 ? e.message : undefined);
      },
    },
  );
  const submit = () => {
    const r = validate(paySettlementRequest, { paymentReference, paidOn });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    setFormError(undefined);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Mark as paid"
      description={`Records that ${formatPaise(s.totalPaise)} was paid out (outside DentalOS) and writes the payout to the ledger. This can't be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Mark as paid
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
        {formError ? <Alert tone="danger">{formError}</Alert> : null}
        <div className="dos-form-grid">
          <TextField
            label="Payment reference"
            hint="Bank transfer or cheque number"
            value={paymentReference}
            onChange={(e) => setRef(e.target.value)}
            error={errors.paymentReference}
          />
          <TextField
            label="Paid on"
            type="date"
            max={today}
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
            error={errors.paidOn}
          />
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({
  s,
  onClose,
  onDone,
}: { s: SettlementResponse; onClose: () => void; onDone: () => void }) {
  const del = useMutation(() => commissionsApi.settlements.remove(s.id), {
    success: "Draft deleted",
    onSuccess: onDone,
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Delete this draft?"
      description={`The ${formatPaise(s.totalPaise)} draft is removed and its entries return to the unsettled pool, ready for a new settlement. Only drafts can be deleted.`}
      confirmLabel="Delete draft"
      tone="danger"
      loading={del.pending}
      onConfirm={() => void del.run()}
    />
  );
}
