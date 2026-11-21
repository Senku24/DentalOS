"use client";
import {
  Badge,
  Button,
  type ColumnDef,
  CursorPager,
  DataTable,
  SelectField,
  TextField,
} from "@dentalos/ui";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PURPOSES,
  type NotificationTemplateResponse,
} from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { errorStateFor } from "../../../lib/api/errors";
import { useQuery } from "../../../lib/api/hooks";
import { notificationsApi as nApi } from "../../../lib/api/notifications";
import { channelLabel, purposeLabel } from "../../../lib/api/notifications-labels";
import { formatDate } from "../../../lib/format";
import { useCursorPaging, useDebounced } from "../../../lib/use-cursor";
import { TemplateCreateDialog } from "./template-create-dialog";
import { TemplateDrawer } from "./template-drawer";

const LANG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

export function TemplatesTab() {
  const [channel, setChannel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [active, setActive] = useState("");
  const [lang, setLang] = useState("");
  const dl = useDebounced(lang.trim().toLowerCase());
  const language = LANG_RE.test(dl) ? dl : undefined;
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const paging = useCursorPaging();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change restarts paging
  useEffect(() => paging.reset(), [channel, active, language]);
  const list = useQuery(
    () =>
      nApi.templates.list({
        channel: (channel || undefined) as never,
        language,
        active: active === "" ? undefined : active === "true",
        cursor: paging.cursor,
      }),
    [channel, active, language, paging.cursor],
  );
  // Purpose is not a server filter: narrow the loaded page.
  const rows = (list.data?.items ?? []).filter((t) => !purpose || t.purpose === purpose);

  const columns: ColumnDef<NotificationTemplateResponse, unknown>[] = [
    {
      accessorKey: "name",
      header: "Template",
      cell: ({ row }) => (
        <div>
          <div>{row.original.name}</div>
          <div className="dos-mono dos-muted">{row.original.code}</div>
        </div>
      ),
    },
    {
      accessorKey: "channel",
      header: "Channel",
      cell: ({ getValue }) => channelLabel(getValue() as string),
    },
    { accessorKey: "language", header: "Language" },
    {
      accessorKey: "purpose",
      header: "Purpose",
      cell: ({ getValue }) => purposeLabel(getValue() as string),
    },
    { accessorKey: "currentVersion", header: "Version", cell: ({ getValue }) => `v${getValue()}` },
    {
      accessorKey: "active",
      header: "Status",
      cell: ({ getValue }) =>
        getValue() ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
    },
    {
      accessorKey: "updatedAt",
      header: "Updated",
      cell: ({ getValue }) => formatDate(getValue() as string),
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <Button size="sm" variant="secondary" onClick={() => setOpen(row.original.id)}>
          Open<span className="dos-sr-only"> {row.original.name}</span>
        </Button>
      ),
    },
  ];

  return (
    <div className="dos-stack">
      <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
        <search className="dos-toolbar" aria-label="Filter templates" style={{ flex: 1 }}>
          <SelectField label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option>
            {NOTIFICATION_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {channelLabel(c)}
              </option>
            ))}
          </SelectField>
          <SelectField label="Purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">All purposes</option>
            {NOTIFICATION_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {purposeLabel(p)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Language"
            placeholder="en, hi..."
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            maxLength={12}
          />
          <SelectField label="Status" value={active} onChange={(e) => setActive(e.target.value)}>
            <option value="">Active and inactive</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </SelectField>
        </search>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden="true" /> New template
        </Button>
      </div>
      <div>
        <DataTable
          caption="Message templates"
          columns={columns}
          data={rows}
          getRowId={(t) => t.id}
          loading={list.loading}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchable={false}
          hidePagination
          pageSize={100}
          emptyTitle="No templates"
          emptyDescription="Create the confirmation and reminder texts patients should receive."
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
      <TemplateCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(t) => {
          setCreating(false);
          list.reload();
          setOpen(t.id);
        }}
      />
      <TemplateDrawer id={open} onClose={() => setOpen(null)} onChanged={list.reload} />
    </div>
  );
}
