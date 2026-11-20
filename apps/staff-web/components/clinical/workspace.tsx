"use client";
import "./clinical.css";
import {
  Alert,
  Badge,
  Breadcrumbs,
  Button,
  EmptyState,
  ErrorState,
  SelectField,
  Skeleton,
  Tabs,
  useLink,
} from "@dentalos/ui";
import type { ClinicalContextResponse, EncounterDetailResponse } from "@dentalos/validation";
import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { clinicalApi } from "../../lib/api/clinical";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import { formatDateTime, patientName } from "../../lib/format";
import { canDo } from "../../lib/session";
import { Loadable, MockNotice, RequirePermission, useBranches } from "../common";
import { AttachmentsPanel } from "./attachments-panel";
import { personLabel } from "./bits";
import { ChartPanel } from "./chart-panel";
import { EncounterPanel, OpenEncounterDialog } from "./encounter-panel";
import { FindingsPanel } from "./findings-panel";
import { HistoryPanel } from "./history-panel";
import { NotesPanel } from "./notes-panel";
import { PatientBanner } from "./patient-banner";
import { PatientPlans } from "./plans/plan-list";

/**
 * Clinical workspace (PRD 3.4): sticky identity + alerts, the encounter context (treating dentist,
 * branch, status) always visible, and tabs for the odontogram, notes, diagnoses & procedures,
 * attachments and treatment plans. `/clinical/[patientId]` opens the patient's latest OPEN
 * encounter; `/clinical/encounters/[id]` shows a specific (possibly signed) encounter.
 */
export function ClinicalWorkspace({
  patientId,
  encounterId,
}: {
  patientId: string;
  encounterId?: string;
}) {
  return (
    <RequirePermission permission="clinical:read">
      <Inner patientId={patientId} encounterId={encounterId} />
    </RequirePermission>
  );
}

function Inner({ patientId, encounterId }: { patientId: string; encounterId?: string }) {
  const ctx = useQuery(() => clinicalApi.context(patientId), [patientId]);
  const { name: branchName } = useBranches();
  const [picked, setPicked] = useState<string | undefined>(encounterId);
  const [tab, setTab] = useState("chart");
  const [opening, setOpening] = useState(false);

  const c = ctx.data;
  const currentId = picked ?? c?.openEncounters[0]?.id;
  const enc = useQuery(
    () => clinicalApi.encounters.get(currentId ?? ""),
    [currentId],
    Boolean(currentId),
  );
  const encounter = currentId && enc.data?.id === currentId ? enc.data : undefined;
  const changed = () => {
    // Pin the encounter in view: after signing it leaves `openEncounters`, and the dentist should
    // still see the signed record (and its "Add amendment" entry point), not "No open encounter".
    if (currentId && !picked) setPicked(currentId);
    enc.reload();
    ctx.reload();
  };

  if (ctx.error) {
    const e = errorStateFor(ctx.error);
    return (
      <ErrorState
        title={ctx.error.kind === "not_found" ? "Patient not found" : e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={ctx.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!c)
    return (
      <div className="dos-stack" aria-busy="true">
        <span className="dos-sr-only">Loading clinical workspace</span>
        <Skeleton height="4.5rem" />
        <Skeleton height="20rem" />
      </div>
    );

  const writable = canDo("clinical:write");
  const needsEncounter = (node: (e: EncounterDetailResponse) => ReactNode) =>
    !currentId ? (
      <EmptyState
        title="No encounter open"
        description={
          writable
            ? "Open an encounter to record notes, findings and attachments for this visit."
            : "There is no open encounter for this patient."
        }
        action={
          writable ? (
            <Button onClick={() => setOpening(true)}>
              <Plus size={16} aria-hidden="true" /> Open encounter
            </Button>
          ) : undefined
        }
      />
    ) : (
      <Loadable state={enc} rows={5}>
        {() => (encounter ? node(encounter) : null)}
      </Loadable>
    );

  const tabs = [
    { id: "chart", label: "Odontogram" },
    { id: "notes", label: "Notes", badge: encounter?.notes.length || undefined },
    {
      id: "findings",
      label: "Diagnoses & procedures",
      badge: encounter
        ? encounter.diagnoses.length + encounter.procedures.length || undefined
        : undefined,
    },
    { id: "attachments", label: "Attachments" },
    ...(canDo("plan:read")
      ? [{ id: "plans", label: "Treatment plans", badge: c.activePlans.length || undefined }]
      : []),
  ];

  return (
    <div className="dos-stack cw" data-gap="lg">
      <div className="dos-stack" data-gap="sm">
        <Breadcrumbs
          items={[
            { label: "Home", href: "/" },
            { label: "Clinical", href: "/clinical" },
            { label: patientName(c.patient) },
          ]}
        />
        <MockNotice />
      </div>
      <PatientBanner context={c} branchName={branchName} />
      <div className="cw-layout">
        <div className="dos-stack" style={{ minWidth: 0 }}>
          <EncounterContextBar
            context={c}
            currentId={currentId}
            encounter={encounter}
            branchName={branchName}
            onPick={setPicked}
            routeEncounterId={encounterId}
            onOpen={writable ? () => setOpening(true) : undefined}
          />
          <Tabs label="Clinical record sections" items={tabs} value={tab} onValueChange={setTab}>
            {tab === "chart" ? (
              <ChartPanel patientId={patientId} encounter={encounter} onChanged={changed} />
            ) : null}
            {tab === "notes"
              ? needsEncounter((e) => <NotesPanel encounter={e} onChanged={changed} />)
              : null}
            {tab === "findings"
              ? needsEncounter((e) => <FindingsPanel encounter={e} onChanged={changed} />)
              : null}
            {tab === "attachments"
              ? needsEncounter((e) => <AttachmentsPanel encounter={e} onChanged={changed} />)
              : null}
            {tab === "plans" ? (
              <PatientPlans
                patientId={patientId}
                defaultBranchId={encounter?.branchId ?? c.patient.originBranchId}
                encounterId={encounter?.status === "OPEN" ? encounter.id : undefined}
                onChanged={ctx.reload}
              />
            ) : null}
          </Tabs>
        </div>
        <aside className="cw-aside" aria-label="Encounter and history">
          {encounter ? (
            <EncounterPanel encounter={encounter} branchName={branchName} onChanged={changed} />
          ) : null}
          <HistoryPanel context={c} currentEncounterId={currentId} branchName={branchName} />
        </aside>
      </div>
      {opening ? (
        <OpenEncounterDialog
          patientId={patientId}
          defaultBranchId={c.patient.originBranchId}
          onClose={() => setOpening(false)}
          onDone={(e) => {
            setOpening(false);
            setPicked(e.id);
            ctx.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** Always-visible encounter context: which encounter, who treats, where, and its state. */
function EncounterContextBar({
  context,
  currentId,
  encounter,
  branchName,
  onPick,
  routeEncounterId,
  onOpen,
}: {
  context: ClinicalContextResponse;
  currentId: string | undefined;
  encounter: EncounterDetailResponse | undefined;
  branchName: (id: string | null | undefined) => string;
  onPick: (id: string | undefined) => void;
  /** Set on /clinical/encounters/[id]; there "back" is a link to the patient's workspace. */
  routeEncounterId?: string;
  onOpen?: () => void;
}) {
  const Link = useLink();
  const open = context.openEncounters;
  const viewingOther = currentId && !open.some((e) => e.id === currentId);
  return (
    <div className="cw-item" style={{ background: "var(--color-surface)" }} aria-live="polite">
      <div className="cw-row">
        {encounter ? (
          <div style={{ minWidth: 0 }}>
            <div className="dos-cluster" style={{ gap: "var(--space-2)" }}>
              <Badge tone={encounter.status === "OPEN" ? "info" : "success"}>
                {encounter.status === "OPEN" ? "Open encounter" : "Signed encounter"}
              </Badge>
              <strong>Treating: {personLabel(encounter.treatingDentistUserId)}</strong>
            </div>
            <div className="cw-meta">
              {branchName(encounter.branchId)} · opened {formatDateTime(encounter.openedAt)}
              {encounter.signedAt ? ` · signed ${formatDateTime(encounter.signedAt)}` : ""}
            </div>
          </div>
        ) : currentId ? (
          <span className="cw-meta">Loading encounter…</span>
        ) : (
          <span className="dos-muted">No open encounter. The chart and history are read-only.</span>
        )}
        <div className="dos-cluster">
          {open.length > 1 ? (
            <SelectField
              label="Open encounters"
              value={open.some((e) => e.id === currentId) ? currentId : ""}
              onChange={(e) => e.target.value && onPick(e.target.value)}
            >
              <option value="">Select…</option>
              {open.map((e) => (
                <option key={e.id} value={e.id}>
                  {formatDateTime(e.openedAt)} · {personLabel(e.treatingDentistUserId)}
                </option>
              ))}
            </SelectField>
          ) : null}
          {onOpen && open.length === 0 ? (
            <Button size="sm" onClick={onOpen}>
              <Plus size={16} aria-hidden="true" /> Open encounter
            </Button>
          ) : null}
        </div>
      </div>
      {viewingOther && encounter?.status === "SIGNED" ? (
        <Alert tone="info">
          You are viewing a signed encounter.{" "}
          {open[0] || !routeEncounterId ? (
            <button
              type="button"
              className="dos-link"
              style={{
                background: "none",
                border: 0,
                padding: 0,
                font: "inherit",
                cursor: "pointer",
              }}
              onClick={() => onPick(open[0]?.id)}
            >
              {open[0] ? "Go to the open encounter" : "Back to the workspace"}
            </button>
          ) : (
            <Link href={`/clinical/${context.patient.id}`} className="dos-link">
              Back to the workspace
            </Link>
          )}
        </Alert>
      ) : null}
    </div>
  );
}
