"use client";
import { Alert, Button, Dialog, SelectField, TextField, TextareaField } from "@dentalos/ui";
import { receiveStockRequest, stockValuePaise } from "@dentalos/validation";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { collectPages } from "../../lib/api/clinical-client";
import { useMutation, useQuery } from "../../lib/api/hooks";
import { inventoryApi } from "../../lib/api/inventory";
import { formatPaise, todayISO } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import {
  BranchSelect,
  ItemSelect,
  newKey,
  num,
  unitCostFromRupees,
  unitLabel,
  useIdemKey,
  useItemDirectory,
  useScopedBranches,
} from "./bits";

export function useSuppliers(rev = 0) {
  const q = useQuery(
    () => collectPages((cursor) => inventoryApi.suppliers.list({ limit: 100, cursor }), 30),
    [rev],
  );
  const suppliers = q.data ?? [];
  const name = (id: string | null | undefined) =>
    id ? (suppliers.find((s) => s.id === id)?.name ?? "Unknown supplier") : "—";
  return { ...q, suppliers, name };
}

interface Line {
  key: string;
  itemId: string;
  quantity: string;
  unitCost: string;
  batchNo: string;
  expiryDate: string;
}
const blank = (): Line => ({
  key: newKey(),
  itemId: "",
  quantity: "",
  unitCost: "",
  batchNo: "",
  expiryDate: "",
});

/** Purchase receipt: supplier, reference, batch / expiry for tracked items, quantity and unit cost. */
export function ReceiveDialog({
  branchId: presetBranch,
  onClose,
  onDone,
}: { branchId?: string; onClose: () => void; onDone: () => void }) {
  const dir = useItemDirectory();
  const sup = useSuppliers();
  const { ids } = useScopedBranches();
  const [branchId, setBranchId] = useState(presetBranch ?? "");
  useEffect(() => {
    if (!branchId && ids.length === 1) setBranchId(ids[0] as string);
  }, [ids, branchId]);
  const [supplierId, setSupplierId] = useState("");
  const [reference, setReference] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const idem = useIdemKey();
  const save = useMutation(inventoryApi.stock.receive, {
    success: (r) =>
      `Stock received${r.totalCostPaise !== null ? ` (${formatPaise(r.totalCostPaise)})` : ""}`,
    onSuccess: () => {
      idem.done();
      onDone();
    },
    onError: (e) => setErrors(e.fieldErrors),
  });

  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const preview = lines.reduce((sum, l) => {
    const q = num(l.quantity);
    const c = unitCostFromRupees(l.unitCost);
    return q !== undefined && c !== undefined && Number.isFinite(q) && Number.isFinite(c)
      ? sum + stockValuePaise(q, c)
      : sum;
  }, 0);

  const submit = () => {
    const body = {
      branchId,
      supplierId,
      reference,
      receivedOn,
      notes,
      lines: lines.map((l) => {
        const tracked = dir.byId(l.itemId)?.tracksBatches;
        return {
          itemId: l.itemId,
          quantity: num(l.quantity),
          unitCostPaise: unitCostFromRupees(l.unitCost),
          batchNo: tracked ? l.batchNo : "",
          expiryDate: tracked ? l.expiryDate : "",
        };
      }),
    };
    const r = validate(receiveStockRequest, { ...body, idempotencyKey: idem.keyFor(body) });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    void save.run(r.data);
  };

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="Receive stock"
      description="Books a purchase into the branch. Costs feed the weighted-average valuation."
      footer={
        <>
          <span className="dos-muted" style={{ marginRight: "auto" }}>
            Total {formatPaise(preview)}
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Receive stock
          </Button>
        </>
      }
    >
      <form
        className="dos-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="dos-form-grid">
          <BranchSelect required value={branchId} onChange={setBranchId} error={errors.branchId} />
          <SelectField
            label="Supplier"
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            error={errors.supplierId}
          >
            <option value="">No supplier</option>
            {sup.suppliers
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </SelectField>
          <TextField
            label="Invoice / challan number"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            error={errors.reference}
          />
          <TextField
            label="Received on"
            type="date"
            required
            max={todayISO()}
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
            error={errors.receivedOn}
          />
        </div>
        {errors.lines ? <Alert tone="danger">{errors.lines}</Alert> : null}
        <div className="dos-stack" data-gap="sm">
          {lines.map((l, i) => {
            const item = dir.byId(l.itemId);
            return (
              <fieldset key={l.key} className="dos-card dos-stack" data-gap="sm">
                <legend className="dos-label">Line {i + 1}</legend>
                <div className="dos-form-grid">
                  <ItemSelect
                    items={dir.items}
                    value={l.itemId}
                    onChange={(v) => setLine(l.key, { itemId: v })}
                    error={errors[`lines.${i}.itemId`]}
                    required
                  />
                  <TextField
                    label={`Quantity${item ? ` (${unitLabel(item.unit)})` : ""}`}
                    inputMode="decimal"
                    required
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                    error={errors[`lines.${i}.quantity`]}
                  />
                  <TextField
                    label={`Unit cost (₹ per ${item ? unitLabel(item.unit) : "unit"})`}
                    inputMode="decimal"
                    required
                    value={l.unitCost}
                    onChange={(e) => setLine(l.key, { unitCost: e.target.value })}
                    error={errors[`lines.${i}.unitCostPaise`]}
                  />
                  {item?.tracksBatches ? (
                    <>
                      <TextField
                        label="Batch number"
                        required
                        value={l.batchNo}
                        onChange={(e) => setLine(l.key, { batchNo: e.target.value })}
                        error={errors[`lines.${i}.batchNo`]}
                      />
                      <TextField
                        label="Expiry date"
                        type="date"
                        required
                        value={l.expiryDate}
                        onChange={(e) => setLine(l.key, { expiryDate: e.target.value })}
                        error={errors[`lines.${i}.expiryDate`]}
                      />
                    </>
                  ) : null}
                </div>
                {lines.length > 1 ? (
                  <div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2 size={14} aria-hidden="true" /> Remove line {i + 1}
                    </Button>
                  </div>
                ) : null}
              </fieldset>
            );
          })}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setLines((ls) => [...ls, blank()])}
            >
              <Plus size={14} aria-hidden="true" /> Add line
            </Button>
          </div>
        </div>
        <TextareaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </form>
    </Dialog>
  );
}
