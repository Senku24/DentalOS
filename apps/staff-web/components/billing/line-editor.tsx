"use client";
import { Button, SelectField, Spinner, TextField, TextareaField } from "@dentalos/ui";
import type { DiscountSpec, InvoiceLineInput } from "@dentalos/validation";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { type PreviewLine, discountProblem, lineDiscountPaise } from "../../lib/api/billing-rules";
import { api } from "../../lib/api/endpoints";
import { errorStateFor } from "../../lib/api/errors";
import { useQuery } from "../../lib/api/hooks";
import type { PriceListItem } from "../../lib/api/types";
import { formatPaise } from "../../lib/format";
import { rupeesToPaise } from "../../lib/forms";
import { canDo, sessionPrincipal } from "../../lib/session";
import {
  type DiscountDraft,
  DiscountFields,
  NO_DISCOUNT,
  RupeeField,
  parseDiscount,
} from "./fields";

/** A line as typed on screen. Catalogue lines are priced by the server; only ad hoc lines carry a price. */
export interface LineDraft {
  key: string;
  serviceId?: string;
  description: string;
  quantity: string;
  /** Ad hoc lines only. */
  unitRupees: string;
  /** Catalogue lines: the branch's effective price from the price list (display / preview). */
  servicePricePaise?: number;
  taxable: boolean;
  discount: DiscountDraft;
}

let keySeq = 0;
export const newLineKey = () => `ln-${++keySeq}`;

export const serviceLine = (s: PriceListItem): LineDraft => ({
  key: newLineKey(),
  serviceId: s.id,
  description: s.name,
  quantity: "1",
  unitRupees: "",
  servicePricePaise: s.pricePaise,
  taxable: s.taxable,
  discount: NO_DISCOUNT,
});
export const adHocLine = (): LineDraft => ({
  key: newLineKey(),
  description: "",
  quantity: "1",
  unitRupees: "",
  taxable: false,
  discount: NO_DISCOUNT,
});

const qtyOf = (l: LineDraft) => {
  const n = Number(l.quantity);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : null;
};
export const unitPaiseOf = (l: LineDraft): number | null =>
  l.serviceId ? (l.servicePricePaise ?? null) : rupeesToPaise(l.unitRupees);

export interface LineIssues {
  description?: string;
  quantity?: string;
  unit?: string;
  discount?: string;
  discountReason?: string;
}

/** Everything wrong with one line, using the same discount rules as the API. */
export function lineIssues(
  l: LineDraft,
  ctx: { branchId: string; settings: Parameters<typeof discountProblem>[0]["settings"] },
): LineIssues {
  const out: LineIssues = {};
  if (!l.serviceId && !l.description.trim()) out.description = "Describe the item";
  if (!l.serviceId && l.description.length > 300) out.description = "At most 300 characters";
  const q = qtyOf(l);
  if (q === null) out.quantity = "Whole number from 1 to 10,000";
  const unit = unitPaiseOf(l);
  if (unit === null) out.unit = "Enter the price in ₹";
  const spec = parseDiscount(l.discount);
  if (typeof spec === "string") out.discount = spec;
  else if (spec && q !== null && unit !== null) {
    const problem = discountProblem({
      discount: spec,
      basePaise: q * unit,
      reason: l.discount.reason,
      canApply: canDo("discount:apply", { branchId: ctx.branchId }),
      roles: sessionPrincipal().roles,
      settings: ctx.settings,
    });
    if (problem) {
      if (/reason/i.test(problem)) out.discountReason = problem;
      else out.discount = problem;
    }
  }
  return out;
}

export const hasIssues = (i: LineIssues) => Object.keys(i).length > 0;

/** Line → request body (caller has already checked `lineIssues`). */
export function lineToInput(l: LineDraft): InvoiceLineInput {
  const spec = parseDiscount(l.discount) as DiscountSpec | null;
  return {
    ...(l.serviceId ? { serviceId: l.serviceId } : { description: l.description.trim() }),
    quantity: qtyOf(l) as number,
    ...(l.serviceId ? {} : { unitPricePaise: unitPaiseOf(l) as number }),
    ...(spec ? { discount: spec, discountReason: l.discount.reason.trim() } : {}),
  };
}

/** Line → GST preview input; ad hoc lines are not taxable (the API's `lineTaxRateBp(null)` = 0). */
export function lineToPreview(l: LineDraft, defaultGstRateBp: number): PreviewLine | null {
  const q = qtyOf(l);
  const unit = unitPaiseOf(l);
  if (q === null || unit === null) return null;
  const spec = parseDiscount(l.discount);
  const d = lineDiscountPaise(typeof spec === "string" ? null : spec, q, unit);
  if ("error" in d) return null;
  return {
    quantity: q,
    unitPricePaise: unit,
    discountPaise: d.paise,
    taxRateBp: l.serviceId && l.taxable ? defaultGstRateBp : 0,
  };
}

/** Catalogue search + add. Prices are the branch's effective prices (GET /catalog/price-list). */
export function ServicePicker({
  branchId,
  onPick,
  onAddCustom,
}: {
  branchId: string;
  onPick: (s: PriceListItem) => void;
  onAddCustom?: () => void;
}) {
  const list = useQuery(() => api.catalog.priceList(branchId), [branchId], Boolean(branchId));
  const [term, setTerm] = useState("");
  const [sel, setSel] = useState("");
  const items = useMemo(() => {
    const t = term.trim().toLowerCase();
    return (list.data?.items ?? [])
      .filter((s) => !t || s.name.toLowerCase().includes(t) || s.code.toLowerCase().includes(t))
      .slice(0, 60);
  }, [list.data, term]);
  const chosen = items.find((s) => s.id === sel);

  if (!branchId) return <p className="dos-muted">Choose a branch to pick services.</p>;
  if (list.error) {
    const e = errorStateFor(list.error);
    return (
      <div className="dos-error" role="alert">
        {e.description}{" "}
        <Button size="sm" variant="secondary" onClick={list.reload}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="bil-line-grid" style={{ alignItems: "end" }}>
      <TextField
        label="Find a service"
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        hint={list.data ? `${list.data.items.length} services at this branch` : "Loading services…"}
      />
      <SelectField
        label="Service"
        value={chosen ? sel : ""}
        onChange={(e) => setSel(e.target.value)}
        disabled={!list.data}
      >
        <option value="">{items.length ? "Select a service" : "No matches"}</option>
        {items.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} — {formatPaise(s.pricePaise)}
          </option>
        ))}
      </SelectField>
      <div className="bil-actions">
        <Button
          variant="secondary"
          disabled={!chosen}
          onClick={() => {
            if (!chosen) return;
            onPick(chosen);
            setSel("");
          }}
        >
          <Plus size={16} aria-hidden="true" /> Add service
        </Button>
        {onAddCustom ? (
          <Button variant="ghost" onClick={onAddCustom}>
            Add custom item
          </Button>
        ) : null}
        {!list.data ? <Spinner label="Loading services" /> : null}
      </div>
    </div>
  );
}

/** One editable line (quantity, price for ad hoc, discount). */
export function LineCard({
  line,
  index,
  issues,
  onChange,
  onRemove,
  showDiscount = true,
}: {
  line: LineDraft;
  index: number;
  issues: LineIssues;
  onChange: (l: LineDraft) => void;
  onRemove?: () => void;
  showDiscount?: boolean;
}) {
  const unit = unitPaiseOf(line);
  const qty = qtyOf(line);
  return (
    <fieldset className="bil-line-card" aria-label={`Line ${index + 1}`}>
      <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
        <strong>
          {index + 1}. {line.serviceId ? line.description : "Custom item"}
        </strong>
        {onRemove ? (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <Trash2 size={16} aria-hidden="true" /> Remove
            <span className="dos-sr-only"> line {index + 1}</span>
          </Button>
        ) : null}
      </div>
      {line.serviceId ? null : (
        <TextareaField
          label="Description"
          rows={2}
          maxLength={300}
          required
          value={line.description}
          onChange={(e) => onChange({ ...line, description: e.target.value })}
          error={issues.description}
        />
      )}
      <div className="bil-line-grid">
        <TextField
          label="Quantity"
          inputMode="numeric"
          required
          value={line.quantity}
          onChange={(e) => onChange({ ...line, quantity: e.target.value })}
          error={issues.quantity}
        />
        {line.serviceId ? (
          <div className="dos-field">
            <span className="dos-label">Price (set by the catalogue)</span>
            <span>{formatPaise(line.servicePricePaise)}</span>
          </div>
        ) : (
          <RupeeField
            label="Price each"
            required
            value={line.unitRupees}
            onChange={(v) => onChange({ ...line, unitRupees: v })}
            error={issues.unit}
          />
        )}
        <div className="dos-field">
          <span className="dos-label">Line amount</span>
          <span>{qty !== null && unit !== null ? formatPaise(qty * unit) : "—"}</span>
        </div>
      </div>
      {showDiscount ? (
        <DiscountFields
          draft={line.discount}
          onChange={(discount) => onChange({ ...line, discount })}
          error={issues.discount}
          reasonError={issues.discountReason}
          disabled={!canDo("discount:apply")}
        />
      ) : null}
      {showDiscount && !canDo("discount:apply") ? (
        <p className="dos-hint">Your role can't give discounts.</p>
      ) : null}
    </fieldset>
  );
}
