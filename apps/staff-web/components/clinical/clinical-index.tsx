"use client";
import "./clinical.css";
import { Badge, EmptyState, PageHeader, TextField, useLink } from "@dentalos/ui";
import type { PatientSummary } from "@dentalos/validation";
import { useEffect, useState } from "react";
import { clinicalApi } from "../../lib/api/clinical";
import { api } from "../../lib/api/endpoints";
import { useQuery } from "../../lib/api/hooks";
import { formatDateTime, formatPhone, patientName } from "../../lib/format";
import { sessionPrincipal } from "../../lib/session";
import { useDebounced } from "../../lib/use-debounced";
import { Loadable, MockNotice, RequirePermission, Section, useBranches } from "../common";
import { isMe, personLabel } from "./bits";

/** /clinical: open encounters (mine first) and a patient search into the workspace. */
export function ClinicalIndex() {
  return (
    <RequirePermission permission="clinical:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const Link = useLink();
  const { name: branchName } = useBranches();
  const open = useQuery(async () => {
    const page = await clinicalApi.encounters.list({ status: "OPEN", limit: 50 });
    const ids = [...new Set(page.items.map((e) => e.patientId))];
    const patients = await Promise.all(ids.map((id) => api.patients.get(id).catch(() => null)));
    const names = new Map(ids.map((id, k) => [id, patients[k]]));
    const me = sessionPrincipal().userId;
    return page.items
      .map((e) => ({ ...e, patient: names.get(e.patientId) ?? null }))
      .sort(
        (a, b) => Number(b.treatingDentistUserId === me) - Number(a.treatingDentistUserId === me),
      );
  }, []);

  return (
    <div className="dos-stack cw" data-gap="lg">
      <PageHeader
        title="Clinical"
        description="Open encounters and patient charts."
        breadcrumbs={[{ label: "Home", href: "/" }, { label: "Clinical" }]}
      />
      <MockNotice />
      <PatientSearch />
      <Section title="Open encounters">
        <Loadable state={open}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState
                title="No open encounters"
                description="Open one from a patient's clinical workspace."
              />
            ) : (
              <ul className="cw-list">
                {rows.map((e) => (
                  <li key={e.id} className="cw-item">
                    <div className="cw-row">
                      <Link href={`/clinical/encounters/${e.id}`} className="dos-link">
                        {e.patient ? patientName(e.patient) : "Patient"}
                      </Link>
                      {isMe(e.treatingDentistUserId) ? <Badge tone="brand">Yours</Badge> : null}
                    </div>
                    <span className="cw-meta">
                      {e.patient?.mrn ?? "No MRN"} · Treating {personLabel(e.treatingDentistUserId)}{" "}
                      · {branchName(e.branchId)} · opened {formatDateTime(e.openedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </Loadable>
      </Section>
    </div>
  );
}

function PatientSearch() {
  const Link = useLink();
  const [term, setTerm] = useState("");
  const q = useDebounced(term.trim(), 250);
  const [results, setResults] = useState<PatientSummary[] | null>(null);
  useEffect(() => {
    if (q.length < 2) {
      setResults(null);
      return;
    }
    let live = true;
    api.patients.search({ q, limit: 10 }).then(
      (r) => live && setResults(r.items),
      () => live && setResults([]),
    );
    return () => {
      live = false;
    };
  }, [q]);
  return (
    <Section title="Find a patient">
      <TextField
        label="Name, phone or MRN"
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        hint="Type at least 2 characters"
      />
      <div aria-live="polite">
        {results === null ? null : results.length === 0 ? (
          <p className="dos-muted" style={{ margin: 0 }}>
            No patients found.
          </p>
        ) : (
          <ul className="cw-list" aria-label="Matching patients">
            {results.map((p) => (
              <li key={p.id} className="cw-item">
                <Link href={`/clinical/${p.id}`} className="dos-link">
                  {patientName(p)}
                </Link>
                <span className="cw-meta">
                  {p.mrn ?? "No MRN"} · {formatPhone(p.phone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
