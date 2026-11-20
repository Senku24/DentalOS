"use client";
import { Badge, useLink } from "@dentalos/ui";
import type { ClinicalContextResponse, MedicalHistoryResponse } from "@dentalos/validation";
import { formatDate, formatDateTime, humanize } from "../../lib/format";
import { canDo, userLabel } from "../../lib/session";
import { Section } from "../common";
import { planStatusTone } from "./bits";

/** Answers worth surfacing: true flags and non-empty text/lists. */
function positives(a: MedicalHistoryResponse["medical"]): string[] {
  return Object.entries(a).flatMap(([k, v]) => {
    const label = humanize(k.replace(/([a-z])([A-Z])/g, "$1_$2"));
    if (v === true) return [label];
    if (typeof v === "string" && v.trim()) return [`${label}: ${v}`];
    if (typeof v === "number") return [`${label}: ${v}`];
    if (Array.isArray(v) && v.length) return [`${label}: ${v.join(", ")}`];
    return [];
  });
}

/** Relevant history (PRD 3.4): medical summary (medical:read), past encounters and active plans. */
export function HistoryPanel({
  context,
  currentEncounterId,
  branchName,
}: {
  context: ClinicalContextResponse;
  currentEncounterId: string | undefined;
  branchName: (id: string | null | undefined) => string;
}) {
  const Link = useLink();
  const mh = context.latestMedicalHistory;
  const medical = canDo("medical:read");
  return (
    <>
      {medical ? (
        <Section title="Medical history">
          {mh ? (
            <div className="dos-stack" data-gap="sm">
              <div className="cw-meta">
                Version {mh.version} · {formatDate(mh.recordedAt)} · {userLabel(mh.recordedBy)}
              </div>
              {positives(mh.medical).length ? (
                <ul className="cw-banner__alerts" aria-label="Medical conditions">
                  {positives(mh.medical).map((p) => (
                    <li key={p}>
                      <Badge tone="warning">{p}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dos-muted" style={{ margin: 0 }}>
                  No medical conditions reported.
                </p>
              )}
              {mh.medications.length ? (
                <div>
                  <strong style={{ fontSize: "var(--text-sm)" }}>Medications</strong>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: "var(--text-sm)" }}>
                    {mh.medications.map((m) => (
                      <li key={`${m.name}-${m.dose ?? ""}`}>
                        {m.name}
                        {m.dose ? ` ${m.dose}` : ""}
                        {m.frequency ? ` · ${m.frequency}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {positives(mh.dental).length ? (
                <div className="cw-meta">Dental: {positives(mh.dental).join(" · ")}</div>
              ) : null}
              {mh.notes ? <p className="cw-body">{mh.notes}</p> : null}
            </div>
          ) : (
            <p className="dos-muted" style={{ margin: 0 }}>
              No medical history recorded.
            </p>
          )}
        </Section>
      ) : null}

      <Section title="Past encounters">
        {context.recentEncounters.length === 0 ? (
          <p className="dos-muted" style={{ margin: 0 }}>
            No signed encounters yet.
          </p>
        ) : (
          <ul className="cw-list">
            {context.recentEncounters.map((e) => (
              <li
                key={e.id}
                className="cw-item"
                data-current={e.id === currentEncounterId ? "true" : undefined}
              >
                <Link href={`/clinical/encounters/${e.id}`} className="dos-link">
                  {formatDateTime(e.openedAt)}
                  {e.id === currentEncounterId ? (
                    <span className="dos-sr-only"> (shown)</span>
                  ) : null}
                </Link>
                <span className="cw-meta">
                  {userLabel(e.treatingDentistUserId)} · {branchName(e.branchId)} · signed{" "}
                  {formatDate(e.signedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canDo("plan:read") ? (
        <Section title="Active plans">
          {context.activePlans.length === 0 ? (
            <p className="dos-muted" style={{ margin: 0 }}>
              No active treatment plans.
            </p>
          ) : (
            <ul className="cw-list">
              {context.activePlans.map((p) => (
                <li key={p.id} className="cw-item">
                  <div className="cw-row">
                    <Link href={`/plans/${p.id}`} className="dos-link">
                      {p.title}
                    </Link>
                    <Badge tone={planStatusTone(p.status)}>{humanize(p.status)}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </>
  );
}
