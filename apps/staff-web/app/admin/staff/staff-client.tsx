"use client";
import {
  type InvitationResponse,
  type StaffMemberResponse,
  createInvitationRequest,
  updateMembershipRequest,
} from "@dentalos/validation";
import {
  Alert,
  Badge,
  Button,
  type ColumnDef,
  ConfirmDialog,
  DataTable,
  Dialog,
  PageHeader,
  SelectField,
  Tabs,
  TextField,
} from "@dentalos/ui";
import { UserPlus } from "lucide-react";
import { useState } from "react";
import { AccessFields, type AccessValue } from "../../../components/access-fields";
import { MockNotice, RequirePermission, useBranches } from "../../../components/common";
import { api } from "../../../lib/api/endpoints";
import { errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import type { CreatedInvitation } from "../../../lib/api/types";
import { formatDate, humanize } from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { canDo, userEmail, userLabel } from "../../../lib/session";

export function StaffClient() {
  return (
    <RequirePermission permission="staff:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const manage = canDo("staff:manage");
  const { branches, name: branchName } = useBranches();
  const [tab, setTab] = useState("members");
  const [roleFilter, setRoleFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const staff = useQuery(
    () => api.staff.list({ role: roleFilter || undefined, branchId: branchFilter || undefined }),
    [roleFilter, branchFilter],
  );
  const invites = useQuery(() => api.invitations.list(), [], manage);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<StaffMemberResponse | null>(null);
  const [revoking, setRevoking] = useState<InvitationResponse | null>(null);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  const revoke = useMutation((i: InvitationResponse) => api.invitations.revoke(i.id), {
    success: "Invitation revoked",
    onSuccess: () => {
      setRevoking(null);
      invites.reload();
    },
  });
  const resend = useMutation((i: InvitationResponse) => api.invitations.resend(i.id), {
    success: (r) => `Invitation re-sent to ${r.email}`,
    onSuccess: (r) => {
      setCreated(r);
      invites.reload();
    },
  });

  const scopeText = (orgWide: boolean, scope: string[]) =>
    orgWide ? "All branches" : scope.map(branchName).join(", ") || "—";

  const memberCols: ColumnDef<StaffMemberResponse, unknown>[] = [
    {
      id: "name",
      header: "Name",
      accessorFn: (m) => userLabel(m.userId),
      cell: ({ row }) => (
        <div>
          <div>{userLabel(row.original.userId)}</div>
          <div className="dos-muted" style={{ fontSize: "var(--text-xs)" }}>
            {userEmail(row.original.userId) ?? row.original.userId}
          </div>
        </div>
      ),
    },
    {
      id: "roles",
      header: "Roles",
      accessorFn: (m) => m.roles.join(", "),
      cell: ({ row }) => (
        <div className="dos-cluster">
          {row.original.roles.map((r) => (
            <Badge key={r} tone={r === "OWNER" ? "brand" : "neutral"}>
              {humanize(r)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "scope",
      header: "Branch access",
      accessorFn: (m) => scopeText(m.orgWide, m.branchScope),
    },
    { accessorKey: "createdAt", header: "Member since", cell: ({ getValue }) => formatDate(getValue() as string) },
    ...(manage
      ? [
          {
            id: "actions",
            header: () => <span className="dos-sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }: { row: { original: StaffMemberResponse } }) => (
              <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>
                Edit access<span className="dos-sr-only"> for {userLabel(row.original.userId)}</span>
              </Button>
            ),
          } satisfies ColumnDef<StaffMemberResponse, unknown>,
        ]
      : []),
  ];

  const inviteCols: ColumnDef<InvitationResponse, unknown>[] = [
    { accessorKey: "email", header: "Email" },
    { id: "roles", header: "Roles", accessorFn: (i) => i.roles.map(humanize).join(", ") },
    { id: "scope", header: "Branch access", accessorFn: (i) => scopeText(i.orgWide, i.branchScope) },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ getValue }) => {
        const s = getValue() as string;
        const tone = s === "PENDING" ? "info" : s === "ACCEPTED" ? "success" : s === "EXPIRED" ? "warning" : "neutral";
        return <Badge tone={tone}>{humanize(s)}</Badge>;
      },
    },
    { accessorKey: "expiresAt", header: "Expires", cell: ({ getValue }) => formatDate(getValue() as string) },
    { id: "by", header: "Invited by", accessorFn: (i) => userLabel(i.invitedBy) },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const i = row.original;
        return (
          <div className="dos-cluster">
            {i.status === "PENDING" || i.status === "EXPIRED" ? (
              <Button size="sm" variant="secondary" loading={resend.pending} onClick={() => void resend.run(i)}>
                Resend<span className="dos-sr-only"> to {i.email}</span>
              </Button>
            ) : null}
            {i.status === "PENDING" ? (
              <Button size="sm" variant="ghost" onClick={() => setRevoking(i)}>
                Revoke<span className="dos-sr-only"> invitation for {i.email}</span>
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ];

  const pendingCount = invites.data?.items.filter((i) => i.status === "PENDING").length;

  return (
    <>
      <PageHeader
        title="Staff"
        description="Team members, their roles and which branches they can access"
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Administration" }, { label: "Staff" }]}
        actions={
          manage ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus size={16} aria-hidden="true" /> Invite staff
            </Button>
          ) : undefined
        }
      />
      <div className="dos-stack">
        <MockNotice />
        {created ? (
          <Alert tone="success">
            <div>
              Invitation ready for <strong>{created.email}</strong>.{" "}
              {created.acceptPath ? (
                <>
                  Share this one-time link (shown once): <span className="dos-mono">{created.acceptPath}</span>
                </>
              ) : (
                "They will receive an email with a sign-up link."
              )}
            </div>
          </Alert>
        ) : null}
        <Tabs
          label="Staff sections"
          value={tab}
          onValueChange={setTab}
          items={[
            { id: "members", label: "Members", badge: staff.data?.items.length },
            ...(manage ? [{ id: "invites", label: "Invitations", badge: pendingCount }] : []),
          ]}
        >
          {tab === "members" ? (
            <div className="dos-stack">
              <div className="dos-toolbar">
                <SelectField label="Role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                  <option value="">All roles</option>
                  {["OWNER", "MANAGER", "DENTIST", "RECEPTIONIST", "ACCOUNTANT"].map((r) => (
                    <option key={r} value={r}>
                      {humanize(r)}
                    </option>
                  ))}
                </SelectField>
                <SelectField label="Branch" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)}>
                  <option value="">All branches</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </SelectField>
              </div>
              <DataTable
                caption="Staff members"
                columns={memberCols}
                data={staff.data?.items ?? []}
                getRowId={(m) => m.id}
                loading={staff.loading && !staff.data}
                error={staff.error ? errorStateFor(staff.error) : undefined}
                searchLabel="Search staff"
                emptyTitle="No staff match these filters"
              />
            </div>
          ) : (
            <DataTable
              caption="Invitations"
              columns={inviteCols}
              data={invites.data?.items ?? []}
              getRowId={(i) => i.id}
              loading={invites.loading && !invites.data}
              error={invites.error ? errorStateFor(invites.error) : undefined}
              searchLabel="Search invitations"
              emptyTitle="No invitations"
              emptyDescription="Invite a team member to see them here until they accept."
            />
          )}
        </Tabs>
      </div>

      {inviteOpen ? (
        <InviteDialog
          onClose={() => setInviteOpen(false)}
          onCreated={(r) => {
            setInviteOpen(false);
            setCreated(r);
            setTab("invites");
            invites.reload();
          }}
        />
      ) : null}
      {editing ? (
        <EditAccessDialog
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            staff.reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke invitation?"
        description={`The link sent to ${revoking?.email ?? ""} will stop working. You can send a new invitation later.`}
        confirmLabel="Revoke invitation"
        tone="danger"
        loading={revoke.pending}
        onConfirm={() => revoking && void revoke.run(revoking)}
      />
    </>
  );
}

function InviteDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (r: CreatedInvitation) => void;
}) {
  const { branches } = useBranches();
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<AccessValue>({ roles: [], orgWide: false, branchScope: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation(api.invitations.create, {
    success: "Invitation sent",
    onSuccess: onCreated,
    onError: (e) => setErrors(e.fieldErrors),
  });
  const submit = () => {
    const r = validate(createInvitationRequest, { email, ...access });
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    void create.run(r.data);
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="Invite staff"
      description="They get a one-time sign-up link valid for 7 days."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={create.pending} onClick={submit}>
            Send invitation
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <TextField
          label="Work email"
          type="email"
          required
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <AccessFields value={access} onChange={setAccess} branches={branches} errors={errors} />
      </div>
    </Dialog>
  );
}

function EditAccessDialog({
  member,
  onClose,
  onSaved,
}: {
  member: StaffMemberResponse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { branches } = useBranches();
  const [access, setAccess] = useState<AccessValue>({
    roles: member.roles,
    orgWide: member.orgWide,
    branchScope: member.branchScope,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation(
    (b: ReturnType<typeof updateMembershipRequest.parse>) => api.staff.update(member.id, b),
    { success: "Access updated", onSuccess: onSaved, onError: (e) => setErrors(e.fieldErrors) },
  );
  const submit = () => {
    const r = validate(updateMembershipRequest, {
      ...access,
      branchScope: access.orgWide ? [] : access.branchScope,
    });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={`Edit access — ${userLabel(member.userId)}`}
      description="Changes apply from the person's next request. The organisation must keep at least one organisation-wide owner."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Save access
          </Button>
        </>
      }
    >
      <AccessFields value={access} onChange={setAccess} branches={branches} errors={errors} />
    </Dialog>
  );
}
