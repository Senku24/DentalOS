"use client";
import {
  Alert,
  Button,
  ConfirmDialog,
  Dialog,
  Drawer,
  TextField,
  TextareaField,
} from "@dentalos/ui";
import {
  type DiscountSpec,
  type InvoiceDetailResponse,
  type InvoiceLineResponse,
  type ResolvedBillingSettings,
  gstStateCode,
  setInvoiceDiscountRequest,
  updateInvoiceLineRequest,
  updateInvoiceRequest,
} from "@dentalos/validation";
import { useEffect, useState } from "react";
import { billingApi } from "../../lib/api/billing";
import { discountProblem } from "../../lib/api/billing-rules";
import type { ApiError } from "../../lib/api/errors";
import { useMutation } from "../../lib/api/hooks";
import { formatPaise, todayISO } from "../../lib/format";
import { validate } from "../../lib/forms";
import { canDo, sessionPrincipal } from "../../lib/session";
import {
  type DiscountDraft,
  DiscountFields,
  NO_DISCOUNT,
  draftFromAmount,
  parseDiscount,
} from "./fields";
import {
  LineCard,
  type LineDraft,
  ServicePicker,
  adHocLine,
  hasIssues,
  lineIssues,
  lineToInput,
  serviceLine,
} from "./line-editor";

type Done = (inv: InvoiceDetailResponse) => void;
type Fail = (e: ApiError) => void;

/** Due date, place of supply and notes of a DRAFT. */
export function HeaderDialog({
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
  onError: Fail;
}) {
  const [due, setDue] = useState("");
  const [place, setPlace] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setDue(invoice.dueDate ?? "");
    setPlace(invoice.placeOfSupplyStateCode ?? "");
    setNotes(invoice.notes ?? "");
    setErrors({});
  }, [open, invoice]);
  const save = useMutation(
    (b: Parameters<typeof billingApi.invoices.update>[1]) =>
      billingApi.invoices.update(invoice.id, b),
    {
      success: "Invoice details saved",
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
      title="Invoice details"
      description="Editable while the invoice is a draft."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={save.pending}
            onClick={() => {
              const body = {
                dueDate: due || null,
                placeOfSupplyStateCode: place.trim() || null,
                notes: notes.trim() || null,
              };
              const v = validate(updateInvoiceRequest, body);
              const stateOk = !place.trim() || gstStateCode.safeParse(place.trim()).success;
              if (!v.ok || !stateOk) {
                return setErrors({
                  place: stateOk ? "" : "Two digits, for example 29",
                  notes: v.ok ? "" : (v.errors.notes ?? ""),
                });
              }
              void save.run(v.data);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <TextField
          label="Due date"
          type="date"
          min={todayISO()}
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <TextField
          label="Place of supply (GST state code)"
          inputMode="numeric"
          maxLength={2}
          value={place}
          onChange={(e) => setPlace(e.target.value)}
          error={errors.place || undefined}
          hint={`Supplier state ${invoice.supplierStateCode ?? "unknown"}. A different code charges IGST instead of CGST + SGST.`}
        />
        <TextareaField
          label="Notes"
          rows={3}
          maxLength={1000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          error={errors.notes || undefined}
        />
      </div>
    </Dialog>
  );
}

/** Add a catalogue service or custom item to a DRAFT. */
export function AddLineDrawer({
  invoice,
  settings,
  open,
  onOpenChange,
  onDone,
  onError,
}: {
  invoice: InvoiceDetailResponse;
  settings: ResolvedBillingSettings | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: Done;
  onError: Fail;
}) {
  const [line, setLine] = useState<LineDraft | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (open) {
      setLine(null);
      setShow(false);
    }
  }, [open]);
  const add = useMutation(
    (b: ReturnType<typeof lineToInput>) => billingApi.invoices.addLine(invoice.id, b),
    {
      success: "Line added",
      onSuccess: (r) => {
        onDone(r);
        onOpenChange(false);
      },
      onError,
    },
  );
  const issues = line ? lineIssues(line, { branchId: invoice.branchId, settings }) : {};
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Add a line"
      description="Catalogue services are priced for this branch; custom items carry their own price."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!line}
            loading={add.pending}
            onClick={() => {
              setShow(true);
              if (!line || hasIssues(issues)) return;
              void add.run(lineToInput(line));
            }}
          >
            Add line
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        <ServicePicker
          branchId={invoice.branchId}
          onPick={(s) => setLine(serviceLine(s))}
          onAddCustom={() => setLine(adHocLine())}
        />
        {line ? (
          <LineCard
            line={line}
            index={invoice.lines.length}
            issues={show ? issues : {}}
            onChange={setLine}
          />
        ) : (
          <p className="dos-muted">Pick a service above, or add a custom item.</p>
        )}
      </div>
    </Drawer>
  );
}

/** Existing line → editable draft (percent discounts were stored as paise, so they show as amounts). */
const init = (l: InvoiceLineResponse): LineDraft => ({
  key: l.id,
  serviceId: l.serviceId ?? l.planItemId ?? undefined,
  description: l.description,
  quantity: String(l.quantity),
  unitRupees: (l.unitPricePaise / 100).toFixed(2).replace(/\.00$/, ""),
  servicePricePaise: l.unitPricePaise,
  taxable: l.taxRateBp > 0,
  discount: draftFromAmount(l.discountPaise, l.discountReason),
});

/** Edit quantity, price (custom lines only) and discount of one DRAFT line. */
export function EditLineDialog({
  invoice,
  line,
  settings,
  onClose,
  onDone,
  onError,
}: {
  invoice: InvoiceDetailResponse;
  line: InvoiceLineResponse | null;
  settings: ResolvedBillingSettings | undefined;
  onClose: () => void;
  onDone: Done;
  onError: Fail;
}) {
  const [draft, setDraft] = useState<LineDraft | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    setDraft(line ? init(line) : null);
    setShow(false);
  }, [line]);
  const save = useMutation(
    (b: Parameters<typeof billingApi.invoices.updateLine>[2]) =>
      billingApi.invoices.updateLine(invoice.id, (line as InvoiceLineResponse).id, b),
    {
      success: "Line updated",
      onSuccess: (r) => {
        onDone(r);
        onClose();
      },
      onError,
    },
  );
  const issues = draft ? lineIssues(draft, { branchId: invoice.branchId, settings }) : {};
  const adHoc = line ? !line.serviceId && !line.planItemId : false;
  return (
    <Dialog
      open={Boolean(line)}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Edit line"
      description={
        adHoc
          ? "Custom item: you can change its description, price, quantity and discount."
          : "Catalogue and plan lines keep the server's price. Reduce it with a discount."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.pending}
            onClick={() => {
              setShow(true);
              if (!draft || !line || hasIssues(issues)) return;
              const next = lineToInput(draft);
              const before = init(line);
              const spec = parseDiscount(draft.discount) as DiscountSpec | null;
              const discountChanged =
                JSON.stringify(draft.discount) !== JSON.stringify(before.discount);
              const body = {
                ...(next.quantity !== line.quantity ? { quantity: next.quantity } : {}),
                ...(adHoc && draft.description.trim() !== line.description
                  ? { description: draft.description.trim() }
                  : {}),
                ...(adHoc &&
                next.unitPricePaise !== undefined &&
                next.unitPricePaise !== line.unitPricePaise
                  ? { unitPricePaise: next.unitPricePaise }
                  : {}),
                ...(discountChanged
                  ? spec
                    ? { discount: spec, discountReason: draft.discount.reason.trim() }
                    : { discount: null, discountReason: null }
                  : {}),
              };
              const v = validate(updateInvoiceLineRequest, body);
              if (!v.ok) return;
              if (Object.keys(v.data).length === 0) return onClose();
              void save.run(v.data);
            }}
          >
            Save line
          </Button>
        </>
      }
    >
      {draft ? (
        <LineCard
          line={draft}
          index={line ? line.lineNo - 1 : 0}
          issues={show ? issues : {}}
          onChange={(l) =>
            setDraft(
              adHoc ? l : { ...l, serviceId: draft.serviceId, description: draft.description },
            )
          }
        />
      ) : null}
    </Dialog>
  );
}

export function DeleteLineDialog({
  invoice,
  line,
  onClose,
  onDone,
  onError,
}: {
  invoice: InvoiceDetailResponse;
  line: InvoiceLineResponse | null;
  onClose: () => void;
  onDone: Done;
  onError: Fail;
}) {
  const del = useMutation(
    () => billingApi.invoices.deleteLine(invoice.id, (line as InvoiceLineResponse).id),
    {
      success: "Line removed",
      onSuccess: (r) => {
        onDone(r);
        onClose();
      },
      onError,
    },
  );
  return (
    <ConfirmDialog
      open={Boolean(line)}
      onOpenChange={(o) => !o && onClose()}
      title="Remove this line?"
      description={
        line ? `${line.description} (${formatPaise(line.totalPaise)}) is taken off the draft.` : ""
      }
      confirmLabel="Remove line"
      tone="danger"
      loading={del.pending}
      onConfirm={() => void del.run()}
    />
  );
}

/** Invoice-level discount of a DRAFT (set, change or clear). */
export function InvoiceDiscountDialog({
  invoice,
  settings,
  open,
  onOpenChange,
  onDone,
  onError,
}: {
  invoice: InvoiceDetailResponse;
  settings: ResolvedBillingSettings | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: Done;
  onError: Fail;
}) {
  const [draft, setDraft] = useState<DiscountDraft>(NO_DISCOUNT);
  const [issue, setIssue] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setIssue(undefined);
    setDraft(
      invoice.invoiceDiscountPaise <= 0
        ? NO_DISCOUNT
        : invoice.invoiceDiscountPercentBp
          ? {
              kind: "PERCENT",
              value: String(invoice.invoiceDiscountPercentBp / 100),
              reason: invoice.discountReason ?? "",
            }
          : draftFromAmount(invoice.invoiceDiscountPaise, invoice.discountReason),
    );
  }, [open, invoice]);
  const base = invoice.lines.reduce((s, l) => s + l.grossPaise - l.discountPaise, 0);
  const save = useMutation(
    (b: Parameters<typeof billingApi.invoices.setDiscount>[1]) =>
      billingApi.invoices.setDiscount(invoice.id, b),
    {
      success: "Discount saved",
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
      title="Invoice discount"
      description={`Applies to the amount after line discounts (${formatPaise(base)}) and is shared across the lines for GST. Choose "No discount" to clear it.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={save.pending}
            onClick={() => {
              const spec = parseDiscount(draft);
              if (typeof spec === "string") return setIssue(spec);
              const problem = discountProblem({
                discount: spec,
                basePaise: base,
                reason: draft.reason,
                canApply: canDo("discount:apply", { branchId: invoice.branchId }),
                roles: sessionPrincipal().roles,
                settings,
              });
              if (problem) return setIssue(problem);
              const v = validate(setInvoiceDiscountRequest, {
                discount: spec,
                ...(spec ? { reason: draft.reason.trim() } : {}),
              });
              if (!v.ok) return setIssue(Object.values(v.errors).join(" · "));
              void save.run(v.data);
            }}
          >
            Save discount
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        {issue ? <Alert tone="danger">{issue}</Alert> : null}
        <DiscountFields
          draft={draft}
          onChange={(d) => {
            setDraft(d);
            setIssue(undefined);
          }}
          disabled={!canDo("discount:apply", { branchId: invoice.branchId })}
        />
      </div>
    </Dialog>
  );
}
