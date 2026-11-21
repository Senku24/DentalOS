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
  TextareaField,
} from "@dentalos/ui";
import {
  type SupplierResponse,
  createSupplierRequest,
  updateSupplierRequest,
} from "@dentalos/validation";
import { Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { inventoryApi } from "../../lib/api/inventory";
import { formatPhone } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import { canDo } from "../../lib/session";
import { useCursorPaging, useDebounced } from "../../lib/use-cursor";
import type { TabProps } from "./bits";

type Field = "name" | "contactName" | "phone" | "email" | "gstin" | "address" | "notes";
const FIELDS: Field[] = ["name", "contactName", "phone", "email", "gstin", "address", "notes"];

export function SuppliersTab({ rev }: TabProps) {
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
      inventoryApi.suppliers.list({
        q: dq || undefined,
        active: active === "" ? undefined : active === "true",
        cursor: paging.cursor,
        limit: 25,
      }),
    [dq, active, paging.cursor, rev, local],
  );
  const [editing, setEditing] = useState<SupplierResponse | "new" | null>(null);

  const columns: ColumnDef<SupplierResponse, unknown>[] = [
    { accessorKey: "name", header: "Supplier" },
    {
      accessorKey: "contactName",
      header: "Contact",
      cell: ({ getValue }) => (getValue() as string) ?? "—",
    },
    {
      id: "phone",
      header: "Phone",
      accessorFn: (s) => s.phone,
      cell: ({ row }) => formatPhone(row.original.phone),
    },
    {
      accessorKey: "email",
      header: "Email",
      cell: ({ getValue }) => (getValue() as string) ?? "—",
    },
    {
      accessorKey: "gstin",
      header: "GSTIN",
      cell: ({ getValue }) => <span className="dos-mono">{(getValue() as string) ?? "—"}</span>,
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (s) => (s.active ? "Active" : "Inactive"),
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
            cell: ({ row }: { row: { original: SupplierResponse } }) => (
              <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>
                Edit<span className="dos-sr-only"> {row.original.name}</span>
              </Button>
            ),
          } satisfies ColumnDef<SupplierResponse, unknown>,
        ]
      : []),
  ];

  return (
    <div className="dos-stack">
      <search className="dos-toolbar" aria-label="Filter suppliers">
        <div className="dos-field">
          <label className="dos-label" htmlFor="sup-search">
            Search
          </label>
          <div className="dos-input-wrap">
            <Search size={16} aria-hidden="true" />
            <Input
              id="sup-search"
              type="search"
              placeholder="Supplier name"
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
              <Plus size={16} aria-hidden="true" /> New supplier
            </Button>
          </div>
        ) : null}
      </search>
      <div>
        <DataTable
          caption="Suppliers"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(s) => s.id}
          loading={list.loading && !list.data}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No suppliers"
          emptyDescription="Add the vendors you buy from so receipts can name them."
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
        <SupplierDrawer
          supplier={editing === "new" ? null : editing}
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

function SupplierDrawer({
  supplier,
  onClose,
  onSaved,
}: { supplier: SupplierResponse | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Record<Field, string>>(
    () => Object.fromEntries(FIELDS.map((k) => [k, supplier?.[k] ?? ""])) as Record<Field, string>,
  );
  const [active, setActive] = useState(supplier?.active ?? true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (body: unknown) =>
      supplier
        ? inventoryApi.suppliers.update(supplier.id, body as never)
        : inventoryApi.suppliers.create(body as never),
    {
      success: supplier ? "Supplier updated" : "Supplier added",
      onSuccess: onSaved,
      onError: (e) => setErrors(e.fieldErrors),
    },
  );
  const f = (k: Field) => ({
    value: v[k],
    onChange: (e: { target: { value: string } }) => {
      setV({ ...v, [k]: e.target.value });
      setErrors(({ [k]: _, ...rest }) => rest);
    },
    error: errors[k],
  });

  const submit = () => {
    if (!supplier) {
      const r = validate(createSupplierRequest, v);
      if (!r.ok) return setErrors(r.errors);
      return void save.run(r.data);
    }
    // PATCH: a blank optional field clears it (explicit null), unchanged fields are left out.
    const raw: Record<string, unknown> = { active };
    for (const k of FIELDS) {
      const was = supplier[k] ?? "";
      if (v[k].trim() === was) continue;
      raw[k] = v[k].trim() === "" ? null : v[k];
    }
    if (raw.name === null) return setErrors({ name: "Required" });
    const r = validate(updateSupplierRequest, raw);
    if (!r.ok) return setErrors(r.errors);
    const body = { ...r.data } as Record<string, unknown>;
    if (active === supplier.active) body.active = undefined;
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    if (Object.keys(body).length === 0) return onClose();
    void save.run(body);
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={supplier ? `Edit ${supplier.name}` : "New supplier"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            {supplier ? "Save changes" : "Add supplier"}
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
        <TextField label="Name" required {...f("name")} />
        <div className="dos-form-grid">
          <TextField label="Contact person" {...f("contactName")} />
          <TextField label="Phone" type="tel" inputMode="tel" {...f("phone")} />
          <TextField label="Email" type="email" {...f("email")} />
          <TextField label="GSTIN" hint="15 characters" autoComplete="off" {...f("gstin")} />
        </div>
        <TextareaField label="Address" {...f("address")} />
        <TextareaField label="Notes" {...f("notes")} />
        {supplier ? (
          <Checkbox
            label="Active"
            hint="Inactive suppliers can't be chosen on new receipts."
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
        ) : null}
      </form>
    </Drawer>
  );
}
