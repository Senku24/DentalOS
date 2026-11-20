"use client";
import {
  Alert,
  Button,
  Dialog,
  RadioGroup,
  SelectField,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  DOCUMENT_CONTENT_TYPES,
  type DecidePlanItemsRequest,
  MAX_DOCUMENT_BYTES,
  SIGNER_RELATIONSHIPS,
  type SignedConsentResponse,
  cancelPlanRequest,
  decidePlanItemsRequest,
  signConsentRequest,
  updatePlanRequest,
} from "@dentalos/validation";
import { useState } from "react";
import type { PlanDetail } from "../../../lib/api/clinical-types";
import { api } from "../../../lib/api/endpoints";
import { type ApiError, asApiError } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { plansApi } from "../../../lib/api/plans";
import { type Decision, decisionTargets, needsReason } from "../../../lib/api/plans-rules";
import { uploadDocument } from "../../../lib/api/upload";
import { formatBytes, formatDateTime, formatPaise, humanize } from "../../../lib/format";
import { type FieldErrors, validate } from "../../../lib/forms";
import { canDo, userLabel } from "../../../lib/session";
import { StatusBadge } from "../bits";
import { toothShort } from "../fdi";

type Done = (p: PlanDetail) => void;
type Label = (serviceId: string) => string;
const onErr = (set: (e: FieldErrors) => void) => (e: ApiError) =>
  set({ ...e.fieldErrors, _form: e.message });

function Footer({
  onClose,
  label,
  pending,
  onConfirm,
  disabled,
  danger,
}: {
  onClose: () => void;
  label: string;
  pending: boolean;
  onConfirm: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <>
      <Button variant="secondary" onClick={onClose} disabled={pending}>
        Cancel
      </Button>
      <Button
        variant={danger ? "danger" : "primary"}
        loading={pending}
        disabled={disabled}
        onClick={onConfirm}
      >
        {label}
      </Button>
    </>
  );
}

export function EditPlanDialog({
  plan,
  onClose,
  onDone,
}: { plan: PlanDetail; onClose: () => void; onDone: Done }) {
  const [title, setTitle] = useState(plan.title);
  const [notes, setNotes] = useState(plan.notes ?? "");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation(
    (b: Parameters<typeof plansApi.update>[1]) => plansApi.update(plan.id, b),
    {
      success: "Plan updated",
      onSuccess: onDone,
      onError: onErr(setErrors),
    },
  );
  const submit = () => {
    const r = validate(updatePlanRequest, { title, notes: notes.trim() || null, reason });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit plan details"
      description={
        plan.currentVersion > 0
          ? "The plan has been presented: saving creates a new version."
          : undefined
      }
      footer={<Footer onClose={onClose} label="Save" pending={save.pending} onConfirm={submit} />}
    >
      <div className="dos-stack">
        <TextField
          label="Title"
          required
          value={title}
          error={errors.title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextareaField
          label="Notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {plan.currentVersion > 0 ? (
          <TextField
            label="Reason for change"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        ) : null}
        {errors._form && !errors.title ? <Alert tone="danger">{errors._form}</Alert> : null}
      </div>
    </Dialog>
  );
}

export function PresentPlanDialog({
  plan,
  onClose,
  onDone,
}: { plan: PlanDetail; onClose: () => void; onDone: Done }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const save = useMutation(() => plansApi.present(plan.id, reason.trim() || undefined), {
    success: (p) => `Presented as version ${p.currentVersion}`,
    onSuccess: onDone,
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        plan.status === "REJECTED" ? "Re-present the revised plan?" : "Present plan to the patient?"
      }
      description="Presenting freezes this content as a numbered version. Later changes create new versions; presented items are never deleted."
      footer={
        <Footer
          onClose={onClose}
          label="Present plan"
          pending={save.pending}
          onConfirm={() => void save.run()}
        />
      }
    >
      <div className="dos-stack">
        <TextField
          label="Note for this version"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Dialog>
  );
}

const DECISION_LABEL: Record<Decision, string> = {
  ACCEPTED: "Accept",
  REJECTED: "Reject",
  DEFERRED: "Defer",
};

/** Per-item patient decisions (accept / reject / defer with reason), recorded as one version. */
export function DecisionsDialog({
  plan,
  label,
  onClose,
  onDone,
}: {
  plan: PlanDetail;
  label: Label;
  onClose: () => void;
  onDone: Done;
}) {
  const items = plan.items
    .filter((i) => decisionTargets(i.status).length > 0)
    .sort((a, b) => a.phase - b.phase || a.sequence - b.sequence);
  const [choice, setChoice] = useState<Record<string, Decision | "">>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation((b: DecidePlanItemsRequest) => plansApi.decide(plan.id, b), {
    success: "Decisions recorded",
    onSuccess: onDone,
    onError: onErr(setErrors),
  });
  const decisions = items
    .filter((i) => choice[i.id])
    .map((i) => ({
      itemId: i.id,
      decision: choice[i.id] as Decision,
      reason: reasons[i.id] ?? "",
    }));
  const submit = () => {
    if (decisions.length === 0)
      return setErrors({ _form: "Choose a decision for at least one item." });
    const r = validate(decidePlanItemsRequest, { decisions });
    if (!r.ok) {
      // "decisions.2.reason" → the item's reason field
      const mapped: FieldErrors = {};
      for (const [k, v] of Object.entries(r.errors)) {
        const m = /^decisions\.(\d+)\.reason$/.exec(k);
        const d = m ? decisions[Number(m[1])] : undefined;
        mapped[d ? `reason:${d.itemId}` : "_form"] = v;
      }
      return setErrors(mapped);
    }
    void save.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record patient decisions"
      description="Record what the patient decided for each item. Rejecting or deferring needs a reason. Accepted items can be scheduled."
      footer={
        <Footer
          onClose={onClose}
          label={`Record ${decisions.length || ""} decision${decisions.length === 1 ? "" : "s"}`}
          pending={save.pending}
          onConfirm={submit}
        />
      }
    >
      <div className="dos-stack">
        {items.length === 0 ? <Alert tone="info">No items are awaiting a decision.</Alert> : null}
        {items.map((i) => {
          const c = choice[i.id] ?? "";
          return (
            <div key={i.id} className="cw-item">
              <div className="cw-row">
                <strong>
                  {label(i.serviceId)}{" "}
                  {i.toothCode ? `· ${toothShort(i.toothCode, i.surfaces)}` : ""}
                </strong>
                <span className="cw-money">
                  {formatPaise(i.lineTotalPaise ?? i.estimatePricePaise * i.quantity)}
                </span>
              </div>
              <span className="cw-meta">
                Phase {i.phase} · now <StatusBadge status={i.status} />
              </span>
              <RadioGroup
                legend={`Decision for ${label(i.serviceId)}`}
                hideLegend
                name={`decision-${i.id}`}
                value={c}
                onChange={(v) => setChoice((s) => ({ ...s, [i.id]: v as Decision | "" }))}
                options={[
                  { value: "", label: "No change" },
                  ...decisionTargets(i.status).map((d) => ({ value: d, label: DECISION_LABEL[d] })),
                ]}
              />
              {c && needsReason(c) ? (
                <TextField
                  label={`Reason to ${DECISION_LABEL[c].toLowerCase()}`}
                  required
                  value={reasons[i.id] ?? ""}
                  error={errors[`reason:${i.id}`]}
                  onChange={(e) => setReasons((s) => ({ ...s, [i.id]: e.target.value }))}
                />
              ) : null}
            </div>
          );
        })}
        {errors._form ? <Alert tone="danger">{errors._form}</Alert> : null}
      </div>
    </Dialog>
  );
}

export function CancelPlanDialog({
  plan,
  onClose,
  onDone,
}: { plan: PlanDetail; onClose: () => void; onDone: Done }) {
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation((r: string) => plansApi.cancel(plan.id, r), {
    success: "Plan cancelled",
    onSuccess: onDone,
    onError: onErr(setErrors),
  });
  const submit = () => {
    const r = validate(cancelPlanRequest, { reason });
    if (!r.ok) return setErrors(r.errors);
    void save.run(r.data.reason);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Cancel this plan?"
      description="Cancelled plans are kept for history and can't be reopened. Booked sessions must be cancelled separately."
      footer={
        <Footer
          onClose={onClose}
          label="Cancel plan"
          danger
          pending={save.pending}
          onConfirm={submit}
        />
      }
    >
      <div className="dos-stack">
        <TextareaField
          label="Reason"
          required
          rows={2}
          value={reason}
          error={errors.reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {errors._form && !errors.reason ? <Alert tone="danger">{errors._form}</Alert> : null}
      </div>
    </Dialog>
  );
}

/** Current version id (the consent must reference the version the patient saw). */
function useCurrentVersionId(plan: PlanDetail) {
  const versions = useQuery(
    () => plansApi.versions(plan.id),
    [plan.id, plan.currentVersion],
    plan.currentVersion > 0,
  );
  return {
    id: versions.data?.items.find((v) => v.version === plan.currentVersion)?.id,
    loading: versions.loading,
  };
}

/**
 * Consent capture for the plan's current version: template version (TREATMENT_PLAN), signer and the
 * signature document (an uploaded CONSENT_FORM document of the patient).
 */
export function ConsentDialog({
  plan,
  onClose,
  onDone,
}: {
  plan: PlanDetail;
  onClose: () => void;
  onDone: (c: SignedConsentResponse) => void;
}) {
  const templates = useQuery(
    () => plansApi.consent.templates({ type: "TREATMENT_PLAN", active: true }),
    [],
  );
  const [templateId, setTemplateId] = useState("");
  const effectiveTemplate = templateId || templates.data?.items[0]?.id || "";
  const template = templates.data?.items.find((t) => t.id === effectiveTemplate);
  const versions = useQuery(
    () => plansApi.consent.versions(effectiveTemplate),
    [effectiveTemplate],
    Boolean(effectiveTemplate),
  );
  const tv = versions.data?.items.find((v) => v.version === template?.currentVersion);
  const current = useCurrentVersionId(plan);
  const docs = useQuery(
    () => api.documents.list(plan.patientId, { category: "CONSENT_FORM" }),
    [plan.patientId],
  );
  const signatureDocs = (docs.data?.items ?? []).filter((d) => d.status === "AVAILABLE");

  const [relationship, setRelationship] = useState<string>("SELF");
  const [signerName, setSignerName] = useState("");
  const [method, setMethod] = useState<"DIGITAL" | "PAPER">("DIGITAL");
  const [documentId, setDocumentId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  const submit = async () => {
    setErrors({});
    if (!tv) return setErrors({ _form: "The consent text is still loading." });
    if (!current.id) return setErrors({ _form: "The plan version is still loading." });
    setBusy(true);
    try {
      let signatureDocumentId = documentId;
      if (!signatureDocumentId && file) {
        if (
          !(DOCUMENT_CONTENT_TYPES as readonly string[]).includes(file.type) ||
          file.size > MAX_DOCUMENT_BYTES
        ) {
          setErrors({
            signatureDocumentId: `PDF or image up to ${formatBytes(MAX_DOCUMENT_BYTES)}`,
          });
          return;
        }
        const doc = await uploadDocument(file, {
          patientId: plan.patientId,
          branchId: plan.branchId,
          category: "CONSENT_FORM",
          description: `Signed consent: ${plan.title} (v${plan.currentVersion})`,
        });
        signatureDocumentId = doc.id;
        setDocumentId(doc.id);
        docs.reload();
      }
      const r = validate(signConsentRequest, {
        templateVersionId: tv.id,
        branchId: plan.branchId,
        planVersionId: current.id,
        method,
        signatureDocumentId,
        signerRelationship: relationship,
        signerName: relationship === "SELF" ? undefined : signerName,
      });
      if (!r.ok) {
        setErrors(
          r.errors.signatureDocumentId
            ? { ...r.errors, signatureDocumentId: "Choose or upload the signed consent form" }
            : r.errors,
        );
        return;
      }
      const signed = await plansApi.consent.sign(plan.patientId, r.data);
      onDone(signed);
    } catch (e) {
      const err = asApiError(e);
      setErrors({ ...err.fieldErrors, _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Capture consent for version ${plan.currentVersion}`}
      description="The patient (or guardian) signs the current consent text for the plan version they were shown."
      footer={
        <Footer
          onClose={onClose}
          label="Record signed consent"
          pending={busy}
          onConfirm={() => void submit()}
        />
      }
    >
      <div className="dos-stack">
        {templates.data && templates.data.items.length === 0 ? (
          <Alert tone="warning">
            No active treatment-plan consent template. Ask an owner to publish one.
          </Alert>
        ) : null}
        <SelectField
          label="Consent template"
          required
          value={effectiveTemplate}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          {(templates.data?.items ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} (v{t.currentVersion})
            </option>
          ))}
        </SelectField>
        {tv ? (
          <div>
            <div className="cw-meta">
              Text version {tv.version} · published {formatDateTime(tv.createdAt)}
            </div>
            <div className="cw-consent-text">{tv.body}</div>
          </div>
        ) : null}
        <div className="dos-form-grid">
          <SelectField
            label="Signed by"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
          >
            {SIGNER_RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r === "SELF" ? "Patient" : humanize(r)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Method"
            value={method}
            onChange={(e) => setMethod(e.target.value as "DIGITAL" | "PAPER")}
          >
            <option value="DIGITAL">Signed on tablet</option>
            <option value="PAPER">Signed on paper (scanned)</option>
          </SelectField>
        </div>
        {relationship !== "SELF" ? (
          <TextField
            label="Signer's full name"
            required
            value={signerName}
            error={errors.signerName}
            onChange={(e) => setSignerName(e.target.value)}
          />
        ) : null}
        <SelectField
          label="Signature document"
          hint="An uploaded Consent form document of this patient."
          value={documentId}
          error={errors.signatureDocumentId}
          onChange={(e) => setDocumentId(e.target.value)}
        >
          <option value="">{file ? "Upload the file chosen below" : "Select a document"}</option>
          {signatureDocs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fileName} · {formatDateTime(d.createdAt)}
            </option>
          ))}
        </SelectField>
        {!documentId ? (
          <div className="dos-field">
            <label className="dos-label" htmlFor="cw-consent-file">
              Or upload the signed form
            </label>
            <input
              id="cw-consent-file"
              type="file"
              className="dos-input"
              style={{ paddingTop: 8 }}
              accept={DOCUMENT_CONTENT_TYPES.join(",")}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        ) : null}
        {errors._form ? <Alert tone="danger">{errors._form}</Alert> : null}
      </div>
    </Dialog>
  );
}

/**
 * Approve the decided plan. With the default tenant knob a GRANTED TREATMENT_PLAN consent on the
 * current version is required; a 409 consent_required offers consent capture instead.
 */
export function ApproveDialog({
  plan,
  preselectConsentId,
  onClose,
  onDone,
  onNeedConsent,
}: {
  plan: PlanDetail;
  preselectConsentId?: string;
  onClose: () => void;
  onDone: Done;
  onNeedConsent: () => void;
}) {
  const mayList = canDo("consent:manage", { branchId: plan.branchId });
  const consents = useQuery(() => plansApi.consents(plan.id), [plan.id], mayList);
  const current = useCurrentVersionId(plan);
  const eligible = (consents.data?.items ?? []).filter(
    (c) => c.status === "GRANTED" && (!current.id || c.planVersionId === current.id),
  );
  const [consentId, setConsentId] = useState(preselectConsentId ?? "");
  const effective = consentId || eligible[0]?.id || "";
  const [note, setNote] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const save = useMutation(
    () =>
      plansApi.approve(plan.id, {
        consentId: effective || undefined,
        note: note.trim() || undefined,
      }),
    { success: "Plan approved", onSuccess: onDone, onError: setError },
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Approve plan version ${plan.currentVersion}`}
      description="Records the patient's approval of the accepted items and their estimates."
      footer={
        <Footer
          onClose={onClose}
          label="Approve plan"
          pending={save.pending}
          onConfirm={() => void save.run()}
        />
      }
    >
      <div className="dos-stack">
        {mayList ? (
          eligible.length ? (
            <SelectField
              label="Signed consent"
              value={effective}
              onChange={(e) => setConsentId(e.target.value)}
            >
              {eligible.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.signerName
                    ? `${c.signerName} (${humanize(c.signerRelationship ?? "")})`
                    : "Patient"}{" "}
                  · {formatDateTime(c.grantedAt)} · captured by {userLabel(c.capturedBy)}
                </option>
              ))}
            </SelectField>
          ) : (
            <Alert tone="warning">
              <div className="dos-stack" data-gap="sm">
                <span>No signed consent for the current version yet.</span>
                <div>
                  <Button size="sm" variant="secondary" onClick={onNeedConsent}>
                    Capture consent
                  </Button>
                </div>
              </div>
            </Alert>
          )
        ) : null}
        <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        {error ? (
          <Alert tone={error.code === "consent_required" ? "warning" : "danger"}>
            <div className="dos-stack" data-gap="sm">
              <span>{error.message}</span>
              {error.code === "consent_required" &&
              canDo("consent:manage", { branchId: plan.branchId }) ? (
                <div>
                  <Button size="sm" variant="secondary" onClick={onNeedConsent}>
                    Capture consent
                  </Button>
                </div>
              ) : null}
            </div>
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
