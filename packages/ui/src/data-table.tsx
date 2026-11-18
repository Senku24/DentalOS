"use client";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "./button";
import { EmptyState, ErrorState, Skeleton } from "./feedback";

export type { ColumnDef };

export interface DataTableProps<T> {
  /** Required accessible name of the table. */
  caption: string;
  columns: ColumnDef<T, unknown>[];
  data: T[];
  getRowId?: (row: T, index: number) => string;
  loading?: boolean;
  /** When set, replaces the table body with an announced error state. */
  error?: { title: string; description?: string; action?: ReactNode };
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  pageSize?: number;
  /** Adds a client-side search box over all columns. Server-driven tables will replace this in M1. */
  searchable?: boolean;
  searchLabel?: string;
  toolbarActions?: ReactNode;
}

export function DataTable<T>({
  caption,
  columns,
  data,
  getRowId,
  loading,
  error,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyAction,
  pageSize = 10,
  searchable = true,
  searchLabel = "Search table",
  toolbarActions,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState("");
  const statusId = useId();
  const table = useReactTable({
    data,
    columns,
    getRowId,
    sortDescFirst: false, // first click is always ascending, including numeric columns
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const total = table.getFilteredRowModel().rows.length;
  const { pageIndex, pageSize: size } = table.getState().pagination;
  const from = total === 0 ? 0 : pageIndex * size + 1;
  const to = Math.min(total, (pageIndex + 1) * size);
  const rows = table.getRowModel().rows;
  const colCount = table.getVisibleLeafColumns().length;

  return (
    <div className="dos-table-card">
      {searchable || toolbarActions ? (
        <div className="dos-table-toolbar">
          {searchable ? (
            <div className="dos-input-wrap">
              <Search size={16} aria-hidden="true" />
              <input
                className="dos-input"
                type="search"
                aria-label={searchLabel}
                placeholder="Search…"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  table.setPageIndex(0);
                }}
              />
            </div>
          ) : (
            <span />
          )}
          {toolbarActions}
        </div>
      ) : null}

      {error ? (
        <ErrorState {...error} />
      ) : (
        <div className="dos-table-scroll">
          <table className="dos-table" aria-busy={loading ? true : undefined}>
            <caption className="dos-sr-only">{caption}</caption>
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const sorted = h.column.getIsSorted();
                    const canSort = h.column.getCanSort();
                    return (
                      <th
                        key={h.id}
                        scope="col"
                        aria-sort={
                          sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : undefined
                        }
                      >
                        {h.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            className="dos-th-btn"
                            onClick={h.column.getToggleSortingHandler()}
                          >
                            {flexRender(h.column.columnDef.header, h.getContext())}
                            {sorted === "asc" ? (
                              <ArrowUp size={14} aria-hidden="true" />
                            ) : sorted === "desc" ? (
                              <ArrowDown size={14} aria-hidden="true" />
                            ) : (
                              <ArrowUpDown size={14} aria-hidden="true" />
                            )}
                          </button>
                        ) : (
                          flexRender(h.column.columnDef.header, h.getContext())
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: Math.min(size, 5) }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
                    <tr key={i}>
                      {Array.from({ length: colCount }, (_, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
                        <td key={j}>
                          <Skeleton width="80%" />
                        </td>
                      ))}
                    </tr>
                  ))
                : rows.map((r) => (
                    <tr key={r.id}>
                      {r.getVisibleCells().map((c) => (
                        <td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>
                      ))}
                    </tr>
                  ))}
            </tbody>
          </table>
          {!loading && rows.length === 0 ? (
            <EmptyState
              title={filter ? "No matching results" : emptyTitle}
              description={filter ? "Try a different search term." : emptyDescription}
              action={filter ? undefined : emptyAction}
            />
          ) : null}
        </div>
      )}

      {!error ? (
        <div className="dos-pagination">
          <output id={statusId}>
            {loading ? "Loading…" : `Showing ${from}–${to} of ${total}`}
          </output>
          <div className="dos-pagination__nav">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              aria-describedby={statusId}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              aria-describedby={statusId}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
