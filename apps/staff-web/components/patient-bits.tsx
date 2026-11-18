"use client";
import type { DuplicateCheckResponse } from "@dentalos/validation";
import { Alert, Badge, useLink } from "@dentalos/ui";
import { ageFrom, formatDate, formatPhone, humanize, patientName } from "../lib/format";

export type DuplicateMatch = DuplicateCheckResponse["matches"][number];

const REASON_LABEL: Record<string, string> = {
  PHONE_EXACT: "Same phone",
  EMAIL_EXACT: "Same email",
  NAME_EXACT: "Same name",
  NAME_SIMILAR: "Similar name",
  DOB_EXACT: "Same date of birth",
};
export const reasonLabel = (r: string) => REASON_LABEL[r] ?? humanize(r);

export function scoreTone(score: number) {
  return score >= 80 ? "danger" : score >= 60 ? "warning" : "info";
}

/** Possible matches with score + reasons; each links to the existing record. */
export function DuplicateMatchList({
  matches,
  branchName,
}: {
  matches: DuplicateMatch[];
  branchName: (id: string) => string;
}) {
  const Link = useLink();
  return (
    <ul className="dos-stack" data-gap="sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {matches.map((m) => (
        <li key={m.patient.id} className="dos-card" style={{ padding: "var(--space-3)" }}>
          <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
            <Link href={`/patients/${m.patient.id}`} className="dos-link" target="_blank" rel="noopener">
              {patientName(m.patient)}
              <span className="dos-sr-only"> (opens in a new tab)</span>
            </Link>
            <Badge tone={scoreTone(m.score)}>{m.score}% match</Badge>
          </div>
          <div className="dos-muted" style={{ fontSize: "var(--text-sm)" }}>
            {m.patient.mrn ?? "No MRN"} · {formatPhone(m.patient.phone)} ·{" "}
            {m.patient.dob ? `${formatDate(m.patient.dob)} (${ageFrom(m.patient.dob)} y)` : "DOB unknown"} ·{" "}
            {branchName(m.patient.originBranchId)}
          </div>
          <div className="dos-cluster" style={{ marginTop: 4 }}>
            {m.reasons.map((r) => (
              <Badge key={r} tone="neutral">
                {reasonLabel(r)}
              </Badge>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Shown on any record that was merged; all writes to it are rejected (409 patient_merged). */
export function MergedBanner({ survivorId }: { survivorId: string }) {
  const Link = useLink();
  return (
    <Alert tone="warning">
      <div>
        <strong>This record was merged.</strong> It is kept read-only for the audit trail.{" "}
        <Link href={`/patients/${survivorId}`} className="dos-link">
          Open the surviving patient record
        </Link>
        .
      </div>
    </Alert>
  );
}
