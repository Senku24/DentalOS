"use client";
import {
  Badge,
  Button,
  Checkbox,
  type ColumnDef,
  CursorPager,
  DataTable,
  Drawer,
  Input,
  SelectField,
  TextField,
} from "@dentalos/ui";
import {
  COSTING_METHODS,
  INVENTORY_UNITS,
  type InventoryItemResponse,
  type InventoryUnit,
  createInventoryItemRequest,
  updateInventoryItemRequest,
} from "@dentalos/validation";
import { Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { inventoryApi } from "../../lib/api/inventory";
import { humanize } from "../../lib/format";
import { type FieldErrors, changedFields, validate } from "../../lib/forms";
import { canDo } from "../../lib/session";
import { useCursorPaging, useDebounced } from "../../lib/use-cursor";
import { type TabProps, formatQty, num, unitLabel } from "./bits";

/** Items CRUD: SKU, unit, reorder level, costing, batch tracking and overdraw. Items are deactivated, never deleted. */
export function ItemsTab({ rev }: TabProps) {
  const writable = canDo("inventory:write");
  const [q, setQ] = useState("");
  const [active, setActive] = useState("true");
  const dq = useDebounced(q.trim());
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [dq, active]);
  const [local, setLocal] = useState(0);
  const list = useQuery(
    () =>
      inventoryApi.items.list({
        q: dq || undefined,
        active: active === "" ? undefined : active === "true",
        cursor: paging.cursor,
        limit: 25,
      }),
    [dq, active, paging.cursor, rev, local],
  );
  const [editing, setEditing] = useState<InventoryItemResponse | "new" | null>(null);

  const columns: ColumnDef<InventoryItemResponse, unknown>[] = [
    {
      id: "item",
      header: "Item",
      accessorFn: (i) => i.name,
      cell: ({ row }) => (
        <div>
          <div>{row.original.name}</div>
          <div className="dos-muted dos-mono" style={{ fontSize: "var(--text-xs)" }}>
            {row.original.sku}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "category",
      header: "Category",
      cell: ({ getValue }) => (getValue() as string) ?? "—",
    },
    {
      id: "unit",
      header: "Unit",
      accessorFn: (i) => i.unit,
      cell: ({ row }) => humanize(row.original.unit),
    },
    {
      id: "reorder",
      header: "Reorder at",
      accessorFn: (i) => i.reorderLevel,
      cell: ({ row }) => (
        <span className="dos-num">
          {row.original.reorderLevel > 0 ? formatQty(row.original.reorderLevel) : "—"}
        </span>
      ),
    },
    {
      id: "flags",
      header: "Rules",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="dos-cluster">
          {row.original.tracksBatches ? <Badge tone="info">Batches + expiry</Badge> : null}
          {row.original.allowOverdraw ? <Badge tone="warning">Overdraw allowed</Badge> : null}
          {!row.original.tracksBatches && !row.original.allowOverdraw ? "—" : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (i) => (i.active ? "Active" : "Inactive"),
      cell: ({ row }) => (
        <Badge tone={row.original.active ? "success" : "neutral"}>
          {row.original.active ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    ...(writable
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: InventoryItemResponse } }) => (
              <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>
                Edit<span className="dos-sr-only"> {row.original.name}</span>
              </Button>
            ),
          } satisfies ColumnDef<InventoryItemResponse, unknown>,
        ]
      : []),
  ];

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter items">
        <div className="dos-field">
          <label className="dos-label" htmlFor="item-search">
            Search
          </label>
          <div className="dos-input-wrap">
            <Search size={16} aria-hidden="true" />
            <Input
              id="item-search"
              type="search"
              placeholder="Name or SKU"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <SelectField label="Status" value={active} onChange={(e) => setActive(e.target.value)}>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
          <option value="">All</option>
        </SelectField>
        {writable ? (
          <div className="dos-field">
            <span className="dos-label">&nbsp;</span>
            <Button onClick={() => setEditing("new")}>
              <Plus size={16} aria-hidden="true" /> New item
            </Button>
          </div>
        ) : null}
      </search>
      <div>
        <DataTable
          caption="Inventory items"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(i) => i.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No items"
          emptyDescription="Add the consumables and materials the clinic stocks."
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
      {editing ? (
        <ItemDrawer
          item={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setLocal((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

interface FormState {
  sku: string;
  name: string;
  category: string;
  unit: InventoryUnit;
  reorderLevel: string;
  tracksBatches: boolean;
  allowOverdraw: boolean;
  active: boolean;
}

function ItemDrawer({
  item,
  onClose,
  onSaved,
}: { item: InventoryItemResponse | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<FormState>({
    sku: item?.sku ?? "",
    name: item?.name ?? "",
    category: item?.category ?? "",
    unit: item?.unit ?? "PIECE",
    reorderLevel: item ? String(item.reorderLevel) : "0",
    tracksBatches: item?.tracksBatches ?? false,
    allowOverdraw: item?.allowOverdraw ?? false,
    active: item?.active ?? true,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (body: unknown) =>
      item
        ? inventoryApi.items.update(item.id, body as never)
        : inventoryApi.items.create(body as never),
    {
      success: item ? "Item updated" : "Item added",
      onSuccess: onSaved,
      onError: (e) => setErrors(e.fieldErrors),
    },
  );
  const f = <K extends keyof FormState>(k: K) => ({
    value: v[k] as string,
    onChange: (e: { target: { value: string } }) => {
      setV({ ...v, [k]: e.target.value });
      setErrors(({ [k]: _, ...rest }) => rest);
    },
    error: errors[k],
  });

  const submit = () => {
    if (!item) {
      const r = validate(createInventoryItemRequest, {
        sku: v.sku,
        name: v.name,
        category: v.category,
        unit: v.unit,
        reorderLevel: num(v.reorderLevel),
        tracksBatches: v.tracksBatches,
        allowOverdraw: v.allowOverdraw,
      });
      if (!r.ok) return setErrors(r.errors);
      return void save.run(r.data);
    }
    const r = validate(updateInventoryItemRequest, {
      name: v.name,
      // Blank clears the category; the API only clears it on an explicit null.
      category: v.category.trim() === "" ? (item.category === null ? undefined : null) : v.category,
      reorderLevel: num(v.reorderLevel),
      tracksBatches: v.tracksBatches,
      allowOverdraw: v.allowOverdraw,
      active: v.active,
    });
    if (!r.ok) return setErrors(r.errors);
    const body = changedFields(r.data, item as unknown as Record<string, unknown>);
    if (Object.keys(body).length === 0) return onClose();
    void save.run(body);
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? `Edit ${item.name}` : "New item"}
      description={
        item ? "SKU and unit are fixed once an item exists." : "Add something the clinic stocks."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            {item ? "Save changes" : "Add item"}
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
        {item ? (
          <TextField label="SKU" value={item.sku} readOnly hint="Fixed once the item exists." />
        ) : (
          <TextField
            label="SKU"
            required
            autoComplete="off"
            hint="2-40 characters: letters, digits, . _ or -. Stored in capitals."
            {...f("sku")}
          />
        )}
        <TextField label="Name" required {...f("name")} />
        <TextField
          label="Category"
          hint="For example Consumables, Anaesthesia, Endodontics."
          {...f("category")}
        />
        <div className="dos-form-grid">
          {item ? (
            <TextField label="Unit" value={humanize(item.unit)} readOnly />
          ) : (
            <SelectField label="Unit" required {...f("unit")}>
              {INVENTORY_UNITS.map((u) => (
                <option key={u} value={u}>
                  {humanize(u)} ({unitLabel(u)})
                </option>
              ))}
            </SelectField>
          )}
          <TextField
            label="Reorder level"
            inputMode="decimal"
            hint="Low-stock alert at or below this quantity, per branch. 0 turns the alert off."
            {...f("reorderLevel")}
          />
          <TextField
            label="Costing"
            value={humanize(COSTING_METHODS[0])}
            readOnly
            hint="Cost per unit is a weighted average of receipts."
          />
        </div>
        <Checkbox
          label="Track batch number and expiry"
          hint="Receipts must record a batch and expiry date; stock is used first-expiry-first-out."
          checked={v.tracksBatches}
          onChange={(e) => setV({ ...v, tracksBatches: e.target.checked })}
        />
        <Checkbox
          label="Allow stock to go below zero"
          hint="Use for items that are issued before the delivery is booked. Otherwise usage beyond stock is refused."
          checked={v.allowOverdraw}
          onChange={(e) => setV({ ...v, allowOverdraw: e.target.checked })}
        />
        {item ? (
          <Checkbox
            label="Active"
            hint="Inactive items can't be received, used or transferred. History is kept."
            checked={v.active}
            onChange={(e) => setV({ ...v, active: e.target.checked })}
          />
        ) : null}
      </form>
    </Drawer>
  );
}
