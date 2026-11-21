"use client";
import {
  Badge,
  Button,
  type ColumnDef,
  CursorPager,
  DataTable,
  Drawer,
  SelectField,
  StatCard,
  StatGrid,
  TextField,
} from "@dentalos/ui";
import {
  STOCK_MOVEMENT_KINDS,
  type StockMovementResponse,
  type StockReceiptResponse,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { type ExpiringBatch, inventoryApi } from "../../lib/api/inventory";
import { formatDate, formatDateTime, formatPaise, humanize } from "../../lib/format";
import { canDo, userLabel } from "../../lib/session";
import { useCursorPaging } from "../../lib/use-cursor";
import { Loadable } from "../common";
import {
  BranchSelect,
  ItemSelect,
  type TabProps,
  expiryBadge,
  formatQty,
  formatUnitCost,
  qtyWithUnit,
  useItemDirectory,
  useScopedBranches,
} from "./bits";
import { useSuppliers } from "./receive-stock";

const kindTone = (k: string) =>
  k === "RECEIPT" || k === "TRANSFER_IN"
    ? "success"
    : k === "WASTE"
      ? "danger"
      : k === "ADJUSTMENT"
        ? "warning"
        : "neutral";

// ---- Receipts ------------------------------------------------------------------------------------
export function ReceiptsTab({ rev, openDialog }: TabProps) {
  const { name: branchName } = useScopedBranches();
  const sup = useSuppliers(rev);
  const dir = useItemDirectory(rev);
  const [branchId, setBranchId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [branchId, supplierId, from, to]);
  const list = useQuery(
    () =>
      inventoryApi.stock.receipts({
        branchId: branchId || undefined,
        supplierId: supplierId || undefined,
        from: from || undefined,
        to: to || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [branchId, supplierId, from, to, paging.cursor, rev],
  );
  const [open, setOpen] = useState<StockReceiptResponse | null>(null);

  const columns: ColumnDef<StockReceiptResponse, unknown>[] = [
    {
      id: "date",
      header: "Received",
      accessorFn: (r) => r.receivedOn,
      cell: ({ row }) => formatDate(row.original.receivedOn),
    },
    { id: "branch", header: "Branch", accessorFn: (r) => branchName(r.branchId) },
    { id: "supplier", header: "Supplier", accessorFn: (r) => sup.name(r.supplierId) },
    {
      id: "ref",
      header: "Reference",
      accessorFn: (r) => r.reference,
      cell: ({ row }) => row.original.reference ?? "—",
    },
    { id: "lines", header: "Lines", accessorFn: (r) => r.movements.length },
    {
      id: "total",
      header: "Total cost",
      accessorFn: (r) => r.totalCostPaise ?? 0,
      cell: ({ row }) => (
        <span className="dos-num">{formatPaise(row.original.totalCostPaise)}</span>
      ),
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <Button size="sm" variant="secondary" onClick={() => setOpen(row.original)}>
          View
          <span className="dos-sr-only">
            {" "}
            receipt {row.original.reference ?? formatDate(row.original.receivedOn)}
          </span>
        </Button>
      ),
    },
  ];

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter receipts">
        <BranchSelect value={branchId} onChange={setBranchId} allLabel="All my branches" />
        <SelectField
          label="Supplier"
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
        >
          <option value="">All suppliers</option>
          {sup.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        {canDo("inventory:write") ? (
          <div className="dos-field">
            <span className="dos-label">&nbsp;</span>
            <Button onClick={() => openDialog({ kind: "receive" })}>
              <Plus size={16} aria-hidden="true" /> Receive stock
            </Button>
          </div>
        ) : null}
      </search>
      <div>
        <DataTable
          caption="Stock receipts"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No receipts"
          emptyDescription="Receive a purchase to see it here."
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
      {open ? (
        <Drawer
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={`Receipt ${open.reference ?? formatDate(open.receivedOn)}`}
          description={`${branchName(open.branchId)} · ${sup.name(open.supplierId)} · received ${formatDate(open.receivedOn)}`}
        >
          <div className="dos-table-scroll">
            <table className="dos-table">
              <caption className="dos-sr-only">Receipt lines</caption>
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Batch</th>
                  <th scope="col">Expiry</th>
                  <th scope="col">Qty</th>
                  <th scope="col">Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {open.movements.map((m) => {
                  const it = dir.byId(m.itemId);
                  return (
                    <tr key={m.id}>
                      <td>{it?.name ?? "Item"}</td>
                      <td className="dos-mono">{m.batchNo ?? "—"}</td>
                      <td>{formatDate(m.expiryDate)}</td>
                      <td className="dos-num">{qtyWithUnit(m.quantity, it?.unit)}</td>
                      <td className="dos-num">{formatUnitCost(m.unitCostPaise)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="dos-muted">
            Total {formatPaise(open.totalCostPaise)}
            {open.notes ? ` · ${open.notes}` : ""}
          </p>
        </Drawer>
      ) : null}
    </div>
  );
}

// ---- Movement ledger -------------------------------------------------------------------------------
export function MovementsTab({ rev }: TabProps) {
  const { name: branchName } = useScopedBranches();
  const dir = useItemDirectory(rev);
  const [branchId, setBranchId] = useState("");
  const [itemId, setItemId] = useState("");
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [procedure, setProcedure] = useState("");
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [branchId, itemId, kind, from, to, procedure]);
  const uuidOk = /^[0-9a-f-]{36}$/i.test(procedure.trim());
  const list = useQuery(
    () =>
      inventoryApi.stock.movements({
        branchId: branchId || undefined,
        itemId: itemId || undefined,
        kind: kind || undefined,
        from: from || undefined,
        to: to || undefined,
        procedureRecordId: uuidOk ? procedure.trim() : undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [branchId, itemId, kind, from, to, uuidOk ? procedure.trim() : "", paging.cursor, rev],
  );

  const columns: ColumnDef<StockMovementResponse, unknown>[] = [
    {
      id: "when",
      header: "When",
      accessorFn: (m) => m.createdAt,
      cell: ({ row }) => formatDateTime(row.original.createdAt),
    },
    { id: "branch", header: "Branch", accessorFn: (m) => branchName(m.branchId) },
    { id: "item", header: "Item", accessorFn: (m) => dir.byId(m.itemId)?.name ?? "Item" },
    {
      id: "kind",
      header: "Type",
      accessorFn: (m) => m.kind,
      cell: ({ row }) => (
        <Badge tone={kindTone(row.original.kind)}>{humanize(row.original.kind)}</Badge>
      ),
    },
    {
      id: "qty",
      header: "Quantity",
      accessorFn: (m) => m.quantity,
      cell: ({ row }) => {
        const m = row.original;
        return (
          <span className="dos-num">
            {m.quantity > 0 ? "+" : ""}
            {qtyWithUnit(m.quantity, dir.byId(m.itemId)?.unit)}
          </span>
        );
      },
    },
    {
      id: "cost",
      header: "Unit cost",
      accessorFn: (m) => m.unitCostPaise ?? 0,
      cell: ({ row }) => (
        <span className="dos-num">{formatUnitCost(row.original.unitCostPaise)}</span>
      ),
    },
    {
      id: "batch",
      header: "Batch",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="dos-mono">
          {row.original.batchNo ?? "—"}
          {row.original.expiryDate ? ` · ${formatDate(row.original.expiryDate)}` : ""}
        </span>
      ),
    },
    {
      id: "after",
      header: "Balance",
      accessorFn: (m) => m.balanceAfter ?? 0,
      cell: ({ row }) => <span className="dos-num">{formatQty(row.original.balanceAfter)}</span>,
    },
    {
      id: "why",
      header: "Reason / link",
      enableSorting: false,
      cell: ({ row }) => {
        const m = row.original;
        const links = [
          m.procedureRecordId ? "Procedure linked" : "",
          m.transferId ? "Transfer" : "",
          m.receiptId ? "Receipt" : "",
        ].filter(Boolean);
        return (
          <div>
            <div>{m.reason ?? "—"}</div>
            {links.length ? (
              <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
                {links.join(" · ")}
              </div>
            ) : null}
          </div>
        );
      },
    },
    { id: "by", header: "By", accessorFn: (m) => userLabel(m.createdBy) },
  ];

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter stock movements">
        <BranchSelect value={branchId} onChange={setBranchId} allLabel="All my branches" />
        <ItemSelect items={dir.items} value={itemId} onChange={setItemId} allLabel="All items" />
        <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {STOCK_MOVEMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {humanize(k)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <TextField
          label="Procedure record id"
          value={procedure}
          onChange={(e) => setProcedure(e.target.value)}
          error={procedure.trim() !== "" && !uuidOk ? "Enter the full id" : undefined}
          autoComplete="off"
        />
      </search>
      <div>
        <DataTable
          caption="Stock movement ledger"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(m) => m.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No movements"
          emptyDescription="Receipts, usage, adjustments, waste and transfers appear here, newest first."
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
    </div>
  );
}

// ---- Batches / expiry --------------------------------------------------------------------------------
export function ExpiryTab({ rev, openDialog }: TabProps) {
  const { name: branchName } = useScopedBranches();
  const [branchId, setBranchId] = useState("");
  const [within, setWithin] = useState("90");
  const q = useQuery(
    () =>
      inventoryApi.reports.expiring({
        branchId: branchId || undefined,
        withinDays: Number(within),
        limit: 500,
      }),
    [branchId, within, rev],
  );

  const columns: ColumnDef<ExpiringBatch, unknown>[] = [
    {
      id: "item",
      header: "Item",
      accessorFn: (b) => b.name,
      cell: ({ row }) => (
        <div>
          <div>{row.original.name}</div>
          <div className="dos-muted dos-mono" style={{ fontSize: "var(--text-xs)" }}>
            {row.original.sku}
          </div>
        </div>
      ),
    },
    { id: "branch", header: "Branch", accessorFn: (b) => branchName(b.branchId) },
    {
      accessorKey: "batchNo",
      header: "Batch",
      cell: ({ getValue }) => <span className="dos-mono">{getValue() as string}</span>,
    },
    {
      id: "expiry",
      header: "Expiry",
      accessorFn: (b) => b.expiryDate,
      cell: ({ row }) => formatDate(row.original.expiryDate),
    },
    {
      id: "qty",
      header: "Quantity",
      accessorFn: (b) => b.quantity,
      cell: ({ row }) => (
        <span className="dos-num">{qtyWithUnit(row.original.quantity, row.original.unit)}</span>
      ),
    },
    {
      id: "when",
      header: "Status",
      accessorFn: (b) => b.daysToExpiry,
      cell: ({ row }) => {
        const e = expiryBadge(row.original.daysToExpiry);
        return <Badge tone={e.tone}>{e.label}</Badge>;
      },
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.expired && canDo("inventory:adjust", { branchId: row.original.branchId }) ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              openDialog({
                kind: "waste",
                preset: { branchId: row.original.branchId, itemId: row.original.itemId },
              })
            }
          >
            Record waste
            <span className="dos-sr-only">
              {" "}
              for {row.original.name} batch {row.original.batchNo}
            </span>
          </Button>
        ) : null,
    },
  ];

  const rows = q.data?.items ?? [];
  return (
    <div className="dos-stack">
      <StatGrid>
        <StatCard
          label="Batches listed"
          value={q.data ? rows.length : "—"}
          loading={q.loading && !q.data}
        />
        <StatCard
          label="Already expired"
          value={q.data ? rows.filter((b) => b.expired).length : "—"}
          hint="Still counted in stock"
          loading={q.loading && !q.data}
        />
      </StatGrid>
      <search className="dos-toolbar" aria-label="Filter batches">
        <BranchSelect value={branchId} onChange={setBranchId} allLabel="All my branches" />
        <SelectField
          label="Expiring within"
          value={within}
          onChange={(e) => setWithin(e.target.value)}
        >
          <option value="30">30 days</option>
          <option value="60">60 days</option>
          <option value="90">90 days</option>
          <option value="180">6 months</option>
          <option value="365">1 year</option>
        </SelectField>
      </search>
      <DataTable
        caption="Batches nearing expiry"
        columns={columns}
        data={rows}
        getRowId={(b) => `${b.branchId}|${b.itemId}|${b.batchNo}`}
        loading={q.loading && !q.data}
        error={q.error ? errorStateFor(q.error) : undefined}
        searchable
        searchLabel="Search batches"
        pageSize={15}
        emptyTitle="Nothing is expiring in this window"
        emptyDescription="Only batches with stock on hand are listed."
      />
    </div>
  );
}

// ---- Valuation ------------------------------------------------------------------------------------------
export function ValuationTab({ rev }: TabProps) {
  const { name: branchName } = useScopedBranches();
  const [branchId, setBranchId] = useState("");
  const q = useQuery(
    () => inventoryApi.reports.valuation({ branchId: branchId || undefined }),
    [branchId, rev],
  );
  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter valuation">
        <BranchSelect value={branchId} onChange={setBranchId} allLabel="All my branches" />
      </search>
      <Loadable state={q}>
        {(v) => (
          <>
            <StatGrid>
              <StatCard
                label="Stock value"
                value={formatPaise(v.totalPaise)}
                hint="Quantity × weighted-average cost"
              />
              <StatCard label="Branches" value={v.rows.length} />
            </StatGrid>
            <div className="dos-table-card">
              <div className="dos-table-scroll">
                <table className="dos-table">
                  <caption className="dos-sr-only">Stock valuation by branch</caption>
                  <thead>
                    <tr>
                      <th scope="col">Branch</th>
                      <th scope="col">Items in stock</th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.rows.map((r) => (
                      <tr key={r.branchId}>
                        <td>{branchName(r.branchId)}</td>
                        <td className="dos-num">{r.itemCount}</td>
                        <td className="dos-num">{formatPaise(r.valuePaise)}</td>
                      </tr>
                    ))}
                    {v.rows.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="dos-muted">
                          No stock to value yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={2}>
                        Total
                      </th>
                      <td className="dos-num">{formatPaise(v.totalPaise)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            <p className="dos-muted">
              Valued at weighted-average cost: each receipt blends into the running average, usage
              and waste leave at the current average. Negative balances are not counted.
            </p>
          </>
        )}
      </Loadable>
    </div>
  );
}
