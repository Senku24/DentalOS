"use client";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  SelectField,
  Spinner,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type CreateInvoiceFromPlanRequest,
  type CreateInvoiceRequest,
  type PatientSummary,
  createInvoiceFromPlanRequest,
  createInvoiceRequest,
} from "@dentalos/validation";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { BillingSubnav, Money, Segmented, TotalsList } from "../../../components/billing/bits";
import {
  type DiscountDraft,
  DiscountFields,
  NO_DISCOUNT,
  parseDiscount,
} from "../../../components/billing/fields";
import {
  LineCard,
  type LineDraft,
  ServicePicker,
  adHocLine,
  hasIssues,
  lineIssues,
  lineToInput,
  lineToPreview,
  serviceLine,
} from "../../../components/billing/line-editor";
import { useBillingBranches, useBillingSettings } from "../../../components/billing/use-billing";
import { MockNotice, RequirePermission } from "../../../components/common";
import { PatientPicker } from "../../../components/scheduling/patient-picker";
import { billingApi } from "../../../lib/api/billing";
import { discountProblem, previewInvoice } from "../../../lib/api/billing-rules";
import { api } from "../../../lib/api/endpoints";
import { type ApiError, errorStateFor } from "../../../lib/api/errors";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { plansApi } from "../../../lib/api/plans";
import { formatPaise, humanize, todayISO } from "../../../lib/format";
import { validate } from "../../../lib/forms";
import { canDo, sessionPrincipal } from "../../../lib/session";

const BILLABLE = new Set(["ACCEPTED", "SCHEDULED", "IN_PROGRESS", "COMPLETED"]);

export function NewInvoiceClient() {
  return (
    <RequirePermission permission="invoice:write">
      <div className="dos-stack" data-gap="lg">
        <BillingSubnav />
        <MockNotice />
        <Inner />
      </div>
    </RequirePermission>
  );
}

function Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const branches = useBillingBranches();
  const [mode, setMode] = useState<"catalogue" | "plan">(
    params.get("planId") ? "plan" : "catalogue",
  );
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [branchId, setBranchId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [notes, setNotes] = useState("");
  const [serverError, setServerError] = useState<ApiError | null>(null);

  const preId = params.get("patientId");
  useEffect(() => {
    if (!preId) return;
    let live = true;
    api.patients.get(preId).then(
      (p) => live && setPatient(p),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [preId]);

  // Default branch: the patient's origin branch when in scope, else the first branch in scope.
  const scopedIds = branches.scoped.map((b) => b.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopedIds is the stable key of branches.scoped
  useEffect(() => {
    if (branchId || branches.scoped.length === 0) return;
    const origin = patient && branches.scoped.find((b) => b.id === patient.originBranchId);
    setBranchId((origin ?? branches.scoped[0])?.id ?? "");
  }, [scopedIds, patient, branchId]);

  const { effective: settings } = useBillingSettings(branchId);
  const base = {
    dueDate: dueDate || undefined,
    placeOfSupplyStateCode: placeOfSupply.trim() || undefined,
    notes: notes.trim() || undefined,
  };

  const header = (
    <Card>
      <div className="dos-stack">
        <PatientPicker value={patient} onChange={setPatient} />
        <fieldset className="dos-fieldset">
          <legend className="dos-label">Bill from</legend>
          <Segmented
            label="Where the lines come from"
            value={mode}
            onChange={setMode}
            options={[
              { value: "catalogue", label: "Service catalogue" },
              { value: "plan", label: "Treatment plan" },
            ]}
          />
        </fieldset>
      </div>
    </Card>
  );

  const common = (
    <Card>
      <div className="bil-line-grid">
        {mode === "catalogue" ? (
          <SelectField
            label="Branch"
            required
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            hint="Sets the prices, tax mode and invoice number series."
          >
            <option value="">Select a branch</option>
            {branches.scoped.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        <TextField
          label="Due date"
          type="date"
          min={todayISO()}
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          hint={
            settings
              ? `Blank = ${settings.invoiceDueDays} day${settings.invoiceDueDays === 1 ? "" : "s"} after issue`
              : undefined
          }
        />
        <TextField
          label="Place of supply (GST state code)"
          inputMode="numeric"
          maxLength={2}
          value={placeOfSupply}
          onChange={(e) => setPlaceOfSupply(e.target.value)}
          hint={
            settings?.stateCode
              ? `Blank = ${settings.stateCode} (the branch's state): CGST + SGST. A different code charges IGST.`
              : "Two digits, for example 29."
          }
        />
      </div>
      <TextareaField
        label="Notes"
        rows={2}
        maxLength={1000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        hint="Shown on the invoice."
      />
    </Card>
  );

  const fail = (e: ApiError | null) => setServerError(e);

  return (
    <div className="dos-stack" data-gap="lg">
      {header}
      {!patient ? (
        <EmptyState
          title="Choose a patient"
          description="Search for the patient this invoice is for."
        />
      ) : mode === "catalogue" ? (
        <CatalogueForm
          patient={patient}
          branchId={branchId}
          common={common}
          base={base}
          settings={settings}
          serverError={serverError}
          onError={fail}
          onCreated={(id) => router.push(`/invoices/${id}`)}
        />
      ) : (
        <PlanForm
          patient={patient}
          common={common}
          base={base}
          initialPlanId={params.get("planId") ?? ""}
          serverError={serverError}
          onError={fail}
          onCreated={(id) => router.push(`/invoices/${id}`)}
        />
      )}
    </div>
  );
}

type Settings = ReturnType<typeof useBillingSettings>["effective"];

function CatalogueForm({
  patient,
  branchId,
  common,
  base,
  settings,
  serverError,
  onError,
  onCreated,
}: {
  patient: PatientSummary;
  branchId: string;
  common: React.ReactNode;
  base: { dueDate?: string; placeOfSupplyStateCode?: string; notes?: string };
  settings: Settings;
  serverError: ApiError | null;
  onError: (e: ApiError | null) => void;
  onCreated: (id: string) => void;
}) {
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [disc, setDisc] = useState<DiscountDraft>(NO_DISCOUNT);
  const [showErrors, setShowErrors] = useState(false);

  // A different branch means different effective prices: drop catalogue lines priced for the old one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the branch change matters
  useEffect(() => {
    setLines((ls) => ls.filter((l) => !l.serviceId));
  }, [branchId]);

  const ctx = { branchId, settings };
  const issues = lines.map((l) => lineIssues(l, ctx));
  const previewLines = lines.map((l) => lineToPreview(l, settings?.defaultGstRateBp ?? 1800));
  const complete = previewLines.every((l) => l !== null) && lines.length > 0;
  const invSpec = parseDiscount(disc);

  const preview =
    complete && settings
      ? previewInvoice({
          lines: previewLines.filter((l) => l !== null),
          taxInclusive: settings.taxInclusive,
          supplierStateCode: settings.stateCode,
          placeOfSupplyStateCode: base.placeOfSupplyStateCode ?? settings.stateCode,
          invoiceDiscount: typeof invSpec === "string" ? null : invSpec,
        })
      : null;

  const afterLineDiscounts = lines.reduce((s, _l, i) => {
    const p = previewLines[i];
    return p ? s + p.quantity * p.unitPricePaise - p.discountPaise : s;
  }, 0);
  const invDiscIssue =
    typeof invSpec === "string"
      ? invSpec
      : invSpec
        ? discountProblem({
            discount: invSpec,
            basePaise: afterLineDiscounts,
            reason: disc.reason,
            canApply: canDo("discount:apply", { branchId }),
            roles: sessionPrincipal().roles,
            settings,
          })
        : null;

  const create = useMutation((b: CreateInvoiceRequest) => billingApi.invoices.create(b), {
    success: "Draft invoice saved",
    onSuccess: (r) => onCreated(r.id),
    onError: (e) => onError(e),
  });

  const submit = () => {
    setShowErrors(true);
    onError(null);
    if (!branchId || lines.length === 0 || issues.some(hasIssues) || invDiscIssue) return;
    const body = {
      patientId: patient.id,
      branchId,
      ...base,
      lines: lines.map(lineToInput),
      ...(invSpec && typeof invSpec !== "string"
        ? { invoiceDiscount: invSpec, discountReason: disc.reason.trim() }
        : {}),
    };
    const v = validate(createInvoiceRequest, body);
    if (!v.ok) {
      onError(null);
      setFormError(Object.values(v.errors).join(" · "));
      return;
    }
    setFormError(null);
    void create.run(v.data);
  };
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <div className="dos-stack" data-gap="lg">
      {common}
      <Card>
        <div className="dos-stack">
          <h2 className="dos-section-title">Lines</h2>
          <ServicePicker
            branchId={branchId}
            onPick={(s) => setLines((ls) => [...ls, serviceLine(s)])}
            onAddCustom={() => setLines((ls) => [...ls, adHocLine()])}
          />
          {lines.length === 0 ? (
            <EmptyState
              title="No lines yet"
              description="Add services from the catalogue, or a custom item with its own price."
            />
          ) : (
            lines.map((l, i) => (
              <LineCard
                key={l.key}
                line={l}
                index={i}
                issues={showErrors ? (issues[i] ?? {}) : {}}
                onChange={(nl) => setLines((ls) => ls.map((x) => (x.key === l.key ? nl : x)))}
                onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              />
            ))
          )}
        </div>
      </Card>
      {lines.length > 0 ? (
        <Card>
          <div className="dos-stack">
            <DiscountFields
              draft={disc}
              onChange={setDisc}
              error={showErrors ? (invDiscIssue ?? undefined) : undefined}
              reasonError={undefined}
              disabled={!canDo("discount:apply", { branchId })}
            />
            <h2 className="dos-section-title">Summary (preview)</h2>
            {preview?.ok ? (
              <>
                <TotalsList
                  rows={[
                    { label: "Subtotal", paise: preview.totals.subtotalPaise },
                    {
                      label: "Discounts",
                      paise: -preview.totals.discountPaise,
                      hide: preview.totals.discountPaise === 0,
                    },
                    {
                      label: "CGST",
                      paise: preview.totals.cgstPaise,
                      hide: preview.interState || preview.totals.taxPaise === 0,
                    },
                    {
                      label: "SGST",
                      paise: preview.totals.sgstPaise,
                      hide: preview.interState || preview.totals.taxPaise === 0,
                    },
                    {
                      label: "IGST",
                      paise: preview.totals.igstPaise,
                      hide: !preview.interState || preview.totals.taxPaise === 0,
                    },
                    {
                      label: settings?.taxInclusive ? "Total (GST included)" : "Total",
                      paise: preview.totals.totalPaise,
                      strong: true,
                    },
                  ]}
                />
                <p className="dos-hint">
                  Preview using each service's catalogue tax flag and the default GST rate (
                  {((settings?.defaultGstRateBp ?? 0) / 100).toFixed(0)}%) for taxable services;
                  custom items carry no GST. The saved invoice uses each service's configured rate.
                </p>
              </>
            ) : preview ? (
              <Alert tone="warning">{preview.message}</Alert>
            ) : (
              <p className="dos-muted">Complete the lines to see the totals.</p>
            )}
          </div>
        </Card>
      ) : null}
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}
      <div className="bil-actions">
        <Button
          onClick={submit}
          loading={create.pending}
          disabled={lines.length === 0 || !branchId}
        >
          Save draft
        </Button>
        <span className="dos-hint">The invoice number is assigned when you issue it.</span>
      </div>
    </div>
  );
}

function PlanForm({
  patient,
  common,
  base,
  initialPlanId,
  serverError,
  onError,
  onCreated,
}: {
  patient: PatientSummary;
  common: React.ReactNode;
  base: { dueDate?: string; placeOfSupplyStateCode?: string; notes?: string };
  initialPlanId: string;
  serverError: ApiError | null;
  onError: (e: ApiError | null) => void;
  onCreated: (id: string) => void;
}) {
  const plans = useQuery(() => plansApi.list({ patientId: patient.id, limit: 50 }), [patient.id]);
  const [planId, setPlanId] = useState(initialPlanId);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const open = (plans.data?.items ?? []).filter(
    (p) => p.status !== "CANCELLED" && p.status !== "DRAFT",
  );
  const est = useQuery(() => billingApi.estimate(planId), [planId], Boolean(planId));

  // Default selection: everything that can be billed now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when a different estimate loads
  useEffect(() => {
    if (!est.data) return;
    setPicked(
      Object.fromEntries(
        est.data.lines
          .filter((l) => BILLABLE.has(l.status) && !l.billed)
          .map((l) => [l.planItemId, true]),
      ),
    );
  }, [est.data?.planId, est.data?.planVersion]);

  const chosen = (est.data?.lines ?? []).filter((l) => picked[l.planItemId]);
  const sum = (f: (l: (typeof chosen)[number]) => number) => chosen.reduce((s, l) => s + f(l), 0);

  const create = useMutation((b: CreateInvoiceFromPlanRequest) => billingApi.invoices.fromPlan(b), {
    success: "Draft invoice saved from the plan",
    onSuccess: (r) => onCreated(r.id),
    onError: (e) => onError(e),
  });
  const [formError, setFormError] = useState<string | null>(null);
  const submit = () => {
    onError(null);
    if (chosen.length === 0) {
      setFormError("Tick at least one plan item to bill.");
      return;
    }
    const v = validate(createInvoiceFromPlanRequest, {
      planId,
      planItemIds: chosen.map((l) => l.planItemId),
      ...base,
    });
    if (!v.ok) {
      setFormError(Object.values(v.errors).join(" · "));
      return;
    }
    setFormError(null);
    void create.run(v.data);
  };

  return (
    <div className="dos-stack" data-gap="lg">
      <Card>
        <div className="dos-stack">
          <h2 className="dos-section-title">Treatment plan</h2>
          {plans.error ? (
            <Alert tone="danger">{errorStateFor(plans.error).description}</Alert>
          ) : plans.data === undefined ? (
            <Spinner label="Loading plans" />
          ) : open.length === 0 ? (
            <EmptyState
              title="No billable plans"
              description="Plans must be presented and have accepted items before they can be billed."
            />
          ) : (
            <SelectField label="Plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">Select a plan</option>
              {open.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} · v{p.currentVersion} · {humanize(p.status)}
                </option>
              ))}
            </SelectField>
          )}
          {planId && est.error ? (
            <Alert tone="danger">{errorStateFor(est.error).description}</Alert>
          ) : null}
          {planId && est.loading && !est.data ? <Spinner label="Loading plan items" /> : null}
          {est.data ? (
            <div className="dos-table-scroll">
              <table className="dos-table">
                <caption className="dos-sr-only">Plan items to bill</caption>
                <thead>
                  <tr>
                    <th scope="col">Bill</th>
                    <th scope="col">Item</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="bil-money">
                      Price
                    </th>
                    <th scope="col" className="bil-money">
                      GST
                    </th>
                    <th scope="col" className="bil-money">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {est.data.lines.map((l) => {
                    const can = BILLABLE.has(l.status) && !l.billed;
                    return (
                      <tr key={l.planItemId}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Bill ${l.description}`}
                            disabled={!can}
                            checked={Boolean(picked[l.planItemId])}
                            onChange={(e) =>
                              setPicked((p) => ({ ...p, [l.planItemId]: e.target.checked }))
                            }
                          />
                        </td>
                        <td>
                          {l.description}
                          {l.toothCode ? ` · tooth ${l.toothCode}` : ""}
                          {l.quantity > 1 ? ` × ${l.quantity}` : ""}
                        </td>
                        <td>
                          {l.billed ? (
                            <Badge tone="neutral">Already billed</Badge>
                          ) : (
                            <Badge tone={can ? "success" : "neutral"}>{humanize(l.status)}</Badge>
                          )}
                        </td>
                        <td>
                          <Money paise={l.grossPaise} />
                        </td>
                        <td>
                          <Money paise={l.taxPaise} />
                        </td>
                        <td>
                          <Money paise={l.totalPaise} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {est.data ? (
            <>
              <TotalsList
                rows={[
                  { label: `Selected (${chosen.length})`, paise: sum((l) => l.grossPaise) },
                  {
                    label: "GST",
                    paise: sum((l) => l.taxPaise),
                    hide: sum((l) => l.taxPaise) === 0,
                  },
                  {
                    label: est.data.taxInclusive ? "Total (GST included)" : "Total",
                    paise: sum((l) => l.totalPaise),
                    strong: true,
                  },
                ]}
              />
              <p className="dos-hint">
                Billed at the plan's frozen prices (plan v{est.data.planVersion}); a later catalogue
                price change doesn't affect them. Add a discount on the draft afterwards if you need
                one.
              </p>
            </>
          ) : null}
        </div>
      </Card>
      {planId ? common : null}
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}
      {planId ? (
        <div className="bil-actions">
          <Button onClick={submit} loading={create.pending} disabled={chosen.length === 0}>
            Save draft from plan ({formatPaise(sum((l) => l.totalPaise))})
          </Button>
        </div>
      ) : null}
    </div>
  );
}
