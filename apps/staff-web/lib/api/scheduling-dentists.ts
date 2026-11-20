import type { SchedulingApi } from "./scheduling";

/**
 * Dentists a scheduling screen can offer at one branch.
 *
 * The list is GET /scheduling/dentists?branchId (Wave 3): current, non-removed members with the
 * DENTIST role and an assignment at the branch in force today or later, with display names. It
 * needs only branch-scoped `appointment:read`, so RECEPTIONIST and DENTIST (no `staff:read`) get
 * the full list too. Should that call fail (e.g. an older API without the route), we fall back to
 * the dentists with DENTIST working-hours rows at the branch (GET /working-hours, same permission),
 * and callers may add ids they already know (e.g. from loaded appointments).
 */

export interface DentistOption {
  userId: string;
  label: string;
}

/** `dentists`: the full current list. `working-hours`: fallback, may miss dentists. */
export type DentistSource = "dentists" | "working-hours";

export interface BranchDentists {
  dentists: DentistOption[];
  source: DentistSource;
}

type Deps = Pick<SchedulingApi, "dentists" | "hours">;

const byLabel = (a: DentistOption, b: DentistOption) => a.label.localeCompare(b.label);

export async function loadBranchDentists(
  sapi: Deps,
  branchId: string,
  fallbackLabel: (userId: string) => string,
): Promise<BranchDentists> {
  try {
    const r = await sapi.dentists(branchId);
    return {
      source: "dentists",
      dentists: r.items
        .map((d) => ({ userId: d.userId, label: d.displayName || fallbackLabel(d.userId) }))
        .sort(byLabel),
    };
  } catch {
    const rows = await sapi.hours
      .list({ branchId, scope: "DENTIST" })
      .catch(() => ({ items: [] as { userId: string | null }[] }));
    const ids = rows.items.map((w) => w.userId).filter((u): u is string => Boolean(u));
    return {
      source: "working-hours",
      dentists: [...new Set(ids)]
        .map((userId) => ({ userId, label: fallbackLabel(userId) }))
        .sort(byLabel),
    };
  }
}

/** Adds dentists only known from elsewhere (appointments on screen) to a loaded list. */
export function withKnownDentists(
  list: readonly DentistOption[],
  known: readonly (string | null | undefined)[],
  label: (userId: string) => string,
): DentistOption[] {
  const have = new Set(list.map((d) => d.userId));
  const extra = [
    ...new Set(known.filter((u): u is string => Boolean(u) && !have.has(u as string))),
  ];
  if (extra.length === 0) return [...list];
  return [...list, ...extra.map((userId) => ({ userId, label: label(userId) }))].sort(byLabel);
}
