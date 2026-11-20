"use client";
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
} from "@dentalos/ui";
import { PATIENT_LIFECYCLE_STAGES, type PatientResponse } from "@dentalos/validation";
import { useMemo, useState } from "react";
import { MockNotice, RequirePermission, useBranches } from "../../../components/common";
import { MergedBanner } from "../../../components/patient-bits";
import { api } from "../../../lib/api/endpoints";
import { type ApiError, errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import {
  ageFrom,
  formatPhone,
  humanize,
  lifecycleTone,
  patientName,
  severityTone,
} from "../../../lib/format";
import { canDo } from "../../../lib/session";
import { ConsentsTab } from "./consents-tab";
import { DocumentsTab } from "./documents-tab";
import { MedicalTab } from "./medical-tab";
import { OverviewTab } from "./overview-tab";
import { ProfileContext, useProfile } from "./profile-context";

export function ProfileClient({ id }: { id: string }) {
  return (
    <RequirePermission permission="patient:read">
      <Inner id={id} />
    </RequirePermission>
  );
}

function Inner({ id }: { id: string }) {
  const patient = useQuery(() => api.patients.get(id), [id]);
  const { name: branchName } = useBranches();
  const [mergedTo, setMergedTo] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");
  const medical = canDo("medical:read");
  const allergies = useQuery(() => api.patients.allergies(id, false), [id], medical);
  const alerts = useQuery(() => api.patients.alerts(id, false), [id], medical);

  const p = patient.data;
  const survivorId = mergedTo ?? p?.mergedIntoId ?? null;

  const ctx = useMemo(
    () =>
      p
        ? {
            patient: p,
            readOnly: Boolean(survivorId),
            reloadPatient: () => {
              patient.reload();
              allergies.reload();
              alerts.reload();
            },
            onWriteError: (e: ApiError) => {
              if (e.mergedSurvivorId) setMergedTo(e.mergedSurvivorId);
            },
            branchName,
          }
        : null,
    [p, survivorId, branchName, patient.reload, allergies.reload, alerts.reload],
  );

  if (patient.error) {
    const e = errorStateFor(patient.error);
    return (
      <ErrorState
        title={patient.error.kind === "not_found" ? "Patient not found" : e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={patient.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!p || !ctx) {
    return (
      <div className="dos-stack" aria-busy="true">
        <span className="dos-sr-only">Loading patient</span>
        <Skeleton height="2rem" width="40%" />
        <Skeleton height="6rem" />
      </div>
    );
  }

  const activeAllergies = allergies.data?.items.filter((a) => a.active) ?? [];
  const activeAlerts = alerts.data?.items.filter((a) => a.active) ?? [];
  const age = ageFrom(p.dob);

  const tabs = [
    { id: "overview", label: "Overview" },
    ...(medical
      ? [
          {
            id: "medical",
            label: "Medical",
            badge: activeAllergies.length + activeAlerts.length || undefined,
          },
        ]
      : []),
    { id: "consents", label: "Consents & communication" },
    ...(canDo("document:read") ? [{ id: "documents", label: "Documents" }] : []),
    { id: "activity", label: "Activity" },
  ];

  return (
    <ProfileContext.Provider value={ctx}>
      <div className="dos-stack" data-gap="lg">
        <header className="dos-stack" data-gap="sm">
          <Breadcrumbs
            items={[
              { label: "Home", href: "/" },
              { label: "Patients", href: "/patients" },
              { label: patientName(p) },
            ]}
          />
          <MockNotice />
          {survivorId ? <MergedBanner survivorId={survivorId} /> : null}
          <Card>
            <div className="dos-stack" data-gap="sm">
              <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
                <div>
                  <h1 style={{ fontSize: "var(--text-xl)", fontWeight: 600 }}>
                    {patientName(p)}
                    {p.preferredName ? (
                      <span className="dos-muted" style={{ fontWeight: 400 }}>
                        {" "}
                        “{p.preferredName}”
                      </span>
                    ) : null}
                  </h1>
                  <div className="dos-muted">
                    {p.mrn ?? "No MRN"} · {age === null ? "Age unknown" : `${age} years`} ·{" "}
                    {humanize(p.sex)} · {formatPhone(p.phone)} · Registered at{" "}
                    {branchName(p.originBranchId)}
                  </div>
                </div>
                <LifecycleControl patient={p} />
              </div>
              {medical ? (
                <ul
                  className="dos-cluster"
                  aria-label="Allergies and clinical alerts"
                  style={{ listStyle: "none", margin: 0, padding: 0 }}
                >
                  {activeAllergies.length === 0 && activeAlerts.length === 0 ? (
                    <li>
                      <Badge tone="success">
                        {allergies.data ? "No known allergies or alerts" : "Loading alerts…"}
                      </Badge>
                    </li>
                  ) : null}
                  {activeAllergies.map((a) => (
                    <li key={a.id}>
                      <Badge tone={severityTone(a.severity)}>
                        Allergy: {a.substance} ({humanize(a.severity)})
                      </Badge>
                    </li>
                  ))}
                  {activeAlerts.map((a) => (
                    <li key={a.id}>
                      <Badge tone={severityTone(a.severity)}>
                        Alert: {a.title} ({humanize(a.severity)})
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="dos-cluster">
                <Badge tone="neutral">Intake: {humanize(p.intakeType)}</Badge>
                {p.identityVerifiedAt ? (
                  <Badge tone="success">Identity verified</Badge>
                ) : (
                  <Badge tone="warning">Identity not verified</Badge>
                )}
              </div>
            </div>
          </Card>
        </header>

        <Tabs label="Patient record sections" items={tabs} value={tab} onValueChange={setTab}>
          {tab === "overview" ? <OverviewTab /> : null}
          {tab === "medical" && medical ? (
            <MedicalTab
              onAlertsChanged={() => {
                allergies.reload();
                alerts.reload();
              }}
            />
          ) : null}
          {tab === "consents" ? <ConsentsTab /> : null}
          {tab === "documents" ? <DocumentsTab /> : null}
          {tab === "activity" ? (
            <EmptyState
              title="Activity timeline is coming"
              description="Appointments, visits, invoices and messages will appear here as those modules ship (M2–M3)."
            />
          ) : null}
        </Tabs>
      </div>
    </ProfileContext.Provider>
  );
}

function LifecycleControl({ patient }: { patient: PatientResponse }) {
  const { readOnly, onWriteError, reloadPatient } = useProfile();
  const [stage, setStage] = useState<string>(patient.lifecycleStage);
  const editable = canDo("patient:write") && !readOnly;
  const move = useMutation((s: string) => api.patients.setLifecycle(patient.id, s), {
    success: (r) => `Stage changed to ${humanize(r.lifecycleStage)}`,
    onSuccess: reloadPatient,
    onError: (e) => {
      setStage(patient.lifecycleStage);
      onWriteError(e);
    },
  });
  if (!editable)
    return (
      <Badge tone={lifecycleTone(patient.lifecycleStage)}>{humanize(patient.lifecycleStage)}</Badge>
    );
  return (
    <div className="dos-field" style={{ minWidth: 180 }}>
      <label className="dos-label" htmlFor="lifecycle-stage">
        Lifecycle stage
      </label>
      <select
        id="lifecycle-stage"
        className="dos-select"
        value={stage}
        disabled={move.pending}
        onChange={(e) => {
          setStage(e.target.value);
          void move.run(e.target.value);
        }}
      >
        {PATIENT_LIFECYCLE_STAGES.map((s) => (
          <option key={s} value={s}>
            {humanize(s)}
          </option>
        ))}
      </select>
    </div>
  );
}
