"use client";
import {
  Alert,
  Badge,
  Button,
  type ColumnDef,
  CursorPager,
  DataTable,
  Dialog,
  Drawer,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type StockTransferResponse,
  receiveTransferRequest,
  roundQuantity,
  sendTransferRequest,
} from "@dentalos/validation";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { inventoryApi } from "../../lib/api/inventory";
import { formatDate, formatDateTime, humanize } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import { canDo, userLabel } from "../../lib/session";
import { useCursorPaging } from "../../lib/use-cursor";
import { BranchOptions, useBranches } from "../common";
import {
  BatchSelect,
  BranchSelect,
  ItemSelect,
  type TabProps,
  formatQty,
  newKey,
  num,
  qtyWithUnit,
  unitLabel,
  useIdemKey,
  useItemDirectory,
  useScopedBranches,
} from "./bits";

/** Inter-branch transfers: create & send, in-transit list, receive (a short receipt is allowed). */
export function TransfersTab({ rev }: TabProps) {
  const { name: branchName } = useScopedBranches();
  const dir = useItemDirectory(rev);
  const [status, setStatus] = useState("IN_TRANSIT");
  const [fromBranchId, setFrom] = useState("");
  const [toBranchId, setTo] = useState("");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [status, fromBranchId, toBranchId]);
  const [local, setLocal] = useState(0);
  const list = useQuery(
    () =>
      inventoryApi.transfers.list({
        status: (status || undefined) as "IN_TRANSIT" | "RECEIVED" | undefined,
        fromBranchId: fromBranchId || undefined,
        toBranchId: toBranchId || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [status, fromBranchId, toBranchId, paging.cursor, rev, local],
  );
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<StockTransferResponse | null>(null);
  const [receiving, setReceiving] = useState<StockTransferResponse | null>(null);
  const canSend = canDo("inventory:transfer");

  const columns: ColumnDef<StockTransferResponse, unknown>[] = [
    {
      id: "sent",
      header: "Sent",
      accessorFn: (t) => t.sentAt,
      cell: ({ row }) => formatDateTime(row.original.sentAt),
    },
    {
      id: "route",
      header: "From → to",
      accessorFn: (t) => branchName(t.fromBranchId),
      cell: ({ row }) =>
        `${branchName(row.original.fromBranchId)} → ${branchName(row.original.toBranchId)}`,
    },
    {
      id: "items",
      header: "Items",
      accessorFn: (t) => t.lines.length,
      cell: ({ row }) => {
        const t = row.original;
        const first = dir.byId(t.lines[0]?.itemId)?.name ?? "Item";
        return t.lines.length > 1 ? `${first} +${t.lines.length - 1} more` : first;
      },
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (t) => t.status,
      cell: ({ row }) => {
        const t = row.original;
        const short =
          t.status === "RECEIVED" &&
          t.lines.some((l) => (l.receivedQuantity ?? l.quantity) < l.quantity);
        return (
          <div className="dos-cluster">
            <Badge tone={t.status === "IN_TRANSIT" ? "warning" : "success"}>
              {humanize(t.status)}
            </Badge>
            {short ? <Badge tone="danger">Short receipt</Badge> : null}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const t = row.original;
        return (
          <div className="dos-cluster">
            <Button size="sm" variant="ghost" onClick={() => setViewing(t)}>
              Details<span className="dos-sr-only"> of transfer to {branchName(t.toBranchId)}</span>
            </Button>
            {t.status === "IN_TRANSIT" &&
            canDo("inventory:transfer", { branchId: t.toBranchId }) ? (
              <Button size="sm" onClick={() => setReceiving(t)}>
                Receive<span className="dos-sr-only"> transfer at {branchName(t.toBranchId)}</span>
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter transfers">
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="IN_TRANSIT">In transit</option>
          <option value="RECEIVED">Received</option>
          <option value="">All</option>
        </SelectField>
        <BranchSelect label="From branch" value={fromBranchId} onChange={setFrom} allLabel="Any" />
        <BranchSelect label="To branch" value={toBranchId} onChange={setTo} allLabel="Any" />
        {canSend ? (
          <div className="dos-field">
            <span className="dos-label">&nbsp;</span>
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" /> New transfer
            </Button>
          </div>
        ) : null}
      </search>
      <div>
        <DataTable
          caption="Stock transfers"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(t) => t.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle={status === "IN_TRANSIT" ? "Nothing in transit" : "No transfers"}
          emptyDescription="Stock leaves the source branch when a transfer is sent and arrives when the destination receives it."
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
        <SendDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            setLocal((n) => n + 1);
          }}
        />
      ) : null}
      {receiving ? (
        <ReceiveDialog
          transfer={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            setLocal((n) => n + 1);
          }}
        />
      ) : null}
      {viewing ? <DetailsDrawer transfer={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

// ---- Send ------------------------------------------------------------------------------------------------
interface SendLine {
  key: string;
  itemId: string;
  quantity: string;
  batchNo: string;
}
const blank = (): SendLine => ({ key: newKey(), itemId: "", quantity: "", batchNo: "" });

function SendDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const dir = useItemDirectory();
  const { branches } = useBranches();
  const { ids } = useScopedBranches();
  const [fromBranchId, setFrom] = useState("");
  useEffect(() => {
    if (!fromBranchId && ids.length === 1) setFrom(ids[0] as string);
  }, [ids, fromBranchId]);
  const [toBranchId, setTo] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<SendLine[]>([blank()]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const idem = useIdemKey();
  const save = useMutation(inventoryApi.transfers.send, {
    success: "Transfer sent. Stock has left the source branch.",
    onSuccess: () => {
      idem.done();
      onDone();
    },
    onError: (e) => setErrors(e.fieldErrors),
  });
  const setLine = (key: string, patch: Partial<SendLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = () => {
    const body = {
      fromBranchId,
      toBranchId,
      notes,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        quantity: num(l.quantity),
        batchNo: dir.byId(l.itemId)?.tracksBatches ? l.batchNo : "",
      })),
    };
    const r = validate(sendTransferRequest, { ...body, idempotencyKey: idem.keyFor(body) });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    void save.run(r.data);
  };

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="New transfer"
      description="Sending takes the stock out of the source branch now. The destination books it in when it receives the transfer."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Send transfer
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
        <div className="dos-form-grid">
          <BranchSelect
            label="From branch"
            required
            value={fromBranchId}
            onChange={setFrom}
            error={errors.fromBranchId}
          />
          <SelectField
            label="To branch"
            required
            value={toBranchId}
            onChange={(e) => setTo(e.target.value)}
            error={errors.toBranchId}
          >
            <option value="">Select a branch</option>
            <BranchOptions branches={branches.filter((b) => b.id !== fromBranchId)} />
          </SelectField>
        </div>
        {errors.lines ? <Alert tone="danger">{errors.lines}</Alert> : null}
        <div className="dos-stack" data-gap="sm">
          {lines.map((l, i) => {
            const item = dir.byId(l.itemId);
            return (
              <fieldset key={l.key} className="dos-card dos-stack" data-gap="sm">
                <legend className="dos-label">Line {i + 1}</legend>
                <div className="dos-form-grid">
                  <ItemSelect
                    items={dir.items}
                    value={l.itemId}
                    onChange={(v) => setLine(l.key, { itemId: v, batchNo: "" })}
                    error={errors[`lines.${i}.itemId`]}
                    required
                  />
                  <TextField
                    label={`Quantity${item ? ` (${unitLabel(item.unit)})` : ""}`}
                    inputMode="decimal"
                    required
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                    error={errors[`lines.${i}.quantity`]}
                  />
                  {item?.tracksBatches ? (
                    <BatchSelect
                      branchId={fromBranchId}
                      itemId={l.itemId}
                      value={l.batchNo}
                      onChange={(v) => setLine(l.key, { batchNo: v })}
                      error={errors[`lines.${i}.batchNo`]}
                    />
                  ) : null}
                </div>
                {lines.length > 1 ? (
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2 size={14} aria-hidden="true" /> Remove line {i + 1}
                    </Button>
                  </div>
                ) : null}
              </fieldset>
            );
          })}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLines((ls) => [...ls, blank()])}
            >
              <Plus size={14} aria-hidden="true" /> Add item
            </Button>
          </div>
        </div>
        <TextareaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </form>
    </Dialog>
  );
}

// ---- Receive (partial allowed) ------------------------------------------------------------------------------
function ReceiveDialog({
  transfer,
  onClose,
  onDone,
}: { transfer: StockTransferResponse; onClose: () => void; onDone: () => void }) {
  const dir = useItemDirectory();
  const { name } = useScopedBranches();
  const [got, setGot] = useState<Record<string, string>>(() =>
    Object.fromEntries(transfer.lines.map((l) => [l.id, String(l.quantity)])),
  );
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (body: { lines: { lineId: string; receivedQuantity: number }[]; notes?: string }) =>
      inventoryApi.transfers.receive(transfer.id, body),
    {
      success: "Transfer received",
      onSuccess: onDone,
      onError: (e) => setErrors(e.fieldErrors),
    },
  );

  const shortage = transfer.lines.reduce((n, l) => {
    const r = num(got[l.id] ?? "");
    return r !== undefined && Number.isFinite(r) && r < l.quantity ? n + 1 : n;
  }, 0);

  const submit = () => {
    const lineErrors: FieldErrors = {};
    transfer.lines.forEach((l, i) => {
      const r = num(got[l.id] ?? "");
      if (r === undefined || !Number.isFinite(r))
        lineErrors[`lines.${i}`] = "Enter the quantity received";
      else if (r < 0) lineErrors[`lines.${i}`] = "Can't be negative";
      else if (roundQuantity(r) > l.quantity)
        lineErrors[`lines.${i}`] =
          `Can't exceed the ${formatQty(l.quantity)} sent. Record shortfalls by receiving less.`;
    });
    if (Object.keys(lineErrors).length) return setErrors(lineErrors);
    const r = validate(receiveTransferRequest, {
      lines: transfer.lines.map((l) => ({ lineId: l.id, receivedQuantity: num(got[l.id] ?? "") })),
      notes,
    });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    void save.run({ lines: r.data.lines ?? [], ...(r.data.notes ? { notes: r.data.notes } : {}) });
  };

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={`Receive at ${name(transfer.toBranchId)}`}
      description={`Sent from ${name(transfer.fromBranchId)} on ${formatDate(transfer.sentAt)}. Enter what actually arrived.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Confirm receipt
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
        {shortage > 0 ? (
          <Alert tone="warning">
            {shortage} line{shortage === 1 ? " is" : "s are"} short. Only what you enter is booked
            into this branch. The shortfall is recorded on the transfer; follow it up with the
            sending branch.
          </Alert>
        ) : null}
        {transfer.lines.map((l, i) => {
          const it = dir.byId(l.itemId);
          return (
            <div key={l.id} className="dos-form-grid">
              <div>
                <div>{it?.name ?? "Item"}</div>
                <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
                  Sent {qtyWithUnit(l.quantity, it?.unit)}
                  {l.batchNo ? ` · batch ${l.batchNo}` : ""}
                  {l.expiryDate ? ` · exp ${formatDate(l.expiryDate)}` : ""}
                </div>
              </div>
              <TextField
                label={`Received${it ? ` (${unitLabel(it.unit)})` : ""}${l.batchNo ? `, batch ${l.batchNo}` : ""}`}
                inputMode="decimal"
                value={got[l.id] ?? ""}
                onChange={(e) => setGot({ ...got, [l.id]: e.target.value })}
                error={errors[`lines.${i}`]}
              />
            </div>
          );
        })}
        <TextareaField
          label="Notes"
          hint="For example: one box arrived damaged."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </form>
    </Dialog>
  );
}

// ---- Details ------------------------------------------------------------------------------------------------------
function DetailsDrawer({
  transfer,
  onClose,
}: { transfer: StockTransferResponse; onClose: () => void }) {
  const dir = useItemDirectory();
  const { name } = useScopedBranches();
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${name(transfer.fromBranchId)} → ${name(transfer.toBranchId)}`}
      description={`${humanize(transfer.status)} · sent ${formatDateTime(transfer.sentAt)} by ${userLabel(transfer.sentBy)}${
        transfer.receivedAt
          ? ` · received ${formatDateTime(transfer.receivedAt)} by ${userLabel(transfer.receivedBy ?? "")}`
          : ""
      }`}
    >
      <div className="dos-table-scroll">
        <table className="dos-table">
          <caption className="dos-sr-only">Transfer lines</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Batch</th>
              <th scope="col">Sent</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {transfer.lines.map((l) => {
              const it = dir.byId(l.itemId);
              const short = l.receivedQuantity !== null && l.receivedQuantity < l.quantity;
              return (
                <tr key={l.id}>
                  <td>{it?.name ?? "Item"}</td>
                  <td className="dos-mono">{l.batchNo ?? "—"}</td>
                  <td className="dos-num">{qtyWithUnit(l.quantity, it?.unit)}</td>
                  <td className="dos-num">
                    {l.receivedQuantity === null ? "—" : qtyWithUnit(l.receivedQuantity, it?.unit)}
                    {short ? (
                      <Badge tone="danger">
                        Short {formatQty(l.quantity - (l.receivedQuantity ?? 0))}
                      </Badge>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {transfer.notes ? <p className="dos-muted">{transfer.notes}</p> : null}
    </Drawer>
  );
}
