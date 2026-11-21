"use client";
import { SelectField, TextField } from "@dentalos/ui";
import type {
  CommissionEntryResponse,
  CommissionRuleResponse,
  CommissionRuleType,
  StaffMemberResponse,
} from "@dentalos/validation";
import { api } from "../../lib/api/endpoints";
import { useQuery } from "../../lib/api/hooks";
import { formatPaise, humanize } from "../../lib/format";
import { canDo, sessionPrincipal, userLabel } from "../../lib/session";

/** Shared helpers for the compensation screens. */

export const newKey = () => globalThis.crypto.randomUUID();

/**
 * Whether the signed-in user sees every dentist (compensation:manage, or an organisation-wide reader) or only
 * their own statement (a dentist). Display only: the API scopes every call by the principal.
 */
export function useCompensationScope() {
  const me = sessionPrincipal().userId;
  const manage = canDo("compensation:manage");
  const settle = canDo("compensation:settle");
  const all = manage || canDo("compensation:read");
  return { me, all, manage, settle };
}

/** Self-scoped readers may open the page: `compensation:read` is "self", so check against their own id. */
export const canOpenCompensation = () =>
  canDo("compensation:manage") ||
  canDo("compensation:read", { ownerUserId: sessionPrincipal().userId });

export interface Dentist {
  userId: string;
  name: string;
}

/**
 * Dentists of the organisation for pickers. GET /staff needs `staff:read`, which accountants lack: the list is
 * then empty and `DentistField` falls back to typing the staff user id.
 */
export function useDentists() {
  const q = useQuery(
    () =>
      api.staff
        .list({ role: "DENTIST" })
        .then((r) => r.items)
        .catch(() => [] as StaffMemberResponse[]),
    [],
  );
  const dentists: Dentist[] = (q.data ?? [])
    .filter((m) => !m.removedAt)
    .map((m) => ({ userId: m.userId, name: m.displayName ?? userLabel(m.userId) }));
  const name = (userId: string | null | undefined) => {
    if (!userId) return "Everyone (default)";
    return dentists.find((d) => d.userId === userId)?.name ?? userLabel(userId);
  };
  return { dentists, name, loading: q.loading };
}

export function DentistField({
  label = "Dentist",
  value,
  onChange,
  dentists,
  allLabel,
  error,
  required,
}: {
  label?: string;
  value: string;
  onChange: (userId: string) => void;
  dentists: Dentist[];
  /** Adds a blank option with this label (filters, or "default for everyone" on a rule). */
  allLabel?: string;
  error?: string;
  required?: boolean;
}) {
  if (dentists.length === 0 && allLabel === undefined) {
    return (
      <TextField
        label={label}
        required={required}
        value={value}
        error={error}
        autoComplete="off"
        hint="Staff user id of the dentist."
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (dentists.length === 0) {
    return (
      <TextField
        label={`${label} (staff user id)`}
        value={value}
        error={error}
        autoComplete="off"
        hint={allLabel}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <SelectField
      label={label}
      required={required}
      value={value}
      error={error}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allLabel ?? "Select a dentist"}</option>
      {dentists.map((d) => (
        <option key={d.userId} value={d.userId}>
          {d.name}
        </option>
      ))}
    </SelectField>
  );
}

export function useCategories() {
  const q = useQuery(
    () =>
      api.catalog
        .categories()
        .then((r) => r.items)
        .catch(() => []),
    [],
  );
  const categories = q.data ?? [];
  const name = (id: string | null | undefined) =>
    id ? (categories.find((c) => c.id === id)?.name ?? "Unknown category") : "All categories";
  return { categories, name };
}

export const entryTone = (k: CommissionEntryResponse["kind"]) =>
  k === "ACCRUAL"
    ? "success"
    : k === "REVERSAL"
      ? "danger"
      : k === "SETTLEMENT"
        ? "info"
        : "warning";

/** +₹1,200 / −₹180 for ledger amounts. */
export function formatSigned(paise: number): string {
  if (paise === 0) return formatPaise(0);
  return `${paise > 0 ? "+" : "−"}${formatPaise(Math.abs(paise))}`;
}

export const RULE_TYPE_LABEL: Record<CommissionRuleType, string> = {
  PERCENT_OF_COLLECTED: "% of cash collected",
  PERCENT_OF_BILLED: "% of billed value",
  FIXED_PER_PROCEDURE: "Fixed per procedure",
};

export const RULE_TYPE_HELP: Record<CommissionRuleType, string> = {
  PERCENT_OF_COLLECTED:
    "A percentage of the money actually collected, net of tax. Earned as payments arrive.",
  PERCENT_OF_BILLED:
    "A percentage of the billed value before discounts, net of tax, earned in proportion as the line is collected. Clinic discounts do not reduce it.",
  FIXED_PER_PROCEDURE:
    "A fixed amount per procedure unit, earned in proportion as the line is collected.",
};

export const percentLabel = (bp: number) =>
  `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(bp / 100)}%`;

/** "30% of cash collected" / "₹1,500 per procedure". */
export function describeRule(r: Pick<CommissionRuleResponse, "type" | "percentBp" | "fixedPaise">) {
  if (r.type === "FIXED_PER_PROCEDURE") return `${formatPaise(r.fixedPaise ?? 0)} per procedure`;
  const of = r.type === "PERCENT_OF_BILLED" ? "of billed value" : "of cash collected";
  return `${percentLabel(r.percentBp ?? 0)} ${of}`;
}

/** Percent typed by the user ("27.5") → basis points; NaN when invalid, undefined when blank. */
export function percentToBp(input: string): number | undefined {
  const s = input.replace(/[%\s]/g, "");
  if (s === "") return undefined;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}

export const kindLabel = (k: string) => humanize(k);

export const short = (id: string | null | undefined) => (id ? id.slice(0, 8) : "—");
