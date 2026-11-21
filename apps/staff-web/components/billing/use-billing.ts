"use client";
import type { ResolvedBillingSettings } from "@dentalos/validation";
import { useEffect, useMemo, useRef, useState } from "react";
import { billingApi } from "../../lib/api/billing";
import { createKeyer } from "../../lib/api/billing-rules";
import { api } from "../../lib/api/endpoints";
import { useQuery } from "../../lib/api/hooks";
import { patientName } from "../../lib/format";
import { scopedBranchIds } from "../../lib/session";

/** Branches the user can bill in (active + in scope) and name lookup for every branch. */
export function useBillingBranches() {
  const q = useQuery(() => api.branches.list().then((r) => r.items), []);
  const all = useMemo(() => q.data ?? [], [q.data]);
  const scopedIds = useMemo(() => scopedBranchIds(all), [all]);
  const scoped = useMemo(() => all.filter((b) => scopedIds.includes(b.id)), [all, scopedIds]);
  const name = (id: string | null | undefined) =>
    id ? (all.find((b) => b.id === id)?.name ?? "Unknown branch") : "—";
  const code = (id: string | null | undefined) =>
    id ? (all.find((b) => b.id === id)?.code ?? "") : "";
  return {
    all,
    scoped,
    name,
    code,
    loaded: q.data !== undefined,
    error: q.error,
    reload: q.reload,
  };
}

/** Effective billing knobs (tax mode, limits, methods, gateway…) for a branch, or the tenant defaults. */
export function useBillingSettings(branchId?: string) {
  const q = useQuery(() => billingApi.settings.get(branchId || undefined), [branchId]);
  const effective: ResolvedBillingSettings | undefined = q.data?.effective;
  return { effective, state: q };
}

const nameCache = new Map<string, Promise<string>>();
const nameOf = (id: string) => {
  let p = nameCache.get(id);
  if (!p) {
    p = api.patients.get(id).then(
      (pt) => patientName(pt),
      () => {
        nameCache.delete(id);
        return "Patient";
      },
    );
    nameCache.set(id, p);
  }
  return p;
};

/** id → display name for lists whose rows carry only `patientId` (payments, refunds). */
export function usePatientNames(ids: readonly string[]) {
  const key = [...new Set(ids)].sort().join(",");
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const want = key ? key.split(",") : [];
    for (const id of want) {
      nameOf(id).then((n) => live && setNames((s) => (s[id] === n ? s : { ...s, [id]: n })));
    }
    return () => {
      live = false;
    };
  }, [key]);
  return (id: string) => names[id] ?? "…";
}

/** One idempotency keyer per mounted action (see `createKeyer`). */
export function useKeyer(prefix: string) {
  const ref = useRef<ReturnType<typeof createKeyer> | null>(null);
  ref.current ??= createKeyer(prefix);
  return ref.current;
}
