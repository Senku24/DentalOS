"use client";
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
  useToast,
} from "@dentalos/ui";
import { type ChairResponse, createChairRequest, updateChairRequest } from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useState } from "react";
import { BranchOptions, MockNotice, RequirePermission } from "../../../components/common";
import { ProblemAlert } from "../../../components/scheduling/appointment-actions";
import { BranchGate } from "../../../components/scheduling/bits";
import { useFocusReturn, useSchedulingBranch } from "../../../components/scheduling/use-scheduling";
import { errorStateFor } from "../../../lib/api/errors";
import { useQuery } from "../../../lib/api/hooks";
import { schedulingApi } from "../../../lib/api/scheduling";
import { type SchedulingProblem, describeSchedulingError } from "../../../lib/api/scheduling-rules";
import { formatDate } from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { canDo } from "../../../lib/session";

/** Chairs per branch: create, rename / re-code, deactivate (never deleted: history keeps them). */
export function ChairsClient() {
  const sb = useSchedulingBranch();
  const { branchId } = sb;
  const manage = canDo("schedule:manage", { branchId });
  const list = useQuery(
    () => schedulingApi.chairs.list({ branchId }),
    [branchId],
    Boolean(branchId),
  );
  const { toast } = useToast();
  const [editing, setEditingState] = useState<ChairResponse | "new" | null>(null);
  const [toggle, setToggleState] = useState<ChairResponse | null>(null);
  // Drawer/confirm have no Radix trigger: return focus to the button that opened them.
  const focus = useFocusReturn();
  const setEditing = (v: ChairResponse | "new" | null) => {
    if (v) focus.remember();
    setEditingState(v);
    if (!v) focus.restore();
  };
  const setToggle = (v: ChairResponse | null) => {
    if (v) focus.remember();
    setToggleState(v);
    if (!v) focus.restore();
  };
  const [toggling, setToggling] = useState(false);

  const doToggle = async (c: ChairResponse) => {
    setToggling(true);
    try {
      const r = await schedulingApi.chairs.setActive(c.id, !c.active);
      toast({
        tone: "success",
        title: `Chair ${r.code} ${r.active ? "activated" : "deactivated"}`,
      });
      setToggle(null);
      list.reload();
    } catch (e) {
      const p = describeSchedulingError(e);
      toast({ tone: "danger", title: p.title, description: p.message });
    } finally {
      setToggling(false);
    }
  };

  const columns: ColumnDef<ChairResponse, unknown>[] = [
    {
      accessorKey: "code",
      header: "Code",
      cell: ({ getValue }) => <span className="dos-mono">{String(getValue())}</span>,
    },
    { accessorKey: "name", header: "Name" },
    {
      accessorKey: "active",
      header: "Status",
      cell: ({ getValue }) =>
        getValue() ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
    },
    {
      accessorKey: "createdAt",
      header: "Added",
      cell: ({ getValue }) => formatDate(String(getValue())),
    },
    ...(manage
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: ChairResponse } }) => (
              <div className="dos-cluster">
                <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>
                  Edit<span className="dos-sr-only"> chair {row.original.code}</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setToggle(row.original)}>
                  {row.original.active ? "Deactivate" : "Activate"}
                  <span className="dos-sr-only"> chair {row.original.code}</span>
                </Button>
              </div>
            ),
          } satisfies ColumnDef<ChairResponse, unknown>,
        ]
      : []),
  ];

  return (
    <RequirePermission permission="appointment:read">
      <PageHeader
        title="Chairs"
        description="Dental chairs (operatories) that appointments can be booked on"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Administration" },
          { label: "Chairs" },
        ]}
        actions={
          manage ? (
            <Button onClick={() => setEditing("new")} disabled={!branchId}>
              <Plus size={16} aria-hidden="true" /> New chair
            </Button>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <BranchGate sb={sb}>
          <div className="sch-filters">
            <SelectField
              label="Branch"
              value={branchId}
              onChange={(e) => sb.setBranchId(e.target.value)}
            >
              <BranchOptions branches={sb.branches} ids={sb.scoped} />
            </SelectField>
          </div>
          <div className="sch-table">
            <DataTable
              caption={`Chairs at ${sb.branch?.name ?? "the branch"}`}
              columns={columns}
              data={list.data?.items ?? []}
              getRowId={(c) => c.id}
              loading={list.loading && !list.data}
              error={
                list.error
                  ? {
                      ...errorStateFor(list.error),
                      action: (
                        <Button variant="secondary" onClick={list.reload}>
                          Try again
                        </Button>
                      ),
                    }
                  : undefined
              }
              emptyTitle="No chairs yet"
              emptyDescription="Add the branch's chairs so bookings can be placed on them."
              searchLabel="Search chairs"
            />
          </div>
        </BranchGate>
      </div>

      {editing ? (
        <ChairDrawer
          branchId={branchId}
          branchName={sb.branch?.name ?? "the branch"}
          chair={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={toggle !== null}
        onOpenChange={(o) => !o && setToggle(null)}
        title={
          toggle?.active ? `Deactivate chair ${toggle?.code}?` : `Activate chair ${toggle?.code}?`
        }
        description={
          toggle?.active
            ? "New bookings can no longer use this chair. Existing appointments on it are kept; move them to another chair if needed. You can reactivate it later."
            : "The chair becomes available for bookings again."
        }
        confirmLabel={toggle?.active ? "Deactivate chair" : "Activate chair"}
        tone={toggle?.active ? "danger" : "primary"}
        loading={toggling}
        onConfirm={() => toggle && void doToggle(toggle)}
      />
    </RequirePermission>
  );
}

function ChairDrawer({
  branchId,
  branchName,
  chair,
  onClose,
  onSaved,
}: {
  branchId: string;
  branchName: string;
  chair: ChairResponse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [code, setCode] = useState(chair?.code ?? "");
  const [name, setName] = useState(chair?.name ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<SchedulingProblem | null>(null);
  const [pending, setPending] = useState(false);
  const formId = "chair-form";

  const submit = async () => {
    const r = chair
      ? validate(updateChairRequest, { code, name })
      : validate(createChairRequest, { branchId, code, name });
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setProblem(null);
    setPending(true);
    try {
      if (chair) {
        const patch: { code?: string; name?: string } = {};
        const d = r.data as { code?: string; name?: string };
        if (d.code !== chair.code) patch.code = d.code;
        if (d.name !== chair.name) patch.name = d.name;
        if (Object.keys(patch).length) await schedulingApi.chairs.update(chair.id, patch);
      } else {
        await schedulingApi.chairs.create(
          r.data as { branchId: string; code: string; name: string },
        );
      }
      toast({ tone: "success", title: chair ? "Chair updated" : "Chair added" });
      onSaved();
    } catch (e) {
      const p = describeSchedulingError(e);
      if (p.fieldErrors && Object.keys(p.fieldErrors).length) setErrors(p.fieldErrors);
      else if (p.field === "code") setErrors({ code: p.message });
      else setProblem(p);
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={chair ? `Edit chair ${chair.code}` : "New chair"}
      description={`At ${branchName}. The code is unique within the branch and shown on the calendar.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {chair ? "Save changes" : "Add chair"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="dos-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ProblemAlert problem={problem} />
        <TextField
          label="Code"
          required
          hint="1–16 letters, digits, _ or -, e.g. C1"
          autoCapitalize="characters"
          maxLength={16}
          value={code}
          error={errors.code}
          onChange={(e) => setCode(e.target.value)}
        />
        <TextField
          label="Name"
          required
          maxLength={80}
          value={name}
          error={errors.name}
          onChange={(e) => setName(e.target.value)}
        />
      </form>
    </Drawer>
  );
}
