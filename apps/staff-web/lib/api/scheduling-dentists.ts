import type { SchedulingApi } from "./scheduling";

/**
 * Dentists a scheduling screen can offer at one branch.
 *
 * The authoritative list is GET /dentist-assignments?branchId&status=current, but that endpoint needs
 * branch-scoped `staff:read`, which RECEPTIONIST and DENTIST (the main front-desk users) do not
 * have, so for them it answers 403. Instead of an empty picker we then fall back to the dentists
 * with DENTIST working-hours rows in force at the branch (GET /working-hours needs only
 * `appointment:read`), and callers may add ids they already know (e.g. from loaded appointments).
 * Names come from GET /staff (same staff:read gate) when readable, else the session directory.
 * See "Flags for Commander": a dentist list readable with appointment:read is the real fix.
 */

export interface DentistOption {
  userId: string;
  label: string;
}

/** `assignments`: the full current list. `working-hours`: fallback, may miss dentists. */
export type DentistSource = "assignments" | "working-hours";

export interface BranchDentists {
  dentists: DentistOption[];
  source: DentistSource;
}

type Deps = Pick<SchedulingApi, "directory" | "hours">;

const byLabel = (a: DentistOption, b: DentistOption) => a.label.localeCompare(b.label);

export async function loadBranchDentists(
  sapi: Deps,
  branchId: string,
  fallbackLabel: (userId: string) => string,
): Promise<BranchDentists> {
  const names = sapi.directory.staff({ role: "DENTIST" }).then(
    (r) => new Map(r.items.map((s) => [s.userId, s.displayName ?? null] as const)),
    () => new Map<string, string | null>(),
  );
  let ids: string[];
  let source: DentistSource = "assignments";
  try {
    const a = await sapi.directory.dentistAssignments({ branchId, status: "current" });
    ids = a.items.map((x) => x.userId);
  } catch {
    source = "working-hours";
    const rows = await sapi.hours
      .list({ branchId, scope: "DENTIST" })
      .catch(() => ({ items: [] as { userId: string | null }[] }));
    ids = rows.items.map((w) => w.userId).filter((u): u is string => Boolean(u));
  }
  const labels = await names;
  return {
    source,
    dentists: [...new Set(ids)]
      .map((userId) => ({ userId, label: labels.get(userId) || fallbackLabel(userId) }))
      .sort(byLabel),
  };
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
