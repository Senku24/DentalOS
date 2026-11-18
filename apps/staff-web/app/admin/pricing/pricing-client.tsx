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
  TextareaField,
  Timeline,
} from "@dentalos/ui";
import { clearPriceOverrideRequest, setPriceOverrideRequest } from "@dentalos/validation";
import { useEffect, useState } from "react";
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
import type { PriceListItem } from "../../../lib/api/types";
import { formatDateTime, formatPaise } from "../../../lib/format";
import { paiseToRupeeInput, rupeesToPaise, validate } from "../../../lib/forms";
import { DEV_PRINCIPAL, canDo, userLabel } from "../../../lib/session";

export function PricingClient() {
  return (
    <RequirePermission permission="catalog:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const { branches, name } = useBranches();
  const [branchId, setBranchId] = useState("");
  useEffect(() => {
    if (branchId || branches.length === 0) return;
    const first = branches.find((b) => b.active && canDo("price:override", { branchId: b.id }));
    setBranchId(first?.id ?? branches[0]?.id ?? "");
  }, [branches, branchId]);
  const list = useQuery(() => api.catalog.priceList(branchId), [branchId], Boolean(branchId));
  const canOverride = Boolean(branchId) && canDo("price:override", { branchId });
  const [overriding, setOverriding] = useState<{
    item: PriceListItem;
    mode: "set" | "clear";
  } | null>(null);
  const [history, setHistory] = useState<PriceListItem | null>(null);

  const columns: ColumnDef<PriceListItem, unknown>[] = [
    {
      accessorKey: "code",
      header: "Code",
      cell: ({ getValue }) => <span className="dos-mono">{String(getValue())}</span>,
    },
    { accessorKey: "name", header: "Service" },
    {
      accessorKey: "basePricePaise",
      header: "Central price",
      cell: ({ getValue }) => <span className="dos-num">{formatPaise(getValue() as number)}</span>,
    },
    {
      accessorKey: "pricePaise",
      header: "Branch price",
      cell: ({ row }) => {
        const r = row.original;
        const diff = r.pricePaise - r.basePricePaise;
        return (
          <span className="dos-num">
            <strong>{formatPaise(r.pricePaise)}</strong>
            {r.source === "OVERRIDE" && diff !== 0 ? (
              <span className="dos-muted">
                {" "}
                ({diff > 0 ? "+" : "−"}
                {formatPaise(Math.abs(diff))})
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      accessorKey: "source",
      header: "Source",
      cell: ({ getValue }) =>
        getValue() === "OVERRIDE" ? (
          <Badge tone="warning">Branch override</Badge>
        ) : (
          <Badge tone="neutral">Central</Badge>
        ),
    },
    {
      id: "actions",
      header: () => <span className="dos-sr-only">Actions</span>,
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="dos-cluster">
            <Button size="sm" variant="ghost" onClick={() => setHistory(r)}>
              History<span className="dos-sr-only"> for {r.name}</span>
            </Button>
            {canOverride ? (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setOverriding({ item: r, mode: "set" })}
                >
                  {r.source === "OVERRIDE" ? "Change" : "Override"}
                  <span className="dos-sr-only"> price for {r.name}</span>
                </Button>
                {r.source === "OVERRIDE" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOverriding({ item: r, mode: "clear" })}
                  >
                    Revert<span className="dos-sr-only"> {r.name} to central price</span>
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        );
      },
    },
  ];

  const overridden = list.data?.items.filter((i) => i.source === "OVERRIDE").length ?? 0;

  return (
    <>
      <PageHeader
        title="Branch pricing"
        description="Effective prices per branch. Overrides need a reason and are kept in an audited history."
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Administration" },
          { label: "Branch pricing" },
        ]}
      />
      <div className="dos-stack">
        <MockNotice />
        <div className="dos-toolbar">
          <SelectField
            label="Branch"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <BranchOptions branches={branches} />
          </SelectField>
        </div>
        {branchId && !canOverride ? (
          <Alert tone="info">
            You can view prices for {name(branchId)}. Changing them needs the price override
            permission for this branch
            {DEV_PRINCIPAL.orgWide ? "" : " (managers: your own branches only)"}.
          </Alert>
        ) : null}
        {list.data ? (
          <p className="dos-muted" style={{ margin: 0 }}>
            {list.data.items.length} active services · {overridden} overridden at {name(branchId)}
          </p>
        ) : null}
        <DataTable
          caption={`Price list for ${name(branchId)}`}
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={list.loading}
          error={list.error ? errorStateFor(list.error) : undefined}
          searchLabel="Search services"
          pageSize={25}
          emptyTitle="No active services"
          emptyDescription="Add services in the catalogue first."
        />
      </div>

      {overriding ? (
        <OverrideDialog
          item={overriding.item}
          mode={overriding.mode}
          branchId={branchId}
          branchName={name(branchId)}
          onClose={() => setOverriding(null)}
          onDone={() => {
            setOverriding(null);
            list.reload();
          }}
        />
      ) : null}
      {history ? (
        <HistoryDrawer
          item={history}
          branchId={branchId}
          branchName={name}
          onClose={() => setHistory(null)}
        />
      ) : null}
    </>
  );
}

function OverrideDialog({
  item,
  mode,
  branchId,
  branchName,
  onClose,
  onDone,
}: {
  item: PriceListItem;
  mode: "set" | "clear";
  branchId: string;
  branchName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [price, setPrice] = useState(paiseToRupeeInput(item.pricePaise));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = useMutation(
    (b: ReturnType<typeof setPriceOverrideRequest.parse>) => api.catalog.setOverride(item.id, b),
    {
      success: "Branch price updated",
      onSuccess: onDone,
      onError: (e) => setErrors(e.fieldErrors),
    },
  );
  const clear = useMutation(
    (b: ReturnType<typeof clearPriceOverrideRequest.parse>) =>
      api.catalog.clearOverride(item.id, b),
    {
      success: "Reverted to central price",
      onSuccess: onDone,
      onError: (e) => setErrors(e.fieldErrors),
    },
  );
  const submit = () => {
    if (mode === "clear") {
      const r = validate(clearPriceOverrideRequest, { branchId, reason });
      if (!r.ok) return setErrors(r.errors);
      return void clear.run(r.data);
    }
    const paise = rupeesToPaise(price);
    if (paise === null)
      return setErrors({ pricePaise: "Enter an amount in rupees, e.g. 1500 or 1500.50" });
    const r = validate(setPriceOverrideRequest, { branchId, pricePaise: paise, reason });
    if (!r.ok) return setErrors(r.errors);
    void set.run(r.data);
  };
  const preview = rupeesToPaise(price);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        mode === "set" ? `Override price — ${item.name}` : `Revert ${item.name} to central price`
      }
      description={`${branchName} · central price ${formatPaise(item.basePricePaise)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={set.pending || clear.pending} onClick={submit}>
            {mode === "set" ? "Save override" : "Revert price"}
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        {mode === "set" ? (
          <TextField
            label={`Price at ${branchName} (₹)`}
            inputMode="decimal"
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            hint={
              preview !== null
                ? `Patients at this branch will be charged ${formatPaise(preview)}`
                : undefined
            }
            error={errors.pricePaise}
          />
        ) : (
          <p style={{ margin: 0 }}>
            The branch will charge {formatPaise(item.basePricePaise)} from now on. The current
            override stays in the history.
          </p>
        )}
        <TextareaField
          label="Reason"
          required
          hint="Recorded in the audit trail and shown in price history."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />
        <p className="dos-hint" style={{ margin: 0 }}>
          Takes effect immediately for new invoices. Past invoices are not repriced.
        </p>
      </div>
    </Dialog>
  );
}

function HistoryDrawer({
  item,
  branchId,
  branchName,
  onClose,
}: {
  item: PriceListItem;
  branchId: string;
  branchName: (id: string) => string;
  onClose: () => void;
}) {
  const q = useQuery(() => api.catalog.overrideHistory(item.id, branchId), [item.id, branchId]);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Price history — ${item.name}`}
      description={`${branchName(branchId)} · central price ${formatPaise(item.basePricePaise)}`}
    >
      <Loadable state={q}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState
              title="No overrides"
              description="This branch has always used the central price."
            />
          ) : (
            <Timeline
              label="Override history, newest first"
              items={[...d.items]
                .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
                .map((o) => ({
                  id: o.id,
                  current: o.effectiveTo === null,
                  tone: o.effectiveTo === null ? "warning" : "neutral",
                  title: (
                    <span className="dos-cluster">
                      <span className="dos-num">{formatPaise(o.pricePaise)}</span>
                      {o.effectiveTo === null ? (
                        <Badge tone="warning">In effect</Badge>
                      ) : (
                        <Badge>Ended</Badge>
                      )}
                    </span>
                  ),
                  meta: `${formatDateTime(o.effectiveFrom)} → ${o.effectiveTo ? formatDateTime(o.effectiveTo) : "now"} · set by ${userLabel(o.setBy)}`,
                  description: `Reason: ${o.reason}`,
                }))}
            />
          )
        }
      </Loadable>
    </Drawer>
  );
}
