"use client";
import type { ChairResponse, SchedulingSettingsResponse } from "@dentalos/validation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api/endpoints";
import { useQuery } from "../../lib/api/hooks";
import { schedulingApi } from "../../lib/api/scheduling";
import {
  type DentistOption,
  loadBranchDentists,
  withKnownDentists,
} from "../../lib/api/scheduling-dentists";
import { type LiveStatus, subscribeScheduling } from "../../lib/api/scheduling-live";
import { DEFAULT_TIME_ZONE } from "../../lib/api/scheduling-time";
import { canDo, scopedBranchIds, userLabel } from "../../lib/session";

const BRANCH_KEY = "dos.scheduling.branch";
const readStored = () => {
  try {
    return window.localStorage.getItem(BRANCH_KEY) ?? "";
  } catch {
    return "";
  }
};

/**
 * The branch a scheduling screen works in (one at a time: chairs, hours and the time zone are
 * per branch). Defaults to the last one used, else the first branch in the user's scope.
 *
 * Loads GET /branches itself (the shared useBranches drops failures silently) so screens can tell
 * "still loading" from "failed" (ErrorState + retry) and "no branch in scope" (EmptyState) instead
 * of showing skeletons forever: see <BranchGate>.
 */
export function useSchedulingBranch(initial?: string | null) {
  const q = useQuery(() => api.branches.list().then((r) => r.items), []);
  const branches = useMemo(() => q.data ?? [], [q.data]);
  const scoped = useMemo(() => scopedBranchIds(branches), [branches]);
  const [branchId, setBranchIdState] = useState(initial ?? "");
  useEffect(() => {
    if (branchId || scoped.length === 0) return;
    const stored = readStored();
    setBranchIdState(scoped.includes(stored) ? stored : (scoped[0] as string));
  }, [branchId, scoped]);
  const setBranchId = (id: string) => {
    setBranchIdState(id);
    try {
      window.localStorage.setItem(BRANCH_KEY, id);
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  };
  const branch = branches.find((b) => b.id === branchId);
  const name = (id: string | null | undefined) =>
    id ? (branches.find((b) => b.id === id)?.name ?? "Unknown branch") : "—";
  return {
    branches,
    scoped,
    branchId,
    setBranchId,
    branch,
    branchName: name,
    timeZone: branch?.timezone ?? DEFAULT_TIME_ZONE,
    /** True once GET /branches answered. */
    branchesLoaded: q.data !== undefined,
    branchesError: q.data === undefined ? q.error : undefined,
    reloadBranches: q.reload,
  };
}

export type SchedulingBranch = ReturnType<typeof useSchedulingBranch>;

export type { DentistOption } from "../../lib/api/scheduling-dentists";

/**
 * Dentists at the branch for pickers, filters and labels. Falls back to dentists with working
 * hours here when the role can't read assignments (`limited`); `known` adds ids already on
 * screen (e.g. the loaded appointments) so their labels and filter entries still exist.
 */
export function useDentists(branchId: string, known: readonly (string | null | undefined)[] = []) {
  const q = useQuery(
    () => loadBranchDentists(schedulingApi, branchId, userLabel),
    [branchId],
    Boolean(branchId),
  );
  const knownKey = [...new Set(known.filter(Boolean))].sort().join(",");
  const list: DentistOption[] = useMemo(
    () => withKnownDentists(q.data?.dentists ?? [], knownKey ? knownKey.split(",") : [], userLabel),
    [q.data, knownKey],
  );
  const label = (userId: string | null | undefined) =>
    userId ? (list.find((d) => d.userId === userId)?.label ?? userLabel(userId)) : "Unassigned";
  return { dentists: list, label, state: q, limited: q.data?.source === "working-hours" };
}

/** Hint for a dentist picker when the list came from the working-hours fallback. */
export const LIMITED_DENTISTS_HINT =
  "Shows dentists with working hours here (your role can't read the full staff list).";

/**
 * The overlays here are mounted conditionally with `open` and no Radix Dialog.Trigger, so Radix
 * cannot return focus on close (its onCloseAutoFocus focuses the missing trigger) and focus fell to
 * <body>. remember() before opening stores the element that had focus (skipped when focus is
 * already inside a dialog, so panel → reschedule keeps the calendar chip); restore() after the last
 * overlay closes puts focus back on it, or on `fallback` when live refresh removed it.
 */
export function useFocusReturn(fallback?: () => HTMLElement | null | undefined) {
  const opener = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const remember = useCallback(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return;
    if (el.closest('[role="dialog"], [role="alertdialog"]')) return;
    opener.current = el;
  }, []);
  const restore = useCallback(() => {
    setTimeout(() => {
      if (!focusLost()) return;
      const target = opener.current;
      opener.current = null;
      (target?.isConnected ? target : fallbackRef.current?.())?.focus();
    }, 0);
  }, []);
  return { remember, restore };
}

/** Focus is on <body>, on a removed node, or parked on a dialog container. */
export function focusLost(): boolean {
  const el = document.activeElement;
  return (
    !el ||
    el === document.body ||
    !el.isConnected ||
    el.getAttribute("role") === "dialog" ||
    el.getAttribute("role") === "alertdialog"
  );
}

export const chairText = (c: Pick<ChairResponse, "code" | "name">) => `${c.code} · ${c.name}`;

export function useChairs(branchId: string) {
  const q = useQuery(() => schedulingApi.chairs.list({ branchId }), [branchId], Boolean(branchId));
  const all = q.data?.items ?? [];
  const active = all.filter((c) => c.active);
  const label = (id: string | null | undefined) => {
    if (!id) return "No chair";
    const c = all.find((x) => x.id === id);
    return c ? chairText(c) : "Unknown chair";
  };
  return { chairs: all, active, label, state: q };
}

export function useSchedulingSettings(branchId: string) {
  const q = useQuery<SchedulingSettingsResponse>(
    () => schedulingApi.settings.get(branchId),
    [branchId],
    Boolean(branchId),
  );
  return {
    settings: q.data,
    slotMinutes: q.data?.slotMinutes ?? 15,
    noShowGraceMinutes: q.data?.noShowGraceMinutes ?? 15,
    state: q,
  };
}

/** Display-only permission helper bound to the session principal. */
export const canFn = (
  perm: Parameters<typeof canDo>[0],
  resource?: { branchId?: string },
): boolean => canDo(perm, resource);

/**
 * Calls `reload` when a scheduling event for the branch arrives (debounced), polling while the
 * stream is down. Returns the connection status for the "Live" indicator.
 */
export function useLiveRefresh(branchId: string, reload: () => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!branchId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeScheduling({
      branchId,
      onStatus: setStatus,
      onChange: () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => reloadRef.current(), 250);
      },
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [branchId]);
  return status;
}

/** Re-renders every `ms` so "waiting 12 min" and the now-line stay current. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}
