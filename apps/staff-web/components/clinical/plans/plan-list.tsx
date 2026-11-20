"use client";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import { type TreatmentPlanSummary, createPlanRequest } from "@dentalos/validation";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { plansApi } from "../../../lib/api/plans";
import { formatDate, formatPaise, humanize } from "../../../lib/format";
import { type FieldErrors, validate } from "../../../lib/forms";
import { canDo, scopedBranchIds } from "../../../lib/session";
import { BranchOptions, Loadable, Section, useBranches } from "../../common";
import { planStatusTone } from "../bits";
import { PlanDetailView } from "./plan-detail";

/**
 * Treatment plans of a patient (PRD 4.5): list, create, and the selected plan's builder inline.
 * Standalone page: /plans/[id].
 */
export function PatientPlans({
  patientId,
  defaultBranchId,
  encounterId,
  onChanged,
}: {
  patientId: string;
  defaultBranchId: string;
  encounterId?: string;
  onChanged?: () => void;
}) {
  const list = useQuery(() => plansApi.list({ patientId, limit: 50 }), [patientId]);
  const { name: branchName } = useBranches();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const plans = list.data?.items ?? [];
  const activeId =
    selected ?? plans.find((p) => p.status !== "CANCELLED")?.id ?? plans[0]?.id ?? null;

  return (
    <div className="dos-stack" data-gap="lg">
      <Section
        title="Treatment plans"
        actions={
          canDo("plan:write") ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" /> New plan
            </Button>
          ) : undefined
        }
      >
        <Loadable state={list}>
          {() =>
            plans.length === 0 ? (
              <EmptyState
                title="No treatment plans"
                description={
                  canDo("plan:write")
                    ? "Create a plan to propose treatment with estimates."
                    : undefined
                }
              />
            ) : (
              <ul className="cw-list" aria-label="Plans">
                {plans.map((p) => (
                  <PlanRow
                    key={p.id}
                    plan={p}
                    current={p.id === activeId}
                    branchName={branchName}
                    onSelect={() => setSelected(p.id)}
                  />
                ))}
              </ul>
            )
          }
        </Loadable>
      </Section>
      {activeId ? (
        <PlanDetailView
          key={activeId}
          planId={activeId}
          onChanged={() => {
            list.reload();
            onChanged?.();
          }}
        />
      ) : null}
      {creating ? (
        <CreatePlanDialog
          patientId={patientId}
          defaultBranchId={defaultBranchId}
          encounterId={encounterId}
          onClose={() => setCreating(false)}
          onDone={(id) => {
            setCreating(false);
            setSelected(id);
            list.reload();
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

function PlanRow({
  plan,
  current,
  branchName,
  onSelect,
}: {
  plan: TreatmentPlanSummary;
  current: boolean;
  branchName: (id: string) => string;
  onSelect: () => void;
}) {
  return (
    <li className="cw-item" data-current={current ? "true" : undefined}>
      <div className="cw-row">
        <button
          type="button"
          className="dos-link"
          style={{
            background: "none",
            border: 0,
            padding: 0,
            font: "inherit",
            cursor: "pointer",
            textAlign: "left",
          }}
          aria-current={current ? "true" : undefined}
          onClick={onSelect}
        >
          {plan.title}
        </button>
        <Badge tone={planStatusTone(plan.status)}>{humanize(plan.status)}</Badge>
      </div>
      <span className="cw-meta">
        {plan.currentVersion ? `Version ${plan.currentVersion}` : "Not presented"} ·{" "}
        {branchName(plan.branchId)} · created {formatDate(plan.createdAt)} · estimate{" "}
        {formatPaise(plan.totals.estimatePaise)} · accepted {formatPaise(plan.totals.acceptedPaise)}
      </span>
    </li>
  );
}

function CreatePlanDialog({
  patientId,
  defaultBranchId,
  encounterId,
  onClose,
  onDone,
}: {
  patientId: string;
  defaultBranchId: string;
  encounterId?: string;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const { branches } = useBranches();
  const allowed = scopedBranchIds(branches).filter((b) => canDo("plan:write", { branchId: b }));
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [linkEncounter, setLinkEncounter] = useState(Boolean(encounterId));
  const [errors, setErrors] = useState<FieldErrors>({});
  const effectiveBranch = allowed.includes(branchId) ? branchId : (allowed[0] ?? branchId);
  const save = useMutation((b: Parameters<typeof plansApi.create>[0]) => plansApi.create(b), {
    success: "Plan created",
    onSuccess: (p) => onDone(p.id),
    onError: (e) => setErrors({ ...e.fieldErrors, _form: e.message }),
  });
  const submit = () => {
    const r = validate(createPlanRequest, {
      patientId,
      branchId: effectiveBranch,
      title,
      notes,
      encounterId: linkEncounter ? encounterId : undefined,
      items: [],
    });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New treatment plan"
      description="Items are added next; each estimate is frozen at this branch's price when it is added."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Create plan
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <TextField
          label="Title"
          required
          value={title}
          error={errors.title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <SelectField
          label="Branch (prices)"
          required
          value={effectiveBranch}
          error={errors.branchId}
          onChange={(e) => setBranchId(e.target.value)}
        >
          <BranchOptions branches={branches} ids={allowed} />
        </SelectField>
        <TextareaField
          label="Notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {encounterId ? (
          <Checkbox
            label="Link to the open encounter"
            checked={linkEncounter}
            onChange={(e) => setLinkEncounter(e.target.checked)}
          />
        ) : null}
        {errors._form && !errors.title && !errors.branchId ? (
          <Alert tone="danger">{errors._form}</Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
