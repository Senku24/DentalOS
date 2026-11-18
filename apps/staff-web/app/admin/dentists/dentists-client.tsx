"use client";
import {
  Alert,
  Badge,
  Button,
  type ColumnDef,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  PageHeader,
  SelectField,
  TextField,
  Timeline,
} from "@dentalos/ui";
import {
  type DentistAssignmentResponse,
  assignDentistRequest,
  transferDentistRequest,
} from "@dentalos/validation";
import { ArrowRightLeft, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import {
  BranchOptions,
  Loadable,
  MockNotice,
  RequirePermission,
  useBranches,
} from "../../../components/common";
import { api } from "../../../lib/api/endpoints";
import { errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { formatDate, todayISO } from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { canDo, userLabel } from "../../../lib/session";

const isCurrent = (a: DentistAssignmentResponse, today = todayISO()) =>
  a.effectiveFrom <= today && (a.effectiveTo === null || a.effectiveTo > today);
const isUpcoming = (a: DentistAssignmentResponse, today = todayISO()) => a.effectiveFrom > today;

export function DentistsClient() {
  return (
    <RequirePermission permission="staff:read">
      <Inner />
    </RequirePermission>
  );
}

interface DentistRow {
  userId: string;
  current: DentistAssignmentResponse[];
  upcoming: DentistAssignmentResponse[];
}

function Inner() {
  const manage = canDo("staff:manage");
  const { branches, name: branchName } = useBranches();
  const [branchFilter, setBranchFilter] = useState("");
  const dentists = useQuery(() => api.staff.list({ role: "DENTIST" }), []);
  const assignments = useQuery(
    () => api.dentists.list({ status: "all", branchId: branchFilter || undefined }),
    [branchFilter],
  );
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [transferFor, setTransferFor] = useState<DentistRow | null>(null);
  const [assignFor, setAssignFor] = useState<string | null | "pick">(null);

  const rows: DentistRow[] = useMemo(() => {
    const all = assignments.data?.items ?? [];
    const ids = new Set([
      ...(dentists.data?.items.map((d) => d.userId) ?? []),
      ...all.map((a) => a.userId),
    ]);
    return [...ids]
      .map((userId) => ({
        userId,
        current: all.filter((a) => a.userId === userId && isCurrent(a)),
        upcoming: all.filter((a) => a.userId === userId && isUpcoming(a)),
      }))
      .filter((r) => !branchFilter || r.current.length || r.upcoming.length)
      .sort((a, b) => userLabel(a.userId).localeCompare(userLabel(b.userId)));
  }, [assignments.data, dentists.data, branchFilter]);

  const reload = () => {
    assignments.reload();
    dentists.reload();
  };

  const columns: ColumnDef<DentistRow, unknown>[] = [
    { id: "dentist", header: "Dentist", accessorFn: (r) => userLabel(r.userId) },
    {
      id: "current",
      header: "Current branches",
      accessorFn: (r) => r.current.map((a) => branchName(a.branchId)).join(", "),
      cell: ({ row }) =>
        row.original.current.length ? (
          <div className="dos-cluster">
            {row.original.current.map((a) => (
              <Badge key={a.id} tone="success">
                {branchName(a.branchId)} · since {formatDate(a.effectiveFrom)}
              </Badge>
            ))}
          </div>
        ) : (
          <Badge tone="warning">Unassigned</Badge>
        ),
    },
    {
      id: "upcoming",
      header: "Upcoming",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.upcoming.length
          ? row.original.upcoming
              .map((a) => `${branchName(a.branchId)} from ${formatDate(a.effectiveFrom)}`)
              .join("; ")
          : "—",
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        const who = userLabel(r.userId);
        return (
          <div className="dos-cluster">
            <Button size="sm" variant="ghost" onClick={() => setHistoryFor(r.userId)}>
              History<span className="dos-sr-only"> for {who}</span>
            </Button>
            {manage ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setAssignFor(r.userId)}>
                  Assign<span className="dos-sr-only"> {who} to a branch</span>
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={r.current.length === 0}
                  onClick={() => setTransferFor(r)}
                >
                  Transfer<span className="dos-sr-only"> {who}</span>
                </Button>
              </>
            ) : null}
          </div>
        );
      },
    },
  ];

  const error = assignments.error ?? dentists.error;
  return (
    <>
      <PageHeader
        title="Dentist assignments"
        description="Which branches each dentist works at, with full history"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Administration" },
          { label: "Dentist assignments" },
        ]}
        actions={
          manage ? (
            <Button onClick={() => setAssignFor("pick")}>
              <Plus size={16} aria-hidden="true" /> New assignment
            </Button>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        <Alert tone="info">
          Assignments and transfers are effective-dated. They change where a dentist can be booked
          from the effective date onward; past appointments, encounters and earnings keep their
          original branch.
        </Alert>
        <div className="dos-toolbar">
          <SelectField
            label="Branch"
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
          >
            <option value="">All branches</option>
            <BranchOptions branches={branches} includeInactive />
          </SelectField>
        </div>
        <DataTable
          caption="Dentist assignments"
          columns={columns}
          data={rows}
          getRowId={(r) => r.userId}
          loading={(assignments.loading || dentists.loading) && !assignments.data}
          error={error ? errorStateFor(error) : undefined}
          searchLabel="Search dentists"
          emptyTitle="No dentists found"
          emptyDescription="Give a staff member the Dentist role, then assign them to a branch."
        />
      </div>

      {historyFor ? (
        <HistoryDrawer
          userId={historyFor}
          branchName={branchName}
          onClose={() => setHistoryFor(null)}
        />
      ) : null}
      {transferFor ? (
        <TransferDialog
          row={transferFor}
          onClose={() => setTransferFor(null)}
          onDone={() => {
            setTransferFor(null);
            reload();
          }}
        />
      ) : null}
      {assignFor ? (
        <AssignDialog
          userId={assignFor === "pick" ? null : assignFor}
          dentistIds={dentists.data?.items.map((d) => d.userId) ?? []}
          onClose={() => setAssignFor(null)}
          onDone={() => {
            setAssignFor(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function HistoryDrawer({
  userId,
  branchName,
  onClose,
}: {
  userId: string;
  branchName: (id: string) => string;
  onClose: () => void;
}) {
  const manage = canDo("staff:manage");
  const q = useQuery(() => api.dentists.list({ userId, status: "all" }), [userId]);
  const end = useMutation((a: DentistAssignmentResponse) => api.dentists.end(a.id, todayISO()), {
    success: "Assignment ended",
    onSuccess: q.reload,
  });
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Assignment history — ${userLabel(userId)}`}
    >
      <Loadable state={q}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title="No assignments yet" />
          ) : (
            <Timeline
              label="Assignment history, newest first"
              items={[...d.items]
                .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
                .map((a) => {
                  const cur = isCurrent(a);
                  const up = isUpcoming(a);
                  return {
                    id: a.id,
                    current: cur,
                    tone: cur ? "success" : up ? "info" : "neutral",
                    title: (
                      <span className="dos-cluster">
                        {branchName(a.branchId)}
                        <Badge tone={cur ? "success" : up ? "info" : "neutral"}>
                          {cur ? "Current" : up ? "Upcoming" : "Ended"}
                        </Badge>
                      </span>
                    ),
                    meta: `${formatDate(a.effectiveFrom)} → ${a.effectiveTo ? formatDate(a.effectiveTo) : "ongoing"} · recorded by ${userLabel(a.createdBy)}`,
                    description:
                      manage && a.effectiveTo === null && cur ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={end.pending}
                          onClick={() => void end.run(a)}
                        >
                          End today
                        </Button>
                      ) : undefined,
                  };
                })}
            />
          )
        }
      </Loadable>
    </Drawer>
  );
}

function TransferDialog({
  row,
  onClose,
  onDone,
}: {
  row: DentistRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { branches, name } = useBranches();
  const [v, setV] = useState({
    fromBranchId: row.current[0]?.branchId ?? "",
    toBranchId: "",
    effectiveFrom: todayISO(),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const transfer = useMutation(api.dentists.transfer, {
    success: "Transfer scheduled",
    onSuccess: onDone,
    onError: (e) => setErrors(e.fieldErrors),
  });
  const submit = () => {
    const r = validate(transferDentistRequest, { userId: row.userId, ...v });
    if (!r.ok) return setErrors(r.errors);
    void transfer.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Transfer ${userLabel(row.userId)}`}
      description="Closes the current assignment and opens a new one on the same date."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={transfer.pending} onClick={submit}>
            <ArrowRightLeft size={16} aria-hidden="true" /> Transfer
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <Alert tone="warning">
          This affects future appointments only. Appointments, clinical records and earnings before
          the effective date stay attributed to{" "}
          {v.fromBranchId ? name(v.fromBranchId) : "the current branch"}.
        </Alert>
        <SelectField
          label="From branch"
          required
          value={v.fromBranchId}
          onChange={(e) => setV({ ...v, fromBranchId: e.target.value })}
          error={errors.fromBranchId}
        >
          {row.current.map((a) => (
            <option key={a.id} value={a.branchId}>
              {name(a.branchId)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="To branch"
          required
          value={v.toBranchId}
          onChange={(e) => setV({ ...v, toBranchId: e.target.value })}
          error={errors.toBranchId}
        >
          <option value="">Select a branch</option>
          <BranchOptions branches={branches.filter((b) => b.id !== v.fromBranchId)} />
        </SelectField>
        <TextField
          label="Effective from"
          type="date"
          required
          min={todayISO()}
          hint="Today or later. Back-dated transfers are not allowed."
          value={v.effectiveFrom}
          onChange={(e) => setV({ ...v, effectiveFrom: e.target.value })}
          error={errors.effectiveFrom}
        />
      </div>
    </Dialog>
  );
}

function AssignDialog({
  userId,
  dentistIds,
  onClose,
  onDone,
}: {
  userId: string | null;
  dentistIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { branches } = useBranches();
  const [v, setV] = useState({ userId: userId ?? "", branchId: "", effectiveFrom: todayISO() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const assign = useMutation(api.dentists.assign, {
    success: "Dentist assigned",
    onSuccess: onDone,
    onError: (e) => setErrors(e.fieldErrors),
  });
  const submit = () => {
    const r = validate(assignDentistRequest, v);
    if (!r.ok) return setErrors(r.errors);
    void assign.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Assign dentist to branch"
      description="Adds a branch without ending existing assignments."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={assign.pending} onClick={submit}>
            Assign
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <SelectField
          label="Dentist"
          required
          value={v.userId}
          disabled={userId !== null}
          onChange={(e) => setV({ ...v, userId: e.target.value })}
          error={errors.userId}
        >
          <option value="">Select a dentist</option>
          {dentistIds.map((id) => (
            <option key={id} value={id}>
              {userLabel(id)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Branch"
          required
          value={v.branchId}
          onChange={(e) => setV({ ...v, branchId: e.target.value })}
          error={errors.branchId}
        >
          <option value="">Select a branch</option>
          <BranchOptions branches={branches} />
        </SelectField>
        <TextField
          label="Effective from"
          type="date"
          required
          min={todayISO()}
          value={v.effectiveFrom}
          onChange={(e) => setV({ ...v, effectiveFrom: e.target.value })}
          error={errors.effectiveFrom}
        />
      </div>
    </Dialog>
  );
}
