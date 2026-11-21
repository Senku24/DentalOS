"use client";
import { Alert, Button, Dialog, SelectField, TextField, TextareaField } from "@dentalos/ui";
import {
  type AdjustmentKind,
  type InvoiceDetailResponse,
  issueAdjustmentRequest,
  voidInvoiceRequest,
} from "@dentalos/validation";
import { useEffect, useState } from "react";
import { billingApi } from "../../lib/api/billing";
import { type ApiError } from "../../lib/api/errors";
import { useMutation } from "../../lib/api/hooks";
import { formatPaise, todayISO } from "../../lib/format";
import { rupeesToPaise, validate } from "../../lib/forms";
import { RupeeField } from "./fields";
import { useKeyer } from "./use-billing";

type Done = (inv: InvoiceDetailResponse) => void;

/** Issue: assigns the gap-free number and freezes the invoice. */
export function IssueDialog({
  invoice,
  open,
  onOpenChange,
  onDone,
  onError,
}: {
  invoice: InvoiceDetailResponse;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: Done;
  onError: (e: ApiError) => void;
}) {
  const [due, setDue] = useState(invoice.dueDate ?? "");
  const issue = useMutation(
    (dueDate: string) => billingApi.invoices.issue(invoice.id, dueDate ? { dueDate } : {}),
    {
      success: (r) => `Invoice ${r.number ?? ""} issued`,
      onSuccess: (r) => {
        onDone(r);
        onOpenChange(false);
      },
      onError,
    },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Issue this invoice?"
      description={`Issuing assigns the next invoice number and locks the lines, prices, discounts and GST. After that it can only be corrected with a credit or debit note. Total ${formatPaise(invoice.totalPaise)}.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} autoFocus>
            Not yet
          </Button>
          <Button loading={issue.pending} onClick={() => void issue.run(due)}>
            Issue invoice
          </Button>
        </>
      }
    >
      <TextField
        label="Due date"
        type="date"
        min={todayISO()}
        value={due}
        onChange={(e) => setDue(e.target.value)}
        hint="Blank = the clinic's default payment terms."
      />
    </Dialog>
  );
}

/** Void: draft, or an issued invoice with no payments and no credit/debit notes. */
export function VoidDialog({
  invoice,
  open,
  onOpenChange,
  onDone,
  onError,
}: {
  invoice: InvoiceDetailResponse;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: Done;
  onError: (e: ApiError) => void;
}) {
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (open) {
      setReason("");
      setErr(undefined);
    }
  }, [open]);
  const run = useMutation((r: string) => billingApi.invoices.void(invoice.id, { reason: r }), {
    success: "Invoice voided",
    onSuccess: (r) => {
      onDone(r);
      onOpenChange(false);
    },
    onError,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Void this invoice?"
      description={
        invoice.status === "DRAFT"
          ? "The draft is cancelled and can't be reopened."
          : `${invoice.number ?? "The invoice"} is cancelled and can't be reopened. Its number is never reused. If any money was received, refund it and issue a credit note instead.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} autoFocus>
            Keep invoice
          </Button>
          <Button
            variant="danger"
            loading={run.pending}
            onClick={() => {
              const v = validate(voidInvoiceRequest, { reason });
              if (!v.ok) return setErr(v.errors.reason ?? "Give a reason (at least 3 characters)");
              void run.run(v.data.reason);
            }}
          >
            Void invoice
          </Button>
        </>
      }
    >
      <TextareaField
        label="Reason"
        rows={3}
        maxLength={500}
        required
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          setErr(undefined);
        }}
        error={err}
      />
    </Dialog>
  );
}

/** Credit note (reduces what is owed, never more than the balance) or debit note (adds to it). */
export function AdjustmentDialog({
  invoice,
  open,
  onOpenChange,
  onDone,
}: {
  invoice: InvoiceDetailResponse;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Credit or debit note"
      description="The only way to correct an issued invoice. It is numbered, permanent and can't be edited."
    >
      {open ? (
        <AdjustmentForm invoice={invoice} onClose={() => onOpenChange(false)} onDone={onDone} />
      ) : null}
    </Dialog>
  );
}

function AdjustmentForm({
  invoice,
  onClose,
  onDone,
}: {
  invoice: InvoiceDetailResponse;
  onClose: () => void;
  onDone: () => void;
}) {
  const keyer = useKeyer("adj");
  const [kind, setKind] = useState<AdjustmentKind>("CREDIT");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<ApiError | null>(null);

  const run = useMutation(billingApi.invoices.adjust.bind(null), {
    success: (a) => `${a.kind === "CREDIT" ? "Credit" : "Debit"} note ${a.number} issued`,
    onSuccess: () => {
      keyer.reset();
      onDone();
      onClose();
    },
    onError: setServerError,
  });

  const submit = () => {
    setServerError(null);
    const amountPaise = rupeesToPaise(amount);
    const taxPaise = tax.trim() ? rupeesToPaise(tax) : undefined;
    const errs: Record<string, string> = {};
    if (amountPaise === null || amountPaise < 1) errs.amount = "Enter the note amount";
    else if (kind === "CREDIT" && amountPaise > invoice.balancePaise)
      errs.amount = `A credit note can't exceed the balance (${formatPaise(invoice.balancePaise)}). Refund first, then credit.`;
    if (taxPaise === null) errs.tax = "Enter an amount in ₹";
    else if (taxPaise !== undefined && amountPaise !== null && taxPaise > amountPaise)
      errs.tax = "The GST part can't be more than the note";
    if (reason.trim().length < 3) errs.reason = "Give a reason (at least 3 characters)";
    if (Object.keys(errs).length) return setErrors(errs);
    const body = {
      kind,
      amountPaise: amountPaise as number,
      ...(taxPaise ? { taxPaise } : {}),
      reason: reason.trim(),
    };
    const v = validate(issueAdjustmentRequest, {
      ...body,
      idempotencyKey: keyer.keyFor(JSON.stringify(body)),
    });
    if (!v.ok)
      return setErrors({ reason: v.errors.reason ?? "", amount: v.errors.amountPaise ?? "" });
    setErrors({});
    void run.run(invoice.id, v.data);
  };

  return (
    <div className="dos-stack">
      {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}
      <SelectField
        label="Type"
        value={kind}
        onChange={(e) => setKind(e.target.value as AdjustmentKind)}
      >
        <option value="CREDIT">Credit note: reduces what is owed</option>
        <option value="DEBIT">Debit note: adds to what is owed</option>
      </SelectField>
      <RupeeField
        label="Amount (GST included)"
        required
        value={amount}
        onChange={setAmount}
        error={errors.amount}
        hint={
          kind === "CREDIT"
            ? `Balance on the invoice: ${formatPaise(invoice.balancePaise)}`
            : undefined
        }
      />
      <RupeeField
        label="GST part of the amount"
        value={tax}
        onChange={setTax}
        error={errors.tax}
        hint="Optional, for GST returns. Leave blank for none."
      />
      <TextareaField
        label="Reason"
        rows={2}
        maxLength={500}
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors.reason}
      />
      <div className="bil-actions">
        <Button onClick={submit} loading={run.pending}>
          Issue {kind === "CREDIT" ? "credit" : "debit"} note
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Spend the patient's advance on this invoice. */
export function UseAdvanceDialog({
  invoice,
  advancePaise,
  open,
  onOpenChange,
  onDone,
}: {
  invoice: InvoiceDetailResponse;
  advancePaise: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: Done;
}) {
  const keyer = useKeyer("adv");
  const max = Math.min(advancePaise, invoice.balancePaise);
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string>();
  const [serverError, setServerError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (open) {
      setAmount((max / 100).toFixed(2).replace(/\.00$/, ""));
      setErr(undefined);
      setServerError(null);
    }
  }, [open, max]);
  const run = useMutation(
    (b: { invoiceId: string; amountPaise: number; idempotencyKey: string }) =>
      billingApi.patients.applyAdvance(invoice.patientId, b),
    {
      success: "Advance applied",
      onSuccess: (r) => {
        keyer.reset();
        onDone(r);
        onOpenChange(false);
      },
      onError: setServerError,
    },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Use patient advance"
      description={`Available advance ${formatPaise(advancePaise)}. Balance due ${formatPaise(invoice.balancePaise)}.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={run.pending}
            onClick={() => {
              const paise = rupeesToPaise(amount);
              if (paise === null || paise < 1) return setErr("Enter an amount");
              if (paise > max) return setErr(`At most ${formatPaise(max)}`);
              const body = { invoiceId: invoice.id, amountPaise: paise };
              void run.run({ ...body, idempotencyKey: keyer.keyFor(JSON.stringify(body)) });
            }}
          >
            Apply advance
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}
        <RupeeField label="Amount to apply" value={amount} onChange={setAmount} error={err} />
      </div>
    </Dialog>
  );
}
