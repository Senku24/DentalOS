"use client";
import {
  Badge,
  Button,
  Checkbox,
  type ColumnDef,
  ConfirmDialog,
  CursorPager,
  DataTable,
  Drawer,
  Input,
  PageHeader,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type ServiceCategoryResponse,
  type ServiceResponse,
  createServiceCategoryRequest,
  createServiceRequest,
  updateServiceRequest,
} from "@dentalos/validation";
import { Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Loadable, MockNotice, RequirePermission, Section } from "../../../components/common";
import { api } from "../../../lib/api/endpoints";
import { errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { formatPaise } from "../../../lib/format";
import { changedFields, paiseToRupeeInput, rupeesToPaise, validate } from "../../../lib/forms";
import { canDo } from "../../../lib/session";
import { useCursorPaging, useDebounced } from "../../../lib/use-cursor";

export function CatalogueClient() {
  return (
    <RequirePermission permission="catalog:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const manage = canDo("catalog:manage");
  const cats = useQuery(() => api.catalog.categories(), []);
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [active, setActive] = useState("true");
  const dq = useDebounced(q);
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: new filters restart paging
  useEffect(() => paging.reset(), [dq, categoryId, active]);
  const services = useQuery(
    () =>
      api.catalog.services({
        q: dq || undefined,
        categoryId: categoryId || undefined,
        active: active === "" ? undefined : active === "true",
        cursor: paging.cursor,
        limit: 25,
      }),
    [dq, categoryId, active, paging.cursor],
  );
  const [editing, setEditing] = useState<ServiceResponse | "new" | null>(null);
  const [toggling, setToggling] = useState<ServiceResponse | null>(null);
  const toggle = useMutation(
    (s: ServiceResponse) => api.catalog.setServiceActive(s.id, !s.active),
    {
      success: (s) => `${s.name} ${s.active ? "activated" : "deactivated"}`,
      onSuccess: () => {
        setToggling(null);
        services.reload();
      },
    },
  );
  const catName = (id: string | null) =>
    id ? (cats.data?.items.find((c) => c.id === id)?.name ?? "—") : "Uncategorised";

  const columns: ColumnDef<ServiceResponse, unknown>[] = [
    {
      accessorKey: "code",
      header: "Code",
      cell: ({ getValue }) => <span className="dos-mono">{String(getValue())}</span>,
    },
    { accessorKey: "name", header: "Service" },
    { id: "category", header: "Category", accessorFn: (s) => catName(s.categoryId) },
    { accessorKey: "durationMin", header: "Duration", cell: ({ getValue }) => `${getValue()} min` },
    {
      accessorKey: "basePricePaise",
      header: "Base price",
      cell: ({ row }) => (
        <span className="dos-num">
          {formatPaise(row.original.basePricePaise)}
          {row.original.taxable ? <span className="dos-muted"> + GST</span> : null}
        </span>
      ),
    },
    {
      accessorKey: "active",
      header: "Status",
      cell: ({ getValue }) =>
        getValue() ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
    },
    ...(manage
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: ServiceResponse } }) => (
              <div className="dos-cluster">
                <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>
                  Edit<span className="dos-sr-only"> {row.original.name}</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setToggling(row.original)}>
                  {row.original.active ? "Deactivate" : "Activate"}
                  <span className="dos-sr-only"> {row.original.name}</span>
                </Button>
              </div>
            ),
          } satisfies ColumnDef<ServiceResponse, unknown>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Service catalogue"
        description="Central list of procedures and base prices. Branches may override prices with an audited reason."
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Administration" },
          { label: "Service catalogue" },
        ]}
        actions={
          manage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus size={16} aria-hidden="true" /> New service
            </Button>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <div className="dos-split" style={{ gridTemplateColumns: "minmax(0, 3fr) minmax(0, 1fr)" }}>
          <div className="dos-stack">
            <div className="dos-toolbar">
              <div className="dos-field">
                <label className="dos-label" htmlFor="svc-search">
                  Search
                </label>
                <div className="dos-input-wrap">
                  <Search size={16} aria-hidden="true" />
                  <Input
                    id="svc-search"
                    type="search"
                    placeholder="Name or code"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
              </div>
              <SelectField
                label="Category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">All categories</option>
                {cats.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Status"
                value={active}
                onChange={(e) => setActive(e.target.value)}
              >
                <option value="true">Active</option>
                <option value="false">Inactive</option>
                <option value="">All</option>
              </SelectField>
            </div>
            <div>
              <DataTable
                caption="Services"
                columns={columns}
                data={services.data?.items ?? []}
                getRowId={(s) => s.id}
                loading={services.loading}
                error={services.error ? errorStateFor(services.error) : undefined}
                searchable={false}
                hidePagination
                pageSize={100}
                emptyTitle={dq ? "No services match" : "No services yet"}
                emptyDescription={
                  dq ? "Try a different name or code." : "Add the procedures your clinics offer."
                }
              />
              <CursorPager
                page={paging.page}
                hasPrev={paging.hasPrev}
                hasNext={Boolean(services.data?.nextCursor)}
                onPrev={paging.prev}
                onNext={() => paging.next(services.data?.nextCursor)}
                loading={services.loading}
                itemCount={services.data?.items.length}
              />
            </div>
          </div>
          <Section title="Categories">
            <Loadable state={cats}>
              {(d) => <Categories items={d.items} manage={manage} onChanged={cats.reload} />}
            </Loadable>
          </Section>
        </div>
      </div>

      {editing ? (
        <ServiceDrawer
          service={editing === "new" ? null : editing}
          categories={cats.data?.items ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            services.reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(o) => !o && setToggling(null)}
        title={toggling?.active ? `Deactivate ${toggling?.name}?` : `Activate ${toggling?.name}?`}
        description={
          toggling?.active
            ? "It will no longer be offered for new treatment plans or invoices. Existing records keep it."
            : "It becomes available for treatment plans and invoices again."
        }
        confirmLabel={toggling?.active ? "Deactivate" : "Activate"}
        tone={toggling?.active ? "danger" : "primary"}
        loading={toggle.pending}
        onConfirm={() => toggling && void toggle.run(toggling)}
      />
    </>
  );
}

function Categories({
  items,
  manage,
  onChanged,
}: {
  items: ServiceCategoryResponse[];
  manage: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState<ServiceCategoryResponse | null>(null);
  const create = useMutation(api.catalog.createCategory, {
    success: "Category added",
    onSuccess: () => {
      setName("");
      onChanged();
    },
  });
  const toggle = useMutation(
    (c: ServiceCategoryResponse) => api.catalog.updateCategory(c.id, { active: !c.active }),
    { onSuccess: onChanged },
  );
  const remove = useMutation((c: ServiceCategoryResponse) => api.catalog.deleteCategory(c.id), {
    success: "Category deleted",
    onSuccess: () => {
      setDeleting(null);
      onChanged();
    },
    onError: () => setDeleting(null),
  });
  return (
    <div className="dos-stack">
      <ul className="dos-stack" data-gap="sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((c) => (
          <li key={c.id} className="dos-cluster" style={{ justifyContent: "space-between" }}>
            <span>
              {c.name} {c.active ? null : <Badge tone="neutral">Inactive</Badge>}
            </span>
            {manage ? (
              <span className="dos-cluster">
                <Button size="sm" variant="ghost" onClick={() => void toggle.run(c)}>
                  {c.active ? "Deactivate" : "Activate"}
                  <span className="dos-sr-only"> {c.name}</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(c)}>
                  Delete<span className="dos-sr-only"> {c.name}</span>
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {manage ? (
        <form
          className="dos-stack"
          data-gap="sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const r = validate(createServiceCategoryRequest, {
              name,
              sortOrder: (items.length + 1) * 10,
            });
            if (!r.ok) return setError(r.errors.name);
            setError(undefined);
            void create.run(r.data);
          }}
        >
          <TextField
            label="New category"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={error}
          />
          <div>
            <Button type="submit" variant="secondary" size="sm" loading={create.pending}>
              Add category
            </Button>
          </div>
        </form>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Only empty categories can be deleted. Deactivate it instead if services still use it."
        confirmLabel="Delete category"
        tone="danger"
        loading={remove.pending}
        onConfirm={() => deleting && void remove.run(deleting)}
      />
    </div>
  );
}

function ServiceDrawer({
  service,
  categories,
  onClose,
  onSaved,
}: {
  service: ServiceResponse | null;
  categories: ServiceCategoryResponse[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [v, setV] = useState({
    code: service?.code ?? "",
    name: service?.name ?? "",
    description: service?.description ?? "",
    categoryId: service?.categoryId ?? "",
    durationMin: String(service?.durationMin ?? 30),
    price: service ? paiseToRupeeInput(service.basePricePaise) : "",
    taxable: service?.taxable ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    (b: ReturnType<typeof createServiceRequest.parse>) =>
      service
        ? api.catalog.updateService(service.id, {
            ...changedFields(b, service as unknown as Record<string, unknown>),
            // Clearing the category is an explicit change to null.
            ...(service.categoryId && !b.categoryId ? { categoryId: null } : {}),
          })
        : api.catalog.createService(b),
    {
      success: service ? "Service updated" : "Service created",
      onSuccess: onSaved,
      onError: (e) => setErrors(e.fieldErrors),
    },
  );
  const submit = () => {
    const paise = v.price.trim() === "" ? undefined : rupeesToPaise(v.price);
    if (paise === null)
      return setErrors({ basePricePaise: "Enter an amount in rupees, e.g. 1500 or 1500.50" });
    const schema = service ? updateServiceRequest : createServiceRequest;
    const r = validate(schema, {
      code: v.code,
      name: v.name,
      description: v.description,
      categoryId: v.categoryId,
      durationMin: Number(v.durationMin),
      basePricePaise: paise,
      taxable: v.taxable,
    });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data as ReturnType<typeof createServiceRequest.parse>);
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={service ? `Edit ${service.name}` : "New service"}
      description="Prices are entered in rupees and stored exactly in paise."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            {service ? "Save changes" : "Create service"}
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
          <TextField
            label="Code"
            required
            hint="Letters, digits, _ or -"
            value={v.code}
            onChange={(e) => setV({ ...v, code: e.target.value })}
            error={errors.code}
          />
          <TextField
            label="Duration (minutes)"
            type="number"
            min={5}
            max={600}
            step={5}
            required
            value={v.durationMin}
            onChange={(e) => setV({ ...v, durationMin: e.target.value })}
            error={errors.durationMin}
          />
        </div>
        <TextField
          label="Name"
          required
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
          error={errors.name}
        />
        <SelectField
          label="Category"
          value={v.categoryId}
          onChange={(e) => setV({ ...v, categoryId: e.target.value })}
          error={errors.categoryId}
        >
          <option value="">Uncategorised</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Base price (₹)"
          inputMode="decimal"
          required
          hint={
            v.price && rupeesToPaise(v.price) !== null
              ? `Will be shown as ${formatPaise(rupeesToPaise(v.price))}`
              : "Central price used unless a branch overrides it"
          }
          value={v.price}
          onChange={(e) => setV({ ...v, price: e.target.value })}
          error={errors.basePricePaise}
        />
        <Checkbox
          label="Taxable (GST applies)"
          checked={v.taxable}
          onChange={(e) => setV({ ...v, taxable: e.target.checked })}
        />
        <TextareaField
          label="Description"
          value={v.description}
          onChange={(e) => setV({ ...v, description: e.target.value })}
          error={errors.description}
        />
      </form>
    </Drawer>
  );
}
