"use client";
import {
  Alert,
  Button,
  Checkbox,
  CheckboxGroup,
  DescriptionList,
  SelectField,
  TextField,
  useLink,
} from "@dentalos/ui";
import {
  GATEWAY_PROVIDERS,
  PAYMENT_METHODS,
  type PaymentMethod,
  type ResolvedBillingSettings,
  STAFF_ROLES,
  branchBillingSettings,
  tenantBillingSettings,
} from "@dentalos/validation";
import { useState } from "react";
import { BillingSubnav, BranchFilter } from "../../../components/billing/bits";
import { RupeeField } from "../../../components/billing/fields";
import { useBillingBranches } from "../../../components/billing/use-billing";
import { Loadable, MockNotice, RequirePermission, Section } from "../../../components/common";
import { billingApi } from "../../../lib/api/billing";
import { methodLabel } from "../../../lib/api/billing-rules";
import { useMutation, useQuery } from "../../../lib/api/hooks";
import { formatPaise, humanize } from "../../../lib/format";
import { paiseToRupeeInput, rupeesToPaise, validate } from "../../../lib/forms";
import { canDo } from "../../../lib/session";

export function BillingSettingsClient() {
  return (
    <RequirePermission permission="billing:read">
      <Inner />
    </RequirePermission>
  );
}

function Inner() {
  const branches = useBillingBranches();
  const [branchId, setBranchId] = useState("");
  const q = useQuery(() => billingApi.settings.get(branchId || undefined), [branchId]);
  return (
    <div className="dos-stack" data-gap="lg">
      <BillingSubnav />
      <MockNotice />
      <BranchFilter
        branches={branches.scoped}
        value={branchId}
        onChange={setBranchId}
        label="Settings for"
        allLabel="Organisation defaults (all branches)"
      />
      <Loadable state={q} rows={6}>
        {(s) =>
          s.branchId ? (
            <BranchForm
              key={s.branchId}
              branchId={s.branchId}
              stored={s.stored}
              effective={s.effective}
              onSaved={q.reload}
            />
          ) : (
            <TenantForm key="tenant" effective={s.effective} onSaved={q.reload} />
          )
        }
      </Loadable>
    </div>
  );
}

const pctText = (bp: number) => String(bp / 100);
const pctToBp = (t: string): number | null => {
  const v = t.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const bp = Math.round(Number(v) * 100);
  return bp >= 0 && bp <= 10_000 ? bp : null;
};

function MethodsField({
  value,
  onChange,
  error,
  disabled,
}: {
  value: PaymentMethod[];
  onChange: (v: PaymentMethod[]) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <CheckboxGroup
      legend="Accepted payment methods"
      value={value}
      onChange={(v) => onChange(v as PaymentMethod[])}
      options={PAYMENT_METHODS.map((m) => ({ value: m, label: methodLabel(m), disabled }))}
      error={error}
    />
  );
}

function LimitsFields({
  limits,
  setLimits,
  errors,
  blankMeansInherit,
}: {
  limits: Record<string, string>;
  setLimits: (l: Record<string, string>) => void;
  errors: Record<string, string>;
  blankMeansInherit?: boolean;
}) {
  return (
    <fieldset className="dos-fieldset">
      <legend className="dos-label">
        Highest discount each role may give (% of the amount reduced)
      </legend>
      <div className="bil-line-grid">
        {STAFF_ROLES.map((r) => (
          <TextField
            key={r}
            label={humanize(r)}
            inputMode="decimal"
            value={limits[r] ?? ""}
            onChange={(e) => setLimits({ ...limits, [r]: e.target.value })}
            error={errors[`limit.${r}`]}
            hint={blankMeansInherit ? "Blank = inherit" : undefined}
          />
        ))}
      </div>
      <p className="dos-hint">
        A person with several roles gets the highest. Giving any discount also needs the discount
        permission and a reason on every discount.
      </p>
    </fieldset>
  );
}

function SaveBar({
  editable,
  pending,
  note,
}: { editable: boolean; pending: boolean; note: string }) {
  return editable ? (
    <div className="bil-actions">
      <Button type="submit" loading={pending}>
        Save settings
      </Button>
    </div>
  ) : (
    <Alert tone="info">{note}</Alert>
  );
}

/** Tenant scope (org:manage). Only the keys that differ from the current effective values are sent. */
function TenantForm({
  effective: e,
  onSaved,
}: {
  effective: ResolvedBillingSettings;
  onSaved: () => void;
}) {
  const Link = useLink();
  const editable = canDo("org:manage");
  const initLimits = Object.fromEntries(
    STAFF_ROLES.map((r) => [r, pctText(e.discountLimitsBp[r] ?? 0)]),
  );
  const [taxInclusive, setTaxInclusive] = useState(e.taxInclusive);
  const [stateCode, setStateCode] = useState(e.stateCode ?? "");
  const [gst, setGst] = useState(pctText(e.defaultGstRateBp));
  const [due, setDue] = useState(String(e.invoiceDueDays));
  const [limits, setLimits] = useState<Record<string, string>>(initLimits);
  const [threshold, setThreshold] = useState(paiseToRupeeInput(e.refundApprovalThresholdPaise));
  const [separate, setSeparate] = useState(e.separateApprover);
  const [advance, setAdvance] = useState(e.allowAdvancePayments);
  const [methods, setMethods] = useState<PaymentMethod[]>(e.allowedPaymentMethods);
  const [gateway, setGateway] = useState<string>(e.gatewayProvider);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation((b: Record<string, unknown>) => billingApi.settings.update(b), {
    success: "Billing settings saved",
    onSuccess: onSaved,
  });

  const submit = () => {
    const errs: Record<string, string> = {};
    const gstBp = pctToBp(gst);
    if (gstBp === null) errs.gst = "A percentage from 0 to 100";
    const dueDays = Number(due);
    if (!Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) errs.due = "0 to 365 days";
    const thr = rupeesToPaise(threshold);
    if (thr === null) errs.threshold = "Enter an amount in ₹";
    const limitBp: Record<string, number> = {};
    for (const r of STAFF_ROLES) {
      const bp = pctToBp(limits[r] ?? "");
      if (bp === null) errs[`limit.${r}`] = "0 to 100";
      else limitBp[r] = bp;
    }
    if (methods.length === 0) errs.methods = "Accept at least one method";
    if (stateCode.trim() && !/^\d{2}$/.test(stateCode.trim()))
      errs.stateCode = "Two digits, for example 07";
    if (Object.keys(errs).length) return setErrors(errs);

    const next: Record<string, unknown> = {
      taxInclusive,
      ...(stateCode.trim() ? { stateCode: stateCode.trim() } : {}),
      defaultGstRateBp: gstBp,
      invoiceDueDays: dueDays,
      discountLimitsBp: limitBp,
      refundApprovalThresholdPaise: thr,
      separateApprover: separate,
      allowAdvancePayments: advance,
      allowedPaymentMethods: methods,
      gatewayProvider: gateway,
    };
    const current: Record<string, unknown> = {
      taxInclusive: e.taxInclusive,
      stateCode: e.stateCode ?? undefined,
      defaultGstRateBp: e.defaultGstRateBp,
      invoiceDueDays: e.invoiceDueDays,
      discountLimitsBp: Object.fromEntries(STAFF_ROLES.map((r) => [r, e.discountLimitsBp[r] ?? 0])),
      refundApprovalThresholdPaise: e.refundApprovalThresholdPaise,
      separateApprover: e.separateApprover,
      allowAdvancePayments: e.allowAdvancePayments,
      allowedPaymentMethods: e.allowedPaymentMethods,
      gatewayProvider: e.gatewayProvider,
    };
    const changed = Object.fromEntries(
      Object.entries(next).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(current[k])),
    );
    if (Object.keys(changed).length === 0) return setErrors({ form: "Nothing has changed." });
    const v = validate(tenantBillingSettings, changed);
    if (!v.ok) return setErrors({ form: Object.values(v.errors).join(" · ") });
    setErrors({});
    void save.run(v.data);
  };

  return (
    <form
      className="dos-stack"
      data-gap="lg"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <Section
        title="GST and invoicing"
        description="Applies to every branch unless the branch overrides it."
      >
        <div className="dos-stack">
          <Checkbox
            switch
            label="Prices include GST"
            checked={taxInclusive}
            disabled={!editable}
            onChange={(ev) => setTaxInclusive(ev.target.checked)}
            hint="Frozen on each invoice when it is created: changing it only affects new invoices."
          />
          <div className="bil-line-grid">
            <TextField
              label="Supplier GST state code"
              inputMode="numeric"
              maxLength={2}
              disabled={!editable}
              value={stateCode}
              onChange={(ev) => setStateCode(ev.target.value)}
              error={errors.stateCode}
              hint="Used as the place of supply unless the invoice says otherwise. A branch can override it."
            />
            <TextField
              label="Default GST rate (%)"
              inputMode="decimal"
              disabled={!editable}
              value={gst}
              onChange={(ev) => setGst(ev.target.value)}
              error={errors.gst}
              hint="For taxable services with no rate of their own. Dental care is often exempt, so services default to not taxable."
            />
            <TextField
              label="Payment terms (days)"
              inputMode="numeric"
              disabled={!editable}
              value={due}
              onChange={(ev) => setDue(ev.target.value)}
              error={errors.due}
              hint="Days from issue to due date."
            />
          </div>
          <DescriptionList
            columns={2}
            items={[
              {
                term: "Organisation GSTIN",
                detail: (
                  <>
                    {e.gstin ?? "Not set"}{" "}
                    <Link href="/admin/organisation">Change in Organisation settings</Link>
                  </>
                ),
              },
              {
                term: "Invoice numbers",
                detail:
                  "BRANCHCODE/25-26/000123: one gap-free series per branch and financial year (1 Apr – 31 Mar)",
              },
            ]}
          />
        </div>
      </Section>
      <Section title="Discounts">
        <LimitsFields limits={limits} setLimits={setLimits} errors={errors} />
      </Section>
      <Section title="Payments and refunds">
        <div className="dos-stack">
          <MethodsField
            value={methods}
            onChange={setMethods}
            error={errors.methods}
            disabled={!editable}
          />
          <Checkbox
            switch
            label="Keep overpayments as patient advance"
            checked={advance}
            disabled={!editable}
            onChange={(ev) => setAdvance(ev.target.checked)}
            hint="Off: a payment must be applied in full to invoices."
          />
          <SelectField
            label="Online payments"
            value={gateway}
            disabled={!editable}
            onChange={(ev) => setGateway(ev.target.value)}
            hint="Manual = staff record payments only. Stub is a fake gateway for testing."
          >
            {GATEWAY_PROVIDERS.map((g) => (
              <option key={g} value={g}>
                {g === "MANUAL" ? "Manual only (no gateway)" : "Stub gateway (testing)"}
              </option>
            ))}
          </SelectField>
          <div className="bil-line-grid">
            <RupeeField
              label="Refunds above this need approval"
              value={threshold}
              onChange={setThreshold}
              error={errors.threshold}
              disabled={!editable}
              hint={`Currently ${formatPaise(e.refundApprovalThresholdPaise)}`}
            />
          </div>
          <Checkbox
            switch
            label="Approver must differ from the requester"
            checked={separate}
            disabled={!editable}
            onChange={(ev) => setSeparate(ev.target.checked)}
          />
        </div>
      </Section>
      {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
      <SaveBar
        editable={editable}
        pending={save.pending}
        note="Only an organisation owner can change these settings."
      />
    </form>
  );
}

/** Branch scope (branch:manage). Blank = inherit the organisation value; an override can be changed, not removed. */
function BranchForm({
  branchId,
  stored,
  effective: e,
  onSaved,
}: {
  branchId: string;
  stored: Record<string, unknown>;
  effective: ResolvedBillingSettings;
  onSaved: () => void;
}) {
  const editable = canDo("branch:manage", { branchId });
  const s = stored as {
    gstin?: string;
    stateCode?: string;
    taxInclusive?: boolean;
    invoiceDueDays?: number;
    discountLimitsBp?: Record<string, number>;
    refundApprovalThresholdPaise?: number;
    allowedPaymentMethods?: PaymentMethod[];
  };
  const [gstin, setGstin] = useState(s.gstin ?? "");
  const [stateCode, setStateCode] = useState(s.stateCode ?? "");
  const [tax, setTax] = useState(s.taxInclusive === undefined ? "" : String(s.taxInclusive));
  const [due, setDue] = useState(s.invoiceDueDays === undefined ? "" : String(s.invoiceDueDays));
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(
      STAFF_ROLES.map((r) => [
        r,
        s.discountLimitsBp?.[r] === undefined ? "" : pctText(s.discountLimitsBp[r] as number),
      ]),
    ),
  );
  const [threshold, setThreshold] = useState(
    s.refundApprovalThresholdPaise === undefined
      ? ""
      : paiseToRupeeInput(s.refundApprovalThresholdPaise),
  );
  const [overrideMethods, setOverrideMethods] = useState(s.allowedPaymentMethods !== undefined);
  const [methods, setMethods] = useState<PaymentMethod[]>(
    s.allowedPaymentMethods ?? e.allowedPaymentMethods,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation(
    (b: Record<string, unknown>) => billingApi.settings.update(b, branchId),
    { success: "Branch billing settings saved", onSuccess: onSaved },
  );

  const submit = () => {
    const errs: Record<string, string> = {};
    const next: Record<string, unknown> = {};
    if (gstin.trim()) next.gstin = gstin.trim().toUpperCase();
    if (stateCode.trim()) next.stateCode = stateCode.trim();
    if (tax) next.taxInclusive = tax === "true";
    if (due.trim()) {
      const n = Number(due);
      if (!Number.isInteger(n) || n < 0 || n > 365) errs.due = "0 to 365 days";
      else next.invoiceDueDays = n;
    }
    const lim: Record<string, number> = {};
    for (const r of STAFF_ROLES) {
      const t = limits[r] ?? "";
      if (!t.trim()) continue;
      const bp = pctToBp(t);
      if (bp === null) errs[`limit.${r}`] = "0 to 100";
      else lim[r] = bp;
    }
    if (Object.keys(lim).length) next.discountLimitsBp = lim;
    if (threshold.trim()) {
      const p = rupeesToPaise(threshold);
      if (p === null) errs.threshold = "Enter an amount in ₹";
      else next.refundApprovalThresholdPaise = p;
    }
    if (overrideMethods) {
      if (methods.length === 0) errs.methods = "Accept at least one method";
      else next.allowedPaymentMethods = methods;
    }
    if (Object.keys(errs).length) return setErrors(errs);
    const changed = Object.fromEntries(
      Object.entries(next).filter(
        ([k, v]) => JSON.stringify(v) !== JSON.stringify((stored as Record<string, unknown>)[k]),
      ),
    );
    if (Object.keys(changed).length === 0) return setErrors({ form: "Nothing has changed." });
    const v = validate(branchBillingSettings, changed);
    if (!v.ok)
      return setErrors({
        ...(v.errors.gstin ? { gstin: "A 15-character GSTIN, for example 07AAAAA0000A1Z5" } : {}),
        ...(v.errors.stateCode ? { stateCode: "Two digits" } : {}),
        form: Object.values(v.errors).join(" · "),
      });
    setErrors({});
    void save.run(v.data);
  };

  return (
    <form
      className="dos-stack"
      data-gap="lg"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <Alert tone="info">
        Leave a field blank to use the organisation setting. Effective here: GSTIN{" "}
        {e.gstin ?? "none"} · state {e.stateCode ?? "unset"} · prices{" "}
        {e.taxInclusive ? "include" : "exclude"} GST · terms {e.invoiceDueDays} days · refund
        approval above {formatPaise(e.refundApprovalThresholdPaise)}. A value set for a branch can
        be changed but not cleared here.
      </Alert>
      <Section title="GST and invoicing">
        <div className="bil-line-grid">
          <TextField
            label="Branch GSTIN"
            maxLength={15}
            disabled={!editable}
            value={gstin}
            onChange={(ev) => setGstin(ev.target.value)}
            error={errors.gstin}
            hint="Overrides the organisation GSTIN on this branch's invoices."
          />
          <TextField
            label="GST state code"
            inputMode="numeric"
            maxLength={2}
            disabled={!editable}
            value={stateCode}
            onChange={(ev) => setStateCode(ev.target.value)}
            error={errors.stateCode}
          />
          <SelectField
            label="Prices include GST"
            value={tax}
            disabled={!editable}
            onChange={(ev) => setTax(ev.target.value)}
          >
            <option value="">Inherit ({e.taxInclusive ? "yes" : "no"})</option>
            <option value="true">Yes, include GST</option>
            <option value="false">No, add GST on top</option>
          </SelectField>
          <TextField
            label="Payment terms (days)"
            inputMode="numeric"
            disabled={!editable}
            value={due}
            onChange={(ev) => setDue(ev.target.value)}
            error={errors.due}
          />
        </div>
      </Section>
      <Section title="Discounts and refunds">
        <div className="dos-stack">
          <LimitsFields limits={limits} setLimits={setLimits} errors={errors} blankMeansInherit />
          <div className="bil-line-grid">
            <RupeeField
              label="Refund approval threshold"
              value={threshold}
              onChange={setThreshold}
              error={errors.threshold}
              disabled={!editable}
              hint="Blank = inherit"
            />
          </div>
        </div>
      </Section>
      <Section title="Payment methods">
        <div className="dos-stack">
          <Checkbox
            label="Use a different list of methods at this branch"
            checked={overrideMethods}
            disabled={!editable}
            onChange={(ev) => setOverrideMethods(ev.target.checked)}
          />
          {overrideMethods ? (
            <MethodsField
              value={methods}
              onChange={setMethods}
              error={errors.methods}
              disabled={!editable}
            />
          ) : null}
        </div>
      </Section>
      {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
      <SaveBar
        editable={editable}
        pending={save.pending}
        note="You need branch management rights to change this branch's billing settings."
      />
    </form>
  );
}
