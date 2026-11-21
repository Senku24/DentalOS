"use client";
import {
  Alert,
  Badge,
  Button,
  Drawer,
  EmptyState,
  SelectField,
  Spinner,
  TextField,
  TextareaField,
  useLink,
} from "@dentalos/ui";
import {
  type GatewayCheckoutResponse,
  type InvoiceSummary,
  type PatientSummary,
  type PaymentDetailResponse,
  type PaymentMethod,
  createGatewayCheckoutRequest,
  recordPaymentRequest,
} from "@dentalos/validation";
import { useEffect, useState } from "react";
import { billingApi } from "../../lib/api/billing";
import { methodLabel } from "../../lib/api/billing-rules";
import { errorStateFor } from "../../lib/api/errors";
import { type ApiError } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { formatDate, formatDateTime, formatPaise, patientName } from "../../lib/format";
import { paiseToRupeeInput, rupeesToPaise, validate } from "../../lib/forms";
import { PatientPicker } from "../scheduling/patient-picker";
import { PaymentStatusBadge } from "./bits";
import { RupeeField } from "./fields";
import { useBillingBranches, useBillingSettings, useKeyer } from "./use-billing";

/** Invoices of a patient at a branch that still have a balance, oldest first. */
export function useOutstandingInvoices(
  patientId: string | undefined,
  branchId: string | undefined,
) {
  return useQuery(
    async () => {
      const pages = await Promise.all(
        (["ISSUED", "PARTIALLY_PAID"] as const).map((status) =>
          billingApi.invoices.list({ patientId, branchId, status, limit: 100 }),
        ),
      );
      return pages
        .flatMap((p) => p.items)
        .filter((i) => i.balancePaise > 0)
        .sort((a, b) => (a.issuedAt ?? "").localeCompare(b.issuedAt ?? ""));
    },
    [patientId, branchId],
    Boolean(patientId && branchId),
  );
}

/** Checkbox + amount per outstanding invoice. `picks` maps invoiceId → rupee text (absent = not picked). */
export function AllocationList({
  invoices,
  picks,
  setPicks,
  withAmounts = true,
  errors = {},
}: {
  invoices: InvoiceSummary[];
  picks: Record<string, string>;
  setPicks: (p: Record<string, string>) => void;
  withAmounts?: boolean;
  errors?: Record<string, string>;
}) {
  const Link = useLink();
  if (invoices.length === 0)
    return <p className="dos-muted">No invoices with a balance for this patient at this branch.</p>;
  return (
    <fieldset className="dos-fieldset" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="dos-sr-only">Invoices to pay</legend>
      {invoices.map((i) => {
        const checked = i.id in picks;
        return (
          <div key={i.id} className="bil-alloc-row">
            <input
              type="checkbox"
              aria-label={`Pay invoice ${i.number ?? i.id}`}
              checked={checked}
              onChange={(e) => {
                const next = { ...picks };
                if (e.target.checked) next[i.id] = paiseToRupeeInput(i.balancePaise);
                else delete next[i.id];
                setPicks(next);
              }}
            />
            <div>
              <Link href={`/invoices/${i.id}`}>{i.number ?? "Draft"}</Link>
              <div className="dos-hint">
                {formatDate(i.issuedAt)} · balance {formatPaise(i.balancePaise)}
                {i.dueDate ? ` · due ${formatDate(i.dueDate)}` : ""}
              </div>
            </div>
            {withAmounts && checked ? (
              <TextField
                label="Amount"
                inputMode="decimal"
                value={picks[i.id] ?? ""}
                onChange={(e) => setPicks({ ...picks, [i.id]: e.target.value })}
                error={errors[i.id]}
              />
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Rupee text per pick → [{ invoiceId, amountPaise }] plus per-invoice problems against the balances. */
export function parsePicks(picks: Record<string, string>, invoices: InvoiceSummary[]) {
  const out: { invoiceId: string; amountPaise: number }[] = [];
  const errors: Record<string, string> = {};
  for (const [invoiceId, text] of Object.entries(picks)) {
    const paise = rupeesToPaise(text);
    const inv = invoices.find((i) => i.id === invoiceId);
    if (paise === null || paise < 1) errors[invoiceId] = "Enter an amount";
    else if (inv && paise > inv.balancePaise)
      errors[invoiceId] = `At most ${formatPaise(inv.balancePaise)}`;
    else out.push({ invoiceId, amountPaise: paise });
  }
  return { allocations: out, errors };
}

interface Preset {
  patient?: PatientSummary | null;
  branchId?: string;
  invoiceId?: string;
}

/**
 * Record a payment (any method) or start an online one. Allocation: pay this invoice, several invoices, oldest
 * first, or keep it as the patient's advance. Money moves only on the API: an online payment stays "awaiting
 * gateway" until the gateway webhook confirms it, never on anything the browser reports.
 */
export function PaymentDrawer({
  open,
  onOpenChange,
  onRecorded,
  ...preset
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRecorded?: (p: PaymentDetailResponse) => void;
} & Preset) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Record payment"
      description="Money received from a patient. A receipt number is assigned automatically."
    >
      {open ? (
        <PaymentForm {...preset} onClose={() => onOpenChange(false)} onRecorded={onRecorded} />
      ) : null}
    </Drawer>
  );
}

function PaymentForm({
  patient: presetPatient,
  branchId: presetBranch,
  invoiceId,
  onClose,
  onRecorded,
}: Preset & { onClose: () => void; onRecorded?: (p: PaymentDetailResponse) => void }) {
  const Link = useLink();
  const branches = useBillingBranches();
  const [patient, setPatient] = useState<PatientSummary | null>(presetPatient ?? null);
  const [branchId, setBranchId] = useState(presetBranch ?? "");
  const [tab, setTab] = useState<"record" | "online">("record");
  const keyer = useKeyer("pay");
  const checkoutKeyer = useKeyer("chk");

  const scopedIds = branches.scoped.map((b) => b.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopedIds is the stable key of branches.scoped
  useEffect(() => {
    if (branchId || branches.scoped.length === 0) return;
    const origin = patient && branches.scoped.find((b) => b.id === patient.originBranchId);
    setBranchId((origin ?? branches.scoped[0])?.id ?? "");
  }, [scopedIds, patient, branchId]);

  const { effective: settings } = useBillingSettings(branchId);
  const outstanding = useOutstandingInvoices(patient?.id, branchId);
  const invoices = outstanding.data ?? [];

  const methods: PaymentMethod[] = settings?.allowedPaymentMethods ?? ["CASH", "UPI", "CARD"];
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  useEffect(() => {
    if (!methods.includes(method)) setMethod(methods[0] ?? "CASH");
  }, [methods, method]);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"auto" | "choose" | "advance">("auto");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<ApiError | null>(null);
  const [checkout, setCheckout] = useState<GatewayCheckoutResponse | null>(null);

  // Opened from an invoice: pre-select it and its balance.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !invoiceId || !outstanding.data) return;
    const inv = outstanding.data.find((i) => i.id === invoiceId);
    if (inv) {
      setMode("choose");
      setPicks({ [inv.id]: paiseToRupeeInput(inv.balancePaise) });
      setAmount(paiseToRupeeInput(inv.balancePaise));
    }
    setSeeded(true);
  }, [outstanding.data, invoiceId, seeded]);

  const { allocations, errors: pickErrors } = parsePicks(picks, invoices);
  const amountPaise = rupeesToPaise(amount);
  const allocatedPaise = allocations.reduce((s, a) => s + a.amountPaise, 0);
  let advancePaise = 0;
  if (amountPaise !== null) {
    if (mode === "advance") advancePaise = amountPaise;
    else if (mode === "choose") advancePaise = Math.max(0, amountPaise - allocatedPaise);
    else {
      let left = amountPaise;
      for (const i of invoices) left -= Math.min(left, i.balancePaise);
      advancePaise = left;
    }
  }

  const record = useMutation(
    (b: ReturnType<typeof buildBody> & { idempotencyKey: string }) =>
      billingApi.payments.create(b as never),
    {
      success: (r) => `Payment recorded${r.receiptNumber ? ` · receipt ${r.receiptNumber}` : ""}`,
      onSuccess: (r) => {
        keyer.reset();
        onRecorded?.(r);
        onClose();
      },
      onError: setServerError,
    },
  );
  const startCheckout = useMutation(billingApi.payments.checkout, {
    success: "Online payment started",
    onSuccess: (r) => {
      checkoutKeyer.reset();
      setCheckout(r);
    },
    onError: setServerError,
  });

  function buildBody() {
    return {
      patientId: patient?.id ?? "",
      branchId,
      method,
      amountPaise: amountPaise ?? 0,
      reference: reference.trim() || undefined,
      receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
      notes: notes.trim() || undefined,
      ...(mode === "choose" ? { allocations } : {}),
      ...(mode === "auto" ? { autoAllocate: true } : {}),
    };
  }

  const submit = () => {
    setServerError(null);
    const errs: Record<string, string> = {};
    if (!patient) errs.patient = "Choose a patient";
    if (!branchId) errs.branch = "Choose a branch";
    if (amountPaise === null || amountPaise < 1) errs.amount = "Enter the amount received";
    if (mode === "choose") {
      if (allocations.length === 0 && Object.keys(pickErrors).length === 0)
        errs.allocations = "Tick an invoice, or choose another way to apply this payment";
      if (Object.keys(pickErrors).length) errs.allocations = "Fix the invoice amounts";
      if (amountPaise !== null && allocatedPaise > amountPaise)
        errs.allocations = "You allocated more than the amount received";
    }
    if (advancePaise > 0 && settings && !settings.allowAdvancePayments)
      errs.amount =
        "This clinic doesn't keep patient advances: apply the whole payment to invoices";
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    const body = buildBody();
    const fingerprint = JSON.stringify(body);
    const v = validate(recordPaymentRequest, {
      ...body,
      idempotencyKey: keyer.keyFor(fingerprint),
    });
    if (!v.ok) {
      setErrors({
        amount: v.errors.amountPaise ?? "",
        reference: v.errors.reference ?? "",
        receivedAt: v.errors.receivedAt ?? "",
        ...(v.errors._form ? { form: v.errors._form } : {}),
      });
      return;
    }
    setErrors({});
    void record.run(v.data as never);
  };

  const [onlinePicks, setOnlinePicks] = useState<Record<string, string>>({});
  const [onlineAmount, setOnlineAmount] = useState("");
  const onlineAmountPaise = rupeesToPaise(onlineAmount);
  const submitOnline = () => {
    setServerError(null);
    if (!patient || !branchId || onlineAmountPaise === null || onlineAmountPaise < 1) {
      setErrors({ online: "Choose a patient and enter the amount" });
      return;
    }
    const body = {
      patientId: patient.id,
      branchId,
      amountPaise: onlineAmountPaise,
      invoiceIds: Object.keys(onlinePicks),
    };
    const v = validate(createGatewayCheckoutRequest, {
      ...body,
      idempotencyKey: checkoutKeyer.keyFor(JSON.stringify(body)),
    });
    if (!v.ok) {
      setErrors({ online: Object.values(v.errors).join(" · ") });
      return;
    }
    setErrors({});
    void startCheckout.run(v.data);
  };

  const gatewayOn = Boolean(settings && settings.gatewayProvider !== "MANUAL");

  return (
    <div className="dos-stack" data-gap="lg">
      {presetPatient ? (
        <p>
          <strong>{patientName(presetPatient)}</strong>
          {presetPatient.mrn ? ` · ${presetPatient.mrn}` : ""}
        </p>
      ) : (
        <PatientPicker
          value={patient}
          onChange={(p) => {
            setPatient(p);
            setPicks({});
          }}
          error={errors.patient}
        />
      )}
      <SelectField
        label="Branch"
        required
        value={branchId}
        disabled={Boolean(presetBranch)}
        onChange={(e) => {
          setBranchId(e.target.value);
          setPicks({});
        }}
        error={errors.branch}
        hint="A payment belongs to the branch where the money was received."
      >
        <option value="">Select a branch</option>
        {branches.scoped.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </SelectField>

      {gatewayOn ? (
        <fieldset className="bil-seg" aria-label="Payment type">
          <button type="button" aria-pressed={tab === "record"} onClick={() => setTab("record")}>
            Received at the desk
          </button>
          <button type="button" aria-pressed={tab === "online"} onClick={() => setTab("online")}>
            Pay online
          </button>
        </fieldset>
      ) : null}

      {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}

      {tab === "record" ? (
        <div className="dos-stack">
          <div className="bil-line-grid">
            <SelectField
              label="Method"
              required
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            >
              {methods.map((m) => (
                <option key={m} value={m}>
                  {methodLabel(m)}
                </option>
              ))}
            </SelectField>
            <RupeeField
              label="Amount received"
              required
              value={amount}
              onChange={setAmount}
              error={errors.amount}
            />
          </div>
          <TextField
            label="Reference"
            value={reference}
            maxLength={100}
            onChange={(e) => setReference(e.target.value)}
            error={errors.reference}
            hint="UPI transaction id, cheque number, or card last 4 digits + approval code. Never a full card number."
          />
          <TextField
            label="Received at"
            type="datetime-local"
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
            error={errors.receivedAt}
            hint="Blank = now. Not in the future, and not older than 400 days."
          />
          <fieldset className="dos-fieldset">
            <legend className="dos-label">Apply to</legend>
            <div className="dos-stack" data-gap="sm">
              {(
                [
                  ["auto", "Oldest invoices first"],
                  ["choose", "Choose invoices"],
                  ["advance", "Keep as patient advance"],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="dos-check__label" style={{ display: "flex", gap: 8 }}>
                  <input
                    type="radio"
                    name="alloc-mode"
                    checked={mode === v}
                    onChange={() => setMode(v)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {mode !== "advance" ? (
            outstanding.loading && !outstanding.data ? (
              <Spinner label="Loading invoices" />
            ) : outstanding.error ? (
              <Alert tone="danger">{errorStateFor(outstanding.error).description}</Alert>
            ) : mode === "choose" ? (
              <>
                <AllocationList
                  invoices={invoices}
                  picks={picks}
                  setPicks={setPicks}
                  errors={pickErrors}
                />
                {errors.allocations ? (
                  <div className="dos-error" role="alert">
                    {errors.allocations}
                  </div>
                ) : null}
              </>
            ) : invoices.length === 0 ? (
              <p className="dos-muted">
                Nothing is owed at this branch, so all of it becomes advance.
              </p>
            ) : (
              <p className="dos-hint">
                {invoices.length} invoice{invoices.length === 1 ? "" : "s"} with a balance, oldest
                first.
              </p>
            )
          ) : null}
          {amountPaise ? (
            <p aria-live="polite">
              {mode === "choose" ? `Applied to invoices: ${formatPaise(allocatedPaise)}. ` : ""}
              {advancePaise > 0 ? (
                <>
                  <Badge tone="info">Advance</Badge> {formatPaise(advancePaise)} will be kept as the
                  patient's advance
                  {settings && !settings.allowAdvancePayments
                    ? " (not allowed at this clinic)"
                    : ""}
                  .
                </>
              ) : (
                "Nothing is left over."
              )}
            </p>
          ) : null}
          <TextareaField
            label="Notes"
            rows={2}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {errors.form ? (
            <div className="dos-error" role="alert">
              {errors.form}
            </div>
          ) : null}
          <div className="bil-actions">
            <Button onClick={submit} loading={record.pending}>
              Record payment
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="dos-stack">
          {checkout ? (
            <CheckoutResult checkout={checkout} />
          ) : (
            <>
              <Alert tone="info">
                The patient pays on the gateway's hosted checkout. The payment stays "awaiting
                gateway" until the gateway confirms it, then it is recorded and applied to the
                invoices you tick.
              </Alert>
              <RupeeField
                label="Amount"
                required
                value={onlineAmount}
                onChange={setOnlineAmount}
                error={errors.online}
              />
              <AllocationList
                invoices={invoices}
                picks={onlinePicks}
                setPicks={(p) => {
                  setOnlinePicks(p);
                  const total = Object.keys(p).reduce(
                    (s, id) => s + (invoices.find((i) => i.id === id)?.balancePaise ?? 0),
                    0,
                  );
                  if (total > 0) setOnlineAmount(paiseToRupeeInput(total));
                }}
                withAmounts={false}
              />
              <div className="bil-actions">
                <Button onClick={submitOnline} loading={startCheckout.pending}>
                  Start online payment
                </Button>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {!patient && !presetPatient ? (
        <EmptyState
          title="Choose a patient"
          description="Their open invoices are listed once chosen."
        />
      ) : null}
      <p className="dos-hint">
        Mistakes are fixed with a refund or an advance adjustment, never by editing a payment.{" "}
        <Link href="/payments">All payments</Link>
      </p>
    </div>
  );
}

/** Fake hosted-checkout outcome of the stub gateway (and the shape a real gateway returns). */
function CheckoutResult({ checkout }: { checkout: GatewayCheckoutResponse }) {
  const Link = useLink();
  const live = useQuery(() => billingApi.payments.get(checkout.paymentId), [checkout.paymentId]);
  const status = live.data?.status ?? checkout.status;
  return (
    <div className="bil-checkout" aria-live="polite">
      <div className="dos-cluster">
        <strong>Online payment started</strong>
        <PaymentStatusBadge status={status} />
      </div>
      <p style={{ margin: 0 }}>
        {status === "RECORDED"
          ? "The gateway confirmed the payment and it has been applied."
          : status === "FAILED"
            ? "The gateway reported that the payment failed. Nothing was charged to the invoices."
            : "Waiting for the gateway to confirm. Never mark this paid until it does."}
      </p>
      <dl className="dos-dl" data-columns="1">
        <div className="dos-dl__row">
          <dt>Gateway</dt>
          <dd>{checkout.gateway}</dd>
        </div>
        <div className="dos-dl__row">
          <dt>Reference</dt>
          <dd className="dos-mono">{checkout.gatewayRef}</dd>
        </div>
        <div className="dos-dl__row">
          <dt>Checkout page</dt>
          <dd>
            <code>{checkout.checkoutUrl}</code>
            <div className="dos-hint">
              {checkout.gateway === "STUB"
                ? "Stub gateway: this is a fake page that doesn't open. In development, send the signed webhook to confirm it."
                : "Share this link with the patient."}
            </div>
          </dd>
        </div>
        <div className="dos-dl__row">
          <dt>Expires</dt>
          <dd>{formatDateTime(checkout.expiresAt)}</dd>
        </div>
      </dl>
      <div className="bil-actions">
        <Button variant="secondary" onClick={live.reload} loading={live.loading}>
          Check status
        </Button>
        <Link href={`/payments/${checkout.paymentId}`}>Open payment</Link>
      </div>
    </div>
  );
}
