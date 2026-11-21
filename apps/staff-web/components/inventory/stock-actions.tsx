"use client";
import { Alert, Button, Dialog, SelectField, TextField, TextareaField } from "@dentalos/ui";
import {
  type InventoryItemResponse,
  adjustStockRequest,
  consumeStockRequest,
  recordWasteRequest,
} from "@dentalos/validation";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation } from "../../lib/api/hooks";
import { inventoryApi } from "../../lib/api/inventory";
import { todayISO } from "../../lib/format";
import { type FieldErrors, validate } from "../../lib/forms";
import {
  BatchSelect,
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

export interface StockPreset {
  branchId?: string;
  itemId?: string;
}

/** Defaults the branch to the only one the user may act in. */
function useDefaultBranch(preset?: string) {
  const { ids } = useScopedBranches();
  const [branchId, setBranchId] = useState(preset ?? "");
  useEffect(() => {
    if (!branchId && ids.length === 1) setBranchId(ids[0] as string);
  }, [ids, branchId]);
  return [branchId, setBranchId] as const;
}

// ---- Record usage (consumption) ----------------------------------------------------------------
interface UseLine {
  key: string;
  itemId: string;
  quantity: string;
  batchNo: string;
}
const blankLine = (itemId = ""): UseLine => ({ key: newKey(), itemId, quantity: "", batchNo: "" });

export function ConsumeDialog({
  preset,
  onClose,
  onDone,
}: { preset?: StockPreset; onClose: () => void; onDone: () => void }) {
  const dir = useItemDirectory();
  const [branchId, setBranchId] = useDefaultBranch(preset?.branchId);
  const [procedureRecordId, setProcedure] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<UseLine[]>([blankLine(preset?.itemId)]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const idem = useIdemKey();
  const save = useMutation(inventoryApi.stock.consume, {
    success: (r) =>
      `Usage recorded (${r.movements.length} stock movement${r.movements.length === 1 ? "" : "s"})`,
    onSuccess: () => {
      idem.done();
      onDone();
    },
    onError: (e) => setErrors(e.fieldErrors),
  });

  const setLine = (key: string, patch: Partial<UseLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = () => {
    const body = {
      branchId,
      procedureRecordId,
      reason,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        quantity: num(l.quantity),
        batchNo: l.batchNo,
      })),
    };
    const r = validate(consumeStockRequest, { ...body, idempotencyKey: idem.keyFor(body) });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    void save.run(r.data);
  };

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title="Record usage"
      description="Consumes stock at the branch. Batch-tracked items are used first-expiry-first-out unless you pick a batch."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Record usage
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
          <TextField
            label="Procedure record id (optional)"
            hint="Links the usage to a procedure so the cost can be traced to the visit."
            value={procedureRecordId}
            onChange={(e) => setProcedure(e.target.value)}
            error={errors.procedureRecordId}
            autoComplete="off"
            inputMode="text"
          />
        </div>
        <TextField
          label="Reason / note (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />
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
                    onChange={(v) => setLine(l.key, { itemId: v, batchNo: "" })}
                    error={errors[`lines.${i}.itemId`]}
                    required
                  />
                  <TextField
                    label={`Quantity${item ? ` (${unitLabel(item.unit)})` : ""}`}
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                    error={errors[`lines.${i}.quantity`]}
                    required
                  />
                  {item?.tracksBatches ? (
                    <BatchSelect
                      branchId={branchId}
                      itemId={l.itemId}
                      value={l.batchNo}
                      onChange={(v) => setLine(l.key, { batchNo: v })}
                      error={errors[`lines.${i}.batchNo`]}
                    />
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
              onClick={() => setLines((ls) => [...ls, blankLine()])}
            >
              <Plus size={14} aria-hidden="true" /> Add item
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// ---- Adjust (count correction) ------------------------------------------------------------------
export function AdjustDialog({
  preset,
  onClose,
  onDone,
}: { preset?: StockPreset; onClose: () => void; onDone: () => void }) {
  const dir = useItemDirectory();
  const [branchId, setBranchId] = useDefaultBranch(preset?.branchId);
  const [itemId, setItemId] = useState(preset?.itemId ?? "");
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const idem = useIdemKey();
  const item = dir.byId(itemId);
  const save = useMutation(inventoryApi.stock.adjust, {
    success: "Stock adjusted",
    onSuccess: () => {
      idem.done();
      onDone();
    },
    onError: (e) => setErrors(e.fieldErrors),
  });

  const submit = () => {
    const n = num(amount);
    const body = {
      branchId,
      itemId,
      delta: n === undefined ? undefined : direction === "OUT" ? -Math.abs(n) : Math.abs(n),
      reason,
      batchNo: item?.tracksBatches ? batchNo : "",
      expiryDate: direction === "IN" && item?.tracksBatches ? expiryDate : "",
      unitCostPaise: direction === "IN" ? unitCostFromRupees(unitCost) : undefined,
    };
    const r = validate(adjustStockRequest, { ...body, idempotencyKey: idem.keyFor(body) });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    void save.run(r.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Adjust stock"
      description="Corrects the on-hand count after a stock take. A reason is required and recorded with your name."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Save adjustment
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
          <ItemSelect
            items={dir.items}
            value={itemId}
            onChange={(v) => {
              setItemId(v);
              setBatchNo("");
            }}
            error={errors.itemId}
            required
          />
          <SelectField
            label="Direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as "IN" | "OUT")}
          >
            <option value="OUT">Write off (count is lower)</option>
            <option value="IN">Write on (count is higher)</option>
          </SelectField>
          <TextField
            label={`Quantity${item ? ` (${unitLabel(item.unit)})` : ""}`}
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            error={errors.delta}
          />
          {item?.tracksBatches && direction === "OUT" ? (
            <BatchSelect
              branchId={branchId}
              itemId={itemId}
              value={batchNo}
              onChange={setBatchNo}
              error={errors.batchNo}
            />
          ) : null}
          {item?.tracksBatches && direction === "IN" ? (
            <>
              <TextField
                label="Batch number"
                required
                value={batchNo}
                onChange={(e) => setBatchNo(e.target.value)}
                error={errors.batchNo}
              />
              <TextField
                label="Expiry date"
                type="date"
                required
                min={todayISO()}
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                error={errors.expiryDate}
              />
            </>
          ) : null}
          {direction === "IN" ? (
            <TextField
              label="Unit cost (₹ per unit)"
              hint="Only needed when the branch has no stock or cost history for this item."
              inputMode="decimal"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              error={errors.unitCostPaise}
            />
          ) : null}
        </div>
        <TextareaField
          label="Reason"
          required
          hint="For example: stock take on 3 Nov, 2 boxes found damaged."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />
      </form>
    </Dialog>
  );
}

// ---- Waste ---------------------------------------------------------------------------------------
export function WasteDialog({
  preset,
  onClose,
  onDone,
}: { preset?: StockPreset; onClose: () => void; onDone: () => void }) {
  const dir = useItemDirectory();
  const [branchId, setBranchId] = useDefaultBranch(preset?.branchId);
  const [itemId, setItemId] = useState(preset?.itemId ?? "");
  const [quantity, setQuantity] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const idem = useIdemKey();
  const item: InventoryItemResponse | undefined = dir.byId(itemId);
  const save = useMutation(inventoryApi.stock.waste, {
    success: "Waste recorded",
    onSuccess: () => {
      idem.done();
      onDone();
    },
    onError: (e) => setErrors(e.fieldErrors),
  });

  const submit = () => {
    const body = {
      branchId,
      itemId,
      quantity: num(quantity),
      batchNo: item?.tracksBatches ? batchNo : "",
      reason,
    };
    const r = validate(recordWasteRequest, { ...body, idempotencyKey: idem.keyFor(body) });
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    void save.run(r.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record waste"
      description="Damaged, expired or lost stock. It leaves the on-hand balance and is kept in the ledger with your reason."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.pending} onClick={submit}>
            Record waste
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
          <ItemSelect
            items={dir.items}
            value={itemId}
            onChange={(v) => {
              setItemId(v);
              setBatchNo("");
            }}
            error={errors.itemId}
            required
          />
          <TextField
            label={`Quantity wasted${item ? ` (${unitLabel(item.unit)})` : ""}`}
            inputMode="decimal"
            required
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            error={errors.quantity}
          />
          {item?.tracksBatches ? (
            <BatchSelect
              branchId={branchId}
              itemId={itemId}
              value={batchNo}
              onChange={setBatchNo}
              error={errors.batchNo}
              autoLabel="Automatic (earliest expiry first)"
            />
          ) : null}
        </div>
        <TextareaField
          label="Reason"
          required
          hint="For example: expired on 1 Nov, or dropped during sterilisation."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />
      </form>
    </Dialog>
  );
}
