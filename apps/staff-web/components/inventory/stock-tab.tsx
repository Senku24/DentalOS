"use client";
import {
  Badge,
  Button,
  type ColumnDef,
  CursorPager,
  DataTable,
  Drawer,
  Input,
  StatCard,
  StatGrid,
} from "@dentalos/ui";
import type { StockBalanceResponse } from "@dentalos/validation";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { inventoryApi } from "../../lib/api/inventory";
import { formatDate } from "../../lib/format";
import { formatPaise } from "../../lib/format";
import { canDo } from "../../lib/session";
import { useCursorPaging, useDebounced } from "../../lib/use-cursor";
import { Loadable } from "../common";
import {
  BranchSelect,
  type TabProps,
  expiryBadge,
  formatQty,
  formatUnitCost,
  qtyWithUnit,
  useItemDirectory,
  useScopedBranches,
} from "./bits";

const EXPIRY_WINDOW_DAYS = 30;

/** Stock overview per branch: balances with low-stock and expiring-soon badges, search and filters. */
export function StockTab({ rev, openDialog }: TabProps) {
  const { name: branchName } = useScopedBranches();
  const dir = useItemDirectory(rev);
  const [branchId, setBranchId] = useState("");
  const [q, setQ] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const dq = useDebounced(q.trim());
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [branchId, dq, lowOnly]);
  const [batchesFor, setBatchesFor] = useState<StockBalanceResponse | null>(null);

  const list = useQuery(
    () =>
      (lowOnly ? inventoryApi.reports.lowStock : inventoryApi.reports.balances)({
        branchId: branchId || undefined,
        q: dq || undefined,
        cursor: paging.cursor,
        limit: 25,
      }),
    [branchId, dq, lowOnly, paging.cursor, rev],
  );
  const low = useQuery(
    () => inventoryApi.reports.lowStock({ branchId: branchId || undefined, limit: 100 }),
    [branchId, rev],
  );
  const expiring = useQuery(
    () =>
      inventoryApi.reports.expiring({
        branchId: branchId || undefined,
        withinDays: EXPIRY_WINDOW_DAYS,
        limit: 500,
      }),
    [branchId, rev],
  );

  /** Soonest expiry per (branch, item): drives the row badge. */
  const soonest = new Map<string, number>();
  for (const b of expiring.data?.items ?? []) {
    const key = `${b.branchId}|${b.itemId}`;
    const cur = soonest.get(key);
    if (cur === undefined || b.daysToExpiry < cur) soonest.set(key, b.daysToExpiry);
  }
  const expiredCount = (expiring.data?.items ?? []).filter((b) => b.expired).length;
  const lowCount = low.data ? `${low.data.items.length}${low.data.nextCursor ? "+" : ""}` : "—";

  const columns: ColumnDef<StockBalanceResponse, unknown>[] = [
    {
      id: "item",
      header: "Item",
      accessorFn: (r) => r.name,
      cell: ({ row }) => (
        <div>
          <div>{row.original.name}</div>
          <div className="dos-muted dos-mono" style={{ fontSize: "var(--text-xs)" }}>
            {row.original.sku}
          </div>
        </div>
      ),
    },
    { id: "branch", header: "Branch", accessorFn: (r) => branchName(r.branchId) },
    {
      id: "qty",
      header: "On hand",
      accessorFn: (r) => r.quantity,
      cell: ({ row }) => (
        <span className="dos-num">{qtyWithUnit(row.original.quantity, row.original.unit)}</span>
      ),
    },
    {
      id: "reorder",
      header: "Reorder at",
      accessorFn: (r) => r.reorderLevel,
      cell: ({ row }) => (
        <span className="dos-num">
          {row.original.reorderLevel > 0 ? formatQty(row.original.reorderLevel) : "—"}
        </span>
      ),
    },
    {
      id: "avg",
      header: "Avg cost",
      accessorFn: (r) => r.avgUnitCostPaise,
      cell: ({ row }) => (
        <span className="dos-num">{formatUnitCost(row.original.avgUnitCostPaise)}</span>
      ),
    },
    {
      id: "value",
      header: "Value",
      accessorFn: (r) => r.valuePaise,
      cell: ({ row }) => <span className="dos-num">{formatPaise(row.original.valuePaise)}</span>,
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        const days = soonest.get(`${r.branchId}|${r.itemId}`);
        const exp = days === undefined ? null : expiryBadge(days);
        return (
          <div className="dos-cluster">
            {r.quantity <= 0 ? (
              <Badge tone="danger">Out of stock</Badge>
            ) : r.low ? (
              <Badge tone="warning">Low stock</Badge>
            ) : (
              <Badge tone="success">OK</Badge>
            )}
            {exp ? <Badge tone={exp.tone}>{exp.label}</Badge> : null}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        const scope = { branchId: r.branchId };
        const preset = { branchId: r.branchId, itemId: r.itemId };
        const tracked = dir.byId(r.itemId)?.tracksBatches;
        return (
          <div className="dos-cluster">
            {tracked ? (
              <Button size="sm" variant="ghost" onClick={() => setBatchesFor(r)}>
                Batches<span className="dos-sr-only"> of {r.name}</span>
              </Button>
            ) : null}
            {canDo("inventory:write", scope) ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => openDialog({ kind: "consume", preset })}
              >
                Use<span className="dos-sr-only"> {r.name}</span>
              </Button>
            ) : null}
            {canDo("inventory:adjust", scope) ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openDialog({ kind: "adjust", preset })}
                >
                  Adjust<span className="dos-sr-only"> {r.name}</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openDialog({ kind: "waste", preset })}
                >
                  Waste<span className="dos-sr-only"> {r.name}</span>
                </Button>
              </>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="dos-stack">
      <StatGrid>
        <StatCard
          label="Low-stock items"
          value={lowCount}
          hint="At or below the reorder level"
          loading={low.loading && !low.data}
        />
        <StatCard
          label={`Batches expiring in ${EXPIRY_WINDOW_DAYS} days`}
          value={expiring.data ? expiring.data.items.length : "—"}
          hint="Includes already expired"
          loading={expiring.loading && !expiring.data}
        />
        <StatCard
          label="Expired batches with stock"
          value={expiring.data ? expiredCount : "—"}
          hint="Record as waste"
          loading={expiring.loading && !expiring.data}
        />
      </StatGrid>
      <search className="dos-toolbar" aria-label="Filter stock">
        <div className="dos-field">
          <label className="dos-label" htmlFor="stock-search">
            Search
          </label>
          <div className="dos-input-wrap">
            <Search size={16} aria-hidden="true" />
            <Input
              id="stock-search"
              type="search"
              placeholder="Item name or SKU"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <BranchSelect
          label="Branch"
          value={branchId}
          onChange={setBranchId}
          allLabel="All my branches"
        />
        <div className="dos-field">
          <span className="dos-label">Show</span>
          <Button
            variant={lowOnly ? "primary" : "secondary"}
            aria-pressed={lowOnly}
            onClick={() => setLowOnly((v) => !v)}
          >
            Low stock only
          </Button>
        </div>
      </search>
      <div>
        <DataTable
          caption="Stock on hand by branch"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(r) => `${r.branchId}|${r.itemId}`}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle={lowOnly ? "Nothing is running low" : "No stock yet"}
          emptyDescription={lowOnly ? undefined : "Receive stock to start tracking balances."}
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
      {batchesFor ? (
        <BatchesDrawer
          row={batchesFor}
          branchName={branchName(batchesFor.branchId)}
          onClose={() => setBatchesFor(null)}
        />
      ) : null}
    </div>
  );
}

/** Batches with stock for one item at a branch, first-expiry-first-out order. */
function BatchesDrawer({
  row,
  branchName,
  onClose,
}: { row: StockBalanceResponse; branchName: string; onClose: () => void }) {
  const q = useQuery(
    () => inventoryApi.reports.batches({ branchId: row.branchId, itemId: row.itemId }),
    [row.branchId, row.itemId],
  );
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Batches: ${row.name}`}
      description={`${branchName} · listed first-expiry-first-out (the order stock is used)`}
    >
      <Loadable state={q}>
        {(batches) =>
          batches.length === 0 ? (
            <p className="dos-muted">No batch has stock left at this branch.</p>
          ) : (
            <div className="dos-table-scroll">
              <table className="dos-table">
                <caption className="dos-sr-only">Batches in stock</caption>
                <thead>
                  <tr>
                    <th scope="col">Batch</th>
                    <th scope="col">Expiry</th>
                    <th scope="col">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.batchNo ?? "none"}>
                      <td className="dos-mono">{b.batchNo ?? "—"}</td>
                      <td>{formatDate(b.expiryDate)}</td>
                      <td className="dos-num">{qtyWithUnit(b.quantity, row.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loadable>
    </Drawer>
  );
}
