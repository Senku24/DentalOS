"use client";
import {
  type BranchResponse,
  type WorkingHours,
  createBranchRequest,
  updateBranchRequest,
} from "@dentalos/validation";
import {
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Drawer,
  PageHeader,
  SelectField,
  TextField,
} from "@dentalos/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { MockNotice, RequirePermission, invalidateBranches } from "../../../components/common";
import { TIME_ZONES } from "../../../components/timezones";
import { WorkingHoursEditor, summariseHours } from "../../../components/working-hours-editor";
import { api } from "../../../lib/api/endpoints";
import { errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { formatPhone } from "../../../lib/format";
import { canDo } from "../../../lib/session";
import { useForm } from "../../../lib/use-form";

export function BranchesClient() {
  const manage = canDo("branch:manage");
  const list = useQuery(() => api.branches.list(), []);
  const [editing, setEditing] = useState<BranchResponse | "new" | null>(null);
  const [toggle, setToggle] = useState<BranchResponse | null>(null);
  const setActive = useMutation(
    (b: BranchResponse) => api.branches.setActive(b.id, !b.active),
    {
      success: (b) => `${b.name} ${b.active ? "activated" : "deactivated"}`,
      onSuccess: () => {
        setToggle(null);
        invalidateBranches();
        list.reload();
      },
    },
  );

  const columns: ColumnDef<BranchResponse, unknown>[] = [
    { accessorKey: "code", header: "Code", cell: ({ getValue }) => <span className="dos-mono">{String(getValue())}</span> },
    { accessorKey: "name", header: "Branch" },
    {
      id: "city",
      header: "Location",
      accessorFn: (b) => [b.city, b.state].filter(Boolean).join(", "),
    },
    { accessorKey: "phone", header: "Phone", enableSorting: false, cell: ({ getValue }) => formatPhone(getValue() as string | null) },
    {
      id: "hours",
      header: "Working hours",
      enableSorting: false,
      cell: ({ row }) => summariseHours(row.original.workingHours),
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
            cell: ({ row }: { row: { original: BranchResponse } }) => (
              <div className="dos-cluster">
                <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>
                  Edit<span className="dos-sr-only"> {row.original.name}</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setToggle(row.original)}>
                  {row.original.active ? "Deactivate" : "Activate"}
                  <span className="dos-sr-only"> {row.original.name}</span>
                </Button>
              </div>
            ),
          } satisfies ColumnDef<BranchResponse, unknown>,
        ]
      : []),
  ];

  return (
    <RequirePermission permission="branch:read">
      <PageHeader
        title="Branches"
        description="Clinic locations in your organisation"
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Administration" }, { label: "Branches" }]}
        actions={
          manage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus size={16} aria-hidden="true" /> New branch
            </Button>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <DataTable
          caption="Branches"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(b) => b.id}
          loading={list.loading && !list.data}
          error={list.error ? { ...errorStateFor(list.error), action: <Button variant="secondary" onClick={list.reload}>Try again</Button> } : undefined}
          emptyTitle="No branches yet"
          emptyDescription="Create your first branch to start registering patients."
          searchLabel="Search branches"
        />
      </div>

      {editing ? (
        <BranchDrawer
          branch={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidateBranches();
            list.reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={toggle !== null}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.active ? `Deactivate ${toggle?.name}?` : `Activate ${toggle?.name}?`}
        description={
          toggle?.active
            ? "The branch will stop accepting new appointments and registrations. Existing records and history are kept. You can reactivate it later."
            : "The branch becomes available for appointments, staff scope and pricing again."
        }
        confirmLabel={toggle?.active ? "Deactivate branch" : "Activate branch"}
        tone={toggle?.active ? "danger" : "primary"}
        loading={setActive.pending}
        onConfirm={() => toggle && void setActive.run(toggle)}
      />
    </RequirePermission>
  );
}

type FormValues = {
  code: string;
  name: string;
  phone: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  timezone: string;
  workingHours: WorkingHours;
};

function BranchDrawer({
  branch,
  onClose,
  onSaved,
}: {
  branch: BranchResponse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const f = useForm<typeof createBranchRequest, FormValues>(createBranchRequest, {
    code: branch?.code ?? "",
    name: branch?.name ?? "",
    phone: branch?.phone ?? "",
    email: branch?.email ?? "",
    addressLine1: branch?.addressLine1 ?? "",
    addressLine2: branch?.addressLine2 ?? "",
    city: branch?.city ?? "",
    state: branch?.state ?? "",
    postalCode: branch?.postalCode ?? "",
    timezone: branch?.timezone ?? "Asia/Kolkata",
    workingHours: branch?.workingHours ?? {},
  });
  const save = useMutation(
    (body: ReturnType<typeof createBranchRequest.parse>) =>
      branch ? api.branches.update(branch.id, updateBranchRequest.parse(body)) : api.branches.create(body),
    {
      success: branch ? "Branch updated" : "Branch created",
      onSuccess: onSaved,
      onError: f.applyServerErrors,
    },
  );
  const formId = "branch-form";

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={branch ? `Edit ${branch.name}` : "New branch"}
      description="Code is a short unique identifier used on invoices and reports."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.pending}>
            {branch ? "Save changes" : "Create branch"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={f.formRef}
        noValidate
        className="dos-stack"
        onSubmit={f.handleSubmit((d) => void save.run(d))}
      >
        <div className="dos-form-grid">
          <TextField label="Code" required hint="2–16 letters, digits or -" autoCapitalize="characters" {...f.field("code")} />
          <TextField label="Name" required {...f.field("name")} />
          <TextField label="Phone" type="tel" inputMode="tel" {...f.field("phone")} />
          <TextField label="Email" type="email" {...f.field("email")} />
          <TextField label="Address line 1" className="" {...f.field("addressLine1")} />
          <TextField label="Address line 2" {...f.field("addressLine2")} />
          <TextField label="City" {...f.field("city")} />
          <TextField label="State" {...f.field("state")} />
          <TextField label="PIN code" inputMode="numeric" {...f.field("postalCode")} />
          <SelectField label="Time zone" {...f.field("timezone")}>
            {TIME_ZONES.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </SelectField>
        </div>
        <WorkingHoursEditor
          value={f.values.workingHours}
          onChange={(wh) => f.set("workingHours", wh)}
          errors={f.errors}
        />
      </form>
    </Drawer>
  );
}
