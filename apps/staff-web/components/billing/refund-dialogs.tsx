"use client";
import {
  Alert,
  Button,
  Dialog,
  SelectField,
  Spinner,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type InvoiceDetailResponse,
  PAYMENT_METHODS,
  type PaymentDetailResponse,
  type PaymentMethod,
  type RefundResponse,
  refundNeedsApproval,
  rejectRefundRequest,
  requestRefundRequest,
} from "@dentalos/validation";
import { useEffect, useState } from "react";
import { billingApi } from "../../lib/api/billing";
import { methodLabel, refundCapForInvoice } from "../../lib/api/billing-rules";
import { type ApiError, errorStateFor } from "../../lib/api/errors";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { formatDate, formatPaise } from "../../lib/format";
import { rupeesToPaise, validate } from "../../lib/forms";
import { RupeeField } from "./fields";
import { useBillingSettings, useKeyer } from "./use-billing";

/**
 * Request a refund. From an invoice: pick one of the payments that paid it (the money returns to that
 * invoice's balance when processed). From a payment (`payment` set, no invoice): refund the unallocated
 * advance. At or below the approval threshold it is approved automatically; above it another person with
 * refund approval rights must approve it, then it is processed (money handed back).
 */
export function RefundRequestDialog({
  open,
  onOpenChange,
  invoice,
  payment,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoice?: InvoiceDetailResponse;
  payment?: PaymentDetailResponse;
  onDone: (r: RefundResponse) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={invoice ? "Request a refund" : "Refund patient advance"}
      description={
        invoice
          ? `Return money paid towards ${invoice.number ?? "this invoice"}. The invoice balance reopens when the refund is processed.`
          : "Return the part of this payment that wasn't applied to an invoice."
      }
    >
      {open ? (
        <RefundForm
          invoice={invoice}
          payment={payment}
          onClose={() => onOpenChange(false)}
          onDone={onDone}
        />
      ) : null}
    </Dialog>
  );
}

function RefundForm({
  invoice,
  payment: fixedPayment,
  onClose,
  onDone,
}: {
  invoice?: InvoiceDetailResponse;
  payment?: PaymentDetailResponse;
  onClose: () => void;
  onDone: (r: RefundResponse) => void;
}) {
  const keyer = useKeyer("ref");
  const branchId = invoice?.branchId ?? fixedPayment?.branchId;
  const { effective } = useBillingSettings(branchId);

  const paymentIds = invoice
    ? [...new Set(invoice.allocations.map((a) => a.paymentId))].sort()
    : [];
  const payments = useQuery(
    () => Promise.all(paymentIds.map((id) => billingApi.payments.get(id))),
    [paymentIds.join(",")],
    Boolean(invoice),
  );
  const options: PaymentDetailResponse[] = fixedPayment
    ? [fixedPayment]
    : (payments.data ?? []).filter((p) => p.status === "RECORDED");
  const capOf = (p: PaymentDetailResponse) =>
    invoice ? refundCapForInvoice(invoice, p) : Math.max(0, p.unallocatedPaise);

  const [paymentId, setPaymentId] = useState(fixedPayment?.id ?? "");
  const chosen = options.find((p) => p.id === paymentId);
  useEffect(() => {
    if (paymentId || options.length === 0) return;
    const first = options.find((p) => capOf(p) > 0) ?? options[0];
    if (first) setPaymentId(first.id);
  });
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<ApiError | null>(null);

  const cap = chosen ? capOf(chosen) : 0;
  const amountPaise = rupeesToPaise(amount);
  const needsApproval =
    amountPaise !== null && effective
      ? refundNeedsApproval(amountPaise, effective.refundApprovalThresholdPaise)
      : null;

  const request = useMutation(billingApi.refunds.request, {
    success: (r) =>
      r.status === "REQUESTED"
        ? "Refund requested: awaiting approval"
        : "Refund approved: ready to process",
    onSuccess: (r) => {
      keyer.reset();
      onDone(r);
      onClose();
    },
    onError: setServerError,
  });

  const submit = () => {
    setServerError(null);
    const errs: Record<string, string> = {};
    if (!chosen) errs.payment = "Choose the payment to refund";
    if (amountPaise === null || amountPaise < 1) errs.amount = "Enter the amount to refund";
    else if (chosen && amountPaise > cap)
      errs.amount = `At most ${formatPaise(cap)} can be refunded`;
    if (reason.trim().length < 3) errs.reason = "Give a reason (at least 3 characters)";
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    const body = {
      paymentId: paymentId,
      ...(invoice ? { invoiceId: invoice.id } : {}),
      amountPaise: amountPaise as number,
      ...(method ? { method } : {}),
      reason: reason.trim(),
    };
    const v = validate(requestRefundRequest, {
      ...body,
      idempotencyKey: keyer.keyFor(JSON.stringify(body)),
    });
    if (!v.ok) {
      setErrors({ reason: v.errors.reason ?? "", amount: v.errors.amountPaise ?? "" });
      return;
    }
    setErrors({});
    void request.run(v.data);
  };

  if (invoice && payments.loading && !payments.data) return <Spinner label="Loading payments" />;
  if (payments.error)
    return <Alert tone="danger">{errorStateFor(payments.error).description}</Alert>;
  if (options.every((p) => capOf(p) <= 0))
    return (
      <div className="dos-stack">
        <Alert tone="info">
          Nothing is available to refund here: everything paid has already been refunded or is
          waiting on a refund request.
        </Alert>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    );

  return (
    <div className="dos-stack">
      {serverError ? <Alert tone="danger">{serverError.message}</Alert> : null}
      {fixedPayment ? null : (
        <SelectField
          label="Payment to refund"
          required
          value={paymentId}
          onChange={(e) => setPaymentId(e.target.value)}
          error={errors.payment}
        >
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.receiptNumber ?? "Payment"} · {methodLabel(p.method)} · {formatDate(p.receivedAt)}{" "}
              · refundable {formatPaise(capOf(p))}
            </option>
          ))}
        </SelectField>
      )}
      <RupeeField
        label="Refund amount"
        required
        value={amount}
        onChange={setAmount}
        error={errors.amount}
        hint={`Up to ${formatPaise(cap)}`}
      />
      <SelectField
        label="Refund method"
        value={method}
        onChange={(e) => setMethod(e.target.value as PaymentMethod | "")}
        hint="Blank = the method the patient paid with."
      >
        <option value="">
          Same as the payment{chosen ? ` (${methodLabel(chosen.method)})` : ""}
        </option>
        {PAYMENT_METHODS.map((m) => (
          <option key={m} value={m}>
            {methodLabel(m)}
          </option>
        ))}
      </SelectField>
      <TextareaField
        label="Reason"
        rows={2}
        maxLength={500}
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={errors.reason}
      />
      {effective && needsApproval !== null ? (
        <Alert tone={needsApproval ? "warning" : "info"}>
          {needsApproval
            ? `Above ${formatPaise(effective.refundApprovalThresholdPaise)}: another person with refund approval rights must approve it before it can be processed.`
            : `At or below ${formatPaise(effective.refundApprovalThresholdPaise)}: approved automatically. You then process it when the money is handed back.`}
        </Alert>
      ) : null}
      <div className="bil-actions">
        <Button onClick={submit} loading={request.pending}>
          Request refund
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Reject a refund request (reason required). */
export function RejectRefundDialog({
  refund,
  onClose,
  onDone,
}: {
  refund: RefundResponse | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const reject = useMutation(
    (id: string, r: string) => billingApi.refunds.reject(id, { reason: r }),
    {
      success: "Refund rejected",
      onSuccess: () => {
        onDone();
        onClose();
      },
      onError: (e) => setError(e.message),
    },
  );
  useEffect(() => {
    if (refund) {
      setReason("");
      setError(undefined);
    }
  }, [refund]);
  return (
    <Dialog
      open={Boolean(refund)}
      onOpenChange={(o) => !o && onClose()}
      title="Reject refund"
      description={
        refund
          ? `Reject the ${formatPaise(refund.amountPaise)} refund request. This can't be undone.`
          : ""
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={reject.pending}
            onClick={() => {
              const v = validate(rejectRefundRequest, { reason });
              if (!v.ok) return setError(v.errors.reason ?? "Give a reason");
              if (refund) void reject.run(refund.id, v.data.reason);
            }}
          >
            Reject refund
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
          setError(undefined);
        }}
        error={error}
      />
    </Dialog>
  );
}

/** Mark an approved refund as processed: the money has been handed back / transferred. */
export function ProcessRefundDialog({
  refund,
  onClose,
  onDone,
}: {
  refund: RefundResponse | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [error, setError] = useState<string>();
  const process = useMutation(
    (id: string, b: { reference?: string; method?: PaymentMethod }) =>
      billingApi.refunds.process(id, b),
    {
      success: "Refund processed",
      onSuccess: () => {
        onDone();
        onClose();
      },
      onError: (e) => setError(e.message),
    },
  );
  useEffect(() => {
    if (refund) {
      setReference(refund.reference ?? "");
      setMethod("");
      setError(undefined);
    }
  }, [refund]);
  return (
    <Dialog
      open={Boolean(refund)}
      onOpenChange={(o) => !o && onClose()}
      title="Process refund"
      description={
        refund
          ? `Confirm that ${formatPaise(refund.amountPaise)} was returned to the patient. The invoice balance reopens and the refund is final.`
          : ""
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button
            loading={process.pending}
            onClick={() => {
              if (refund)
                void process.run(refund.id, {
                  ...(reference.trim() ? { reference: reference.trim() } : {}),
                  ...(method ? { method } : {}),
                });
            }}
          >
            Mark as processed
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label="Reference"
          maxLength={100}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          hint="Bank transfer id, UPI id or cash voucher number."
        />
        <SelectField
          label="Returned by"
          value={method}
          onChange={(e) => setMethod(e.target.value as PaymentMethod | "")}
        >
          <option value="">As requested{refund ? ` (${methodLabel(refund.method)})` : ""}</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {methodLabel(m)}
            </option>
          ))}
        </SelectField>
      </div>
    </Dialog>
  );
}
