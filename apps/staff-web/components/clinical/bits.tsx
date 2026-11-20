"use client";
import { type BadgeTone, Checkbox, SelectField } from "@dentalos/ui";
import {
  PERMANENT_TEETH,
  PRIMARY_TEETH,
  type PlanItemStatus,
  type ToothSurface,
  type TreatmentPlanStatus,
  validSurfaces,
} from "@dentalos/validation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api/endpoints";
import { useQuery } from "../../lib/api/hooks";
import { plansApi } from "../../lib/api/plans";
import { LINKABLE_ITEM_STATUSES, isPlanClosed } from "../../lib/api/plans-rules";
import { humanize } from "../../lib/format";
import { sessionPrincipal, userLabel } from "../../lib/session";
import { surfaceName, toothLabel } from "./fdi";

export const isMe = (userId: string | null | undefined) =>
  Boolean(userId) && userId === sessionPrincipal().userId;

/** "Dr. Neha Iyer (you)" */
export const personLabel = (userId: string | null | undefined) =>
  userId ? `${userLabel(userId)}${isMe(userId) ? " (you)" : ""}` : "—";

export function planStatusTone(s: TreatmentPlanStatus | string): BadgeTone {
  switch (s) {
    case "DRAFT":
      return "neutral";
    case "PRESENTED":
      return "info";
    case "ACCEPTED":
    case "COMPLETED":
      return "success";
    case "PARTIALLY_ACCEPTED":
      return "brand";
    case "REJECTED":
    case "CANCELLED":
      return "danger";
    default:
      return "neutral";
  }
}

export function itemStatusTone(s: PlanItemStatus | string): BadgeTone {
  switch (s) {
    case "ACCEPTED":
    case "SCHEDULED":
      return "brand";
    case "IN_PROGRESS":
      return "info";
    case "COMPLETED":
      return "success";
    case "DEFERRED":
      return "warning";
    case "REJECTED":
    case "CANCELLED":
    case "ABANDONED":
      return "danger";
    default:
      return "neutral";
  }
}

export function StatusBadge({ status, tone }: { status: string; tone?: BadgeTone }) {
  return (
    <span className="dos-badge" data-tone={tone ?? itemStatusTone(status)}>
      {humanize(status)}
    </span>
  );
}

/** Compact definition list (term → detail). */
export function Kv({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="cw-kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Tooth + surface pickers driven by the shared FDI helpers: the surface checkboxes always offer the
 * five surfaces valid for the chosen tooth (I/F on anterior teeth, P on upper teeth).
 */
export function ToothSurfaceFields({
  tooth,
  surfaces,
  onChange,
  toothLabelText = "Tooth",
  allowSurfaces = true,
  required,
  error,
  surfacesError,
  disabled,
}: {
  tooth: number | undefined;
  surfaces: string[];
  onChange: (tooth: number | undefined, surfaces: string[]) => void;
  toothLabelText?: string;
  allowSurfaces?: boolean;
  required?: boolean;
  error?: string;
  surfacesError?: string;
  disabled?: boolean;
}) {
  const valid = tooth === undefined ? [] : validSurfaces(tooth);
  return (
    <div className="dos-stack" data-gap="sm">
      <SelectField
        label={toothLabelText}
        required={required}
        value={tooth === undefined ? "" : String(tooth)}
        disabled={disabled}
        error={error}
        onChange={(e) => {
          const t = e.target.value ? Number(e.target.value) : undefined;
          const keep =
            t === undefined
              ? []
              : surfaces.filter((s) => validSurfaces(t).includes(s as ToothSurface));
          onChange(t, keep);
        }}
      >
        <option value="">{required ? "Select a tooth" : "No specific tooth"}</option>
        <optgroup label="Permanent">
          {PERMANENT_TEETH.map((t) => (
            <option key={t} value={t}>
              {toothLabel(t)}
            </option>
          ))}
        </optgroup>
        <optgroup label="Primary">
          {PRIMARY_TEETH.map((t) => (
            <option key={t} value={t}>
              {toothLabel(t)}
            </option>
          ))}
        </optgroup>
      </SelectField>
      {allowSurfaces && tooth !== undefined ? (
        <fieldset
          className="cw-surfaces"
          aria-describedby={surfacesError ? "cw-surf-err" : undefined}
        >
          <legend>Surfaces (none = whole tooth)</legend>
          {valid.map((s) => (
            <Checkbox
              key={s}
              label={`${s} · ${surfaceName(s)}`}
              checked={surfaces.includes(s)}
              disabled={disabled}
              onChange={(e) =>
                onChange(
                  tooth,
                  e.target.checked
                    ? valid.filter((v) => v === s || surfaces.includes(v))
                    : surfaces.filter((v) => v !== s),
                )
              }
            />
          ))}
          {surfacesError ? (
            <div className="dos-error" id="cw-surf-err" style={{ flexBasis: "100%" }}>
              {surfacesError}
            </div>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

export interface ServiceInfo {
  id: string;
  code: string;
  name: string;
  pricePaise?: number;
  active: boolean;
}

/** Catalogue services with the branch's effective price (for pickers and item names). */
export function useServiceDirectory(branchId: string | undefined) {
  const list = useQuery(() => api.catalog.priceList(branchId ?? ""), [branchId], Boolean(branchId));
  const map = useMemo(() => {
    const m = new Map<string, ServiceInfo>();
    for (const s of list.data?.items ?? [])
      m.set(s.id, {
        id: s.id,
        code: s.code,
        name: s.name,
        pricePaise: s.pricePaise,
        active: s.active,
      });
    return m;
  }, [list.data]);
  const label = (id: string | null | undefined) => {
    if (!id) return "—";
    const s = map.get(id);
    return s ? `${s.code} · ${s.name}` : "Service no longer in the price list";
  };
  return { services: [...map.values()], map, label, loading: list.loading, error: list.error };
}

export interface LinkableItem {
  id: string;
  planId: string;
  planTitle: string;
  serviceId: string;
  toothCode: number | null;
  surfaces: string[];
  status: PlanItemStatus;
}

/**
 * Plan items a procedure may link to: ACCEPTED / SCHEDULED / IN_PROGRESS items of the patient's open
 * plans (Wave 1 addendum; anything else is 400 invalid_plan_item).
 */
export function useLinkablePlanItems(patientId: string, enabled: boolean) {
  const [items, setItems] = useState<LinkableItem[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const page = await plansApi.list({ patientId, limit: 50 });
        const open = page.items.filter((p) => !isPlanClosed(p.status) && p.status !== "DRAFT");
        const details = await Promise.all(open.map((p) => plansApi.get(p.id)));
        const out = details.flatMap((p) =>
          p.items
            .filter((i) => LINKABLE_ITEM_STATUSES.includes(i.status))
            .map((i) => ({
              id: i.id,
              planId: p.id,
              planTitle: p.title,
              serviceId: i.serviceId,
              toothCode: i.toothCode,
              surfaces: i.surfaces,
              status: i.status,
            })),
        );
        if (live) setItems(out);
      } catch {
        if (live) setItems([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [patientId, enabled]);
  return items;
}

/** Dentists currently assigned to a branch (for opening / handing over an encounter). */
export function useBranchDentists(branchId: string | undefined) {
  const q = useQuery(
    () => api.dentists.list({ branchId, status: "current" }),
    [branchId],
    Boolean(branchId),
  );
  const ids = [...new Set((q.data?.items ?? []).map((a) => a.userId))];
  const me = sessionPrincipal().userId;
  return { ids: ids.includes(me) ? ids : [me, ...ids], loading: q.loading };
}
