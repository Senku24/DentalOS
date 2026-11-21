"use client";
import { SelectField } from "@dentalos/ui";
import type { BranchResponse, InventoryItemResponse, InventoryUnit } from "@dentalos/validation";
import { roundCost } from "@dentalos/validation";
import { useCallback, useRef } from "react";
import { collectPages } from "../../lib/api/clinical-client";
import { useQuery } from "../../lib/api/hooks";
import { inventoryApi } from "../../lib/api/inventory";
import { scopedBranchIds } from "../../lib/session";
import { BranchOptions, useBranches } from "../common";

/** Shared helpers for the inventory screens. */

export const newKey = () => globalThis.crypto.randomUUID();

/**
 * Replay key for one user action. The same key is reused while the payload is unchanged (a retry after a
 * network failure must not write twice); an edited payload gets a fresh key (the API would otherwise answer
 * idempotency_conflict). Call `done()` after success so the next action starts with a new key.
 */
export function useIdemKey() {
  const ref = useRef<{ sig: string; key: string } | null>(null);
  const keyFor = useCallback((payload: unknown) => {
    const sig = JSON.stringify(payload);
    if (!ref.current || ref.current.sig !== sig) ref.current = { sig, key: newKey() };
    return ref.current.key;
  }, []);
  const done = useCallback(() => {
    ref.current = null;
  }, []);
  return { keyFor, done };
}

/** "" → undefined, otherwise a number (NaN when not numeric; zod reports it). */
export const num = (s: string): number | undefined => {
  const t = s.trim();
  return t === "" ? undefined : Number(t);
};

const qtyFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
export const formatQty = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : qtyFmt.format(n);

export const UNIT_LABEL: Record<InventoryUnit, string> = {
  PIECE: "pc",
  BOX: "box",
  PACK: "pack",
  SET: "set",
  VIAL: "vial",
  CARTRIDGE: "cartridge",
  GRAM: "g",
  KILOGRAM: "kg",
  MILLILITRE: "ml",
  LITRE: "l",
};
export const unitLabel = (u: string | undefined) =>
  u ? (UNIT_LABEL[u as InventoryUnit] ?? u) : "";
export const qtyWithUnit = (n: number | null | undefined, unit?: string) =>
  `${formatQty(n)}${unit ? ` ${unitLabel(unit)}` : ""}`;

const unitCostFmt = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
/** Unit costs are paise per unit and may carry fractions of a paisa (₹0.125 per ml). */
export const formatUnitCost = (paise: number | null | undefined) =>
  paise === null || paise === undefined || !Number.isFinite(paise)
    ? "—"
    : unitCostFmt.format(paise / 100);

/** Rupee input per unit ("12.5") → paise per unit (≤ 4 decimals). undefined when blank, NaN when invalid. */
export function unitCostFromRupees(input: string): number | undefined {
  const s = input.replace(/[₹,\s]/g, "");
  if (s === "") return undefined;
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return Number.NaN;
  return roundCost(Number(s) * 100);
}

/** Active branches the principal may act in, with a name lookup. */
export function useScopedBranches() {
  const { branches, name } = useBranches();
  const ids = scopedBranchIds(branches);
  const mine: BranchResponse[] = branches.filter((b) => ids.includes(b.id));
  return { branches, mine, ids, name };
}

export function BranchSelect({
  label = "Branch",
  value,
  onChange,
  allLabel,
  error,
  required,
}: {
  label?: string;
  value: string;
  onChange: (id: string) => void;
  /** Adds an "all" option with this label (filters). */
  allLabel?: string;
  error?: string;
  required?: boolean;
}) {
  const { mine } = useScopedBranches();
  return (
    <SelectField
      label={label}
      value={value}
      error={error}
      required={required}
      onChange={(e) => onChange(e.target.value)}
    >
      {allLabel !== undefined ? (
        <option value="">{allLabel}</option>
      ) : (
        <option value="">Select a branch</option>
      )}
      <BranchOptions branches={mine} />
    </SelectField>
  );
}

/** All active items (the directory is small: a clinic stocks hundreds, not thousands). */
export function useItemDirectory(rev = 0) {
  const q = useQuery(
    () =>
      collectPages((cursor) => inventoryApi.items.list({ limit: 100, cursor, active: true }), 30),
    [rev],
  );
  const items: InventoryItemResponse[] = q.data ?? [];
  const byId = (id: string | null | undefined) => (id ? items.find((i) => i.id === id) : undefined);
  return { ...q, items, byId };
}

export function ItemSelect({
  label = "Item",
  items,
  value,
  onChange,
  error,
  required,
  allLabel,
}: {
  label?: string;
  items: InventoryItemResponse[];
  value: string;
  onChange: (id: string) => void;
  error?: string;
  required?: boolean;
  allLabel?: string;
}) {
  return (
    <SelectField
      label={label}
      value={value}
      error={error}
      required={required}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allLabel ?? "Select an item"}</option>
      {items.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name} ({i.sku})
        </option>
      ))}
    </SelectField>
  );
}

/** Batches in stock for one item at a branch (FEFO order). Blank value = automatic first-expiry-first-out. */
export function BatchSelect({
  label = "Batch",
  branchId,
  itemId,
  value,
  onChange,
  autoLabel = "Automatic (first expiry first)",
  error,
}: {
  label?: string;
  branchId: string;
  itemId: string;
  value: string;
  onChange: (batchNo: string) => void;
  autoLabel?: string;
  error?: string;
}) {
  const enabled = Boolean(branchId && itemId);
  const q = useQuery(
    () => inventoryApi.reports.batches({ branchId, itemId }),
    [branchId, itemId],
    enabled,
  );
  const rows = (q.data ?? []).filter((b) => b.batchNo);
  return (
    <SelectField
      label={label}
      value={value}
      error={error ?? (q.error ? "Couldn't load batches" : undefined)}
      hint={q.loading ? "Loading batches…" : undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{autoLabel}</option>
      {rows.map((b) => (
        <option key={b.batchNo as string} value={b.batchNo as string}>
          {b.batchNo} · {b.expiryDate ?? "no expiry"} · {formatQty(b.quantity)} left
        </option>
      ))}
    </SelectField>
  );
}

/** Days until expiry → badge copy/tone. */
export function expiryBadge(days: number): { label: string; tone: "danger" | "warning" } {
  if (days <= 0) return { label: days === 0 ? "Expires today" : "Expired", tone: "danger" };
  return { label: `Expires in ${days} d`, tone: "warning" };
}

/** What the page-level dialogs can be asked to open (set by tabs, rendered by the page). */
export interface DialogRequest {
  kind: "receive" | "consume" | "adjust" | "waste";
  preset?: { branchId?: string; itemId?: string };
}
export interface TabProps {
  /** Bumped after every write so tabs refetch. */
  rev: number;
  openDialog: (d: DialogRequest) => void;
}
