"use client";
import { Alert, Badge, Button, ErrorState, Skeleton, Tabs, useLink } from "@dentalos/ui";
import { canTransitionPlan } from "@dentalos/validation";
import { type ReactNode, useState } from "react";
import type { PlanDetail, PlanItemDetail } from "../../../lib/api/clinical-types";
import { errorStateFor } from "../../../lib/api/errors";
import { useQuery } from "../../../lib/api/hooks";
import { plansApi } from "../../../lib/api/plans";
import { decisionTargets, isPlanClosed, isPlanDecided } from "../../../lib/api/plans-rules";
import { formatDate, formatDateTime, humanize } from "../../../lib/format";
import { canDo, userLabel } from "../../../lib/session";
import { Loadable, Section, useBranches } from "../../common";
import { Kv, StatusBadge, personLabel, planStatusTone, useServiceDirectory } from "../bits";
import {
  ApproveDialog,
  CancelPlanDialog,
  ConsentDialog,
  DecisionsDialog,
  EditPlanDialog,
  PresentPlanDialog,
} from "./plan-actions";
import { PlanHistory } from "./plan-history";
import { PlanItemsBuilder } from "./plan-items";
import { PlanSessions } from "./plan-sessions";

type DialogKind = "edit" | "present" | "decide" | "consent" | "approve" | "cancel";

/**
 * One treatment plan: header (status, version, totals), lifecycle actions gated by permission and
 * state, and tabs for the builder, sessions, version history/diff and signed consents.
 */
export function PlanDetailView({
  planId,
  onChanged,
  encounterId,
  showPatientLink,
}: {
  planId: string;
  onChanged?: () => void;
  encounterId?: string;
  showPatientLink?: boolean;
}) {
  const q = useQuery(() => plansApi.get(planId), [planId]);
  const [local, setLocal] = useState<PlanDetail | null>(null);
  const plan =
    local && local.id === planId && q.data && local.updatedAt >= q.data.updatedAt ? local : q.data;
  const services = useServiceDirectory(plan?.branchId);
  const { name: branchName } = useBranches();
  const [tab, setTab] = useState("items");
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [focusItem, setFocusItem] = useState<string>();
  const [consentId, setConsentId] = useState<string>();
  const Link = useLink();

  if (q.error && !plan) {
    const e = errorStateFor(q.error);
    return (
      <ErrorState
        title={q.error.kind === "not_found" ? "Plan not found" : e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={q.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!plan)
    return (
      <div className="dos-stack" aria-busy="true">
        <span className="dos-sr-only">Loading plan</span>
        <Skeleton height="2rem" width="50%" />
        <Skeleton height="8rem" />
      </div>
    );

  const scope = { branchId: plan.branchId };
  const closed = isPlanClosed(plan.status);
  const canWrite = canDo("plan:write", scope) && !closed;
  const canApprove = canDo("plan:approve", scope) && !closed;
  const canConsent = canDo("consent:manage", scope) && !closed && plan.currentVersion > 0;
  const live = plan.items.filter((i) => i.status !== "CANCELLED");
  const presentable =
    canWrite &&
    canTransitionPlan(plan.status, "PRESENTED") &&
    (plan.status === "DRAFT" || plan.status === "REJECTED") &&
    live.length > 0;
  const decidable =
    canApprove &&
    plan.status !== "DRAFT" &&
    plan.items.some((i) => decisionTargets(i.status).length);
  const approvable = canApprove && isPlanDecided(plan.status);

  const applied = (p: PlanDetail) => {
    setLocal(p);
    setDialog(null);
    q.reload();
    onChanged?.();
  };
  const openSessions = (i: PlanItemDetail) => {
    setFocusItem(i.id);
    setTab("sessions");
  };

  return (
    <Section
      title={plan.title}
      description={plan.notes ?? undefined}
      actions={
        <>
          <Badge tone={planStatusTone(plan.status)}>{humanize(plan.status)}</Badge>
          <Badge tone="neutral">
            {plan.currentVersion ? `Version ${plan.currentVersion}` : "Draft, not presented"}
          </Badge>
        </>
      }
    >
      <Kv
        items={[
          ["Branch", branchName(plan.branchId)],
          ["Created", `${formatDate(plan.createdAt)} by ${personLabel(plan.createdBy)}`],
          ...(plan.presentedAt
            ? ([
                [
                  "Presented",
                  `${formatDateTime(plan.presentedAt)} by ${personLabel(plan.presentedBy)}`,
                ],
              ] as [string, string][])
            : []),
          ...(plan.approvedAt
            ? ([
                [
                  "Approved",
                  `${formatDateTime(plan.approvedAt)} by ${personLabel(plan.approvedBy)}`,
                ],
              ] as [string, string][])
            : []),
          ...(plan.cancelReason ? ([["Cancelled", plan.cancelReason]] as [string, string][]) : []),
          ...(showPatientLink
            ? ([
                [
                  "Patient",
                  <Link key="p" href={`/clinical/${plan.patientId}`} className="dos-link">
                    Open clinical workspace
                  </Link>,
                ],
              ] as [string, ReactNode][])
            : []),
        ]}
      />
      {closed ? (
        <Alert tone="info">
          This plan is {humanize(plan.status).toLowerCase()} and can no longer change.
        </Alert>
      ) : null}
      <div className="dos-cluster">
        {presentable ? (
          <Button onClick={() => setDialog("present")}>Present to patient</Button>
        ) : null}
        {decidable ? (
          <Button variant="secondary" onClick={() => setDialog("decide")}>
            Record decisions
          </Button>
        ) : null}
        {canConsent ? (
          <Button variant="secondary" onClick={() => setDialog("consent")}>
            Capture consent
          </Button>
        ) : null}
        {approvable ? (
          <Button
            variant={plan.approvedAt ? "secondary" : "primary"}
            onClick={() => setDialog("approve")}
          >
            {plan.approvedAt ? "Re-approve current version" : "Approve plan"}
          </Button>
        ) : null}
        {canWrite ? (
          <Button variant="ghost" onClick={() => setDialog("edit")}>
            Edit details
          </Button>
        ) : null}
        {canWrite && canTransitionPlan(plan.status, "CANCELLED") ? (
          <Button variant="ghost" onClick={() => setDialog("cancel")}>
            Cancel plan
          </Button>
        ) : null}
      </div>

      <Tabs
        label={`${plan.title} sections`}
        value={tab}
        onValueChange={setTab}
        items={[
          { id: "items", label: "Plan", badge: plan.items.length || undefined },
          { id: "sessions", label: "Sessions" },
          { id: "history", label: "Versions", badge: plan.currentVersion || undefined },
          ...(canDo("consent:manage", scope) ? [{ id: "consents", label: "Consents" }] : []),
        ]}
      >
        {tab === "items" ? (
          <PlanItemsBuilder
            plan={plan}
            services={services}
            canWrite={canWrite}
            onPlan={applied}
            onSessions={openSessions}
          />
        ) : null}
        {tab === "sessions" ? (
          <PlanSessions
            plan={plan}
            services={services}
            canWrite={canWrite}
            focusItemId={focusItem}
            encounterId={encounterId}
            onPlanChanged={() => {
              q.reload();
              onChanged?.();
            }}
          />
        ) : null}
        {tab === "history" ? <PlanHistory plan={plan} /> : null}
        {tab === "consents" ? <PlanConsents plan={plan} /> : null}
      </Tabs>

      {dialog === "edit" ? (
        <EditPlanDialog plan={plan} onClose={() => setDialog(null)} onDone={applied} />
      ) : null}
      {dialog === "present" ? (
        <PresentPlanDialog plan={plan} onClose={() => setDialog(null)} onDone={applied} />
      ) : null}
      {dialog === "decide" ? (
        <DecisionsDialog
          plan={plan}
          label={services.label}
          onClose={() => setDialog(null)}
          onDone={applied}
        />
      ) : null}
      {dialog === "cancel" ? (
        <CancelPlanDialog plan={plan} onClose={() => setDialog(null)} onDone={applied} />
      ) : null}
      {dialog === "consent" ? (
        <ConsentDialog
          plan={plan}
          onClose={() => setDialog(null)}
          onDone={(c) => {
            setConsentId(c.id);
            setDialog(approvable ? "approve" : null);
            onChanged?.();
          }}
        />
      ) : null}
      {dialog === "approve" ? (
        <ApproveDialog
          plan={plan}
          preselectConsentId={consentId}
          onClose={() => setDialog(null)}
          onDone={applied}
          onNeedConsent={() => setDialog(canDo("consent:manage", scope) ? "consent" : null)}
        />
      ) : null}
    </Section>
  );
}

function PlanConsents({ plan }: { plan: PlanDetail }) {
  const consents = useQuery(() => plansApi.consents(plan.id), [plan.id, plan.currentVersion]);
  const versions = useQuery(
    () => plansApi.versions(plan.id),
    [plan.id, plan.currentVersion],
    plan.currentVersion > 0,
  );
  const versionOf = (id: string | null) => versions.data?.items.find((v) => v.id === id)?.version;
  return (
    <Loadable state={consents}>
      {(c) =>
        c.items.length === 0 ? (
          <p className="dos-muted" style={{ margin: 0 }}>
            No consent signed for this plan yet.
          </p>
        ) : (
          <ul className="cw-list">
            {c.items.map((x) => {
              const v = versionOf(x.planVersionId);
              return (
                <li key={x.id} className="cw-item">
                  <div className="cw-row">
                    <strong>
                      {x.signerName
                        ? `${x.signerName} (${humanize(x.signerRelationship ?? "")})`
                        : "Signed by the patient"}
                    </strong>
                    <StatusBadge
                      status={x.status}
                      tone={x.status === "GRANTED" ? "success" : "neutral"}
                    />
                  </div>
                  <span className="cw-meta">
                    Plan version {v ?? "?"}
                    {v !== undefined && v !== plan.currentVersion
                      ? " (outdated: the plan changed since)"
                      : ""}{" "}
                    · consent text v{x.version} · {humanize(x.method ?? "")} ·{" "}
                    {formatDateTime(x.grantedAt)} · captured by {userLabel(x.capturedBy)}
                  </span>
                </li>
              );
            })}
          </ul>
        )
      }
    </Loadable>
  );
}
