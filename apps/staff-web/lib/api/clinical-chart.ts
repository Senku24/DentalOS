import type { ToothRecordResponse } from "@dentalos/validation";

type ChartRow = Pick<ToothRecordResponse, "status" | "recordedAt" | "supersededAt">;

/**
 * Splits GET /patients/:id/odontogram rows into the chart and its history. Without `asOf` the
 * stored status decides. With `asOf` (a signed encounter's chart as it stood when it was signed)
 * `status` reflects today, so a row counts as current when it was recorded by then and not yet
 * superseded at that instant (PatientClinicalService.odontogram uses the same rule).
 */
export function splitChart<T extends ChartRow>(
  records: readonly T[],
  asOf?: string | null,
): { current: T[]; past: T[] } {
  if (!asOf) {
    return {
      current: records.filter((r) => r.status === "CURRENT"),
      past: pastFirst(records.filter((r) => r.status === "HISTORICAL")),
    };
  }
  const t = Date.parse(asOf);
  const seen = records.filter((r) => Date.parse(r.recordedAt) <= t);
  const liveAt = (r: T) => !r.supersededAt || Date.parse(r.supersededAt) > t;
  return {
    current: seen.filter(liveAt),
    past: pastFirst(seen.filter((r) => !liveAt(r))),
  };
}

const pastFirst = <T extends ChartRow>(rows: T[]) =>
  rows.sort((a, b) => (b.supersededAt ?? "").localeCompare(a.supersededAt ?? ""));

/** Chart instant for an encounter view: a signed encounter shows the chart as of its signing. */
export const chartAsOf = (
  encounter: { status: string; signedAt: string | null } | undefined,
  showToday: boolean,
): string | undefined =>
  encounter?.status === "SIGNED" && encounter.signedAt && !showToday
    ? encounter.signedAt
    : undefined;
