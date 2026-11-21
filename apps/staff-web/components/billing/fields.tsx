"use client";
import { SelectField, TextField, TextareaField } from "@dentalos/ui";
import type { DiscountSpec } from "@dentalos/validation";
import { rupeesToPaise } from "../../lib/forms";

/** Rupee amount input; the form keeps the raw string and converts with `rupeesToPaise` on submit. */
export function RupeeField({
  label,
  value,
  onChange,
  error,
  hint,
  required,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <TextField
      label={label}
      inputMode="decimal"
      autoComplete="off"
      placeholder="0.00"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      hint={hint ?? "Amount in ₹"}
      required={required}
      disabled={disabled}
    />
  );
}

export interface DiscountDraft {
  kind: "" | "PERCENT" | "AMOUNT";
  value: string;
  reason: string;
}
export const NO_DISCOUNT: DiscountDraft = { kind: "", value: "", reason: "" };

/** Raw discount inputs → shared `DiscountSpec`; null = none; string = what is wrong with the input. */
export function parseDiscount(d: DiscountDraft): DiscountSpec | null | string {
  if (!d.kind) return null;
  const v = d.value.trim();
  if (!v) return "Enter the discount";
  if (d.kind === "PERCENT") {
    if (!/^\d+(\.\d{1,2})?$/.test(v)) return "Enter a percentage like 5 or 7.5";
    const bp = Math.round(Number(v) * 100);
    if (bp < 1 || bp > 10_000) return "A discount is between 0.01% and 100%";
    return { kind: "PERCENT", percentBp: bp };
  }
  const paise = rupeesToPaise(v);
  if (paise === null || paise < 1) return "Enter an amount in ₹";
  return { kind: "AMOUNT", amountPaise: paise };
}

export function DiscountFields({
  draft,
  onChange,
  error,
  reasonError,
  idPrefix,
  disabled,
}: {
  draft: DiscountDraft;
  onChange: (d: DiscountDraft) => void;
  error?: string;
  reasonError?: string;
  idPrefix?: string;
  disabled?: boolean;
}) {
  return (
    <fieldset className="dos-fieldset" id={idPrefix} disabled={disabled}>
      <legend className="dos-label">Discount</legend>
      <div className="bil-line-grid">
        <SelectField
          label="Type"
          value={draft.kind}
          onChange={(e) => onChange({ ...draft, kind: e.target.value as DiscountDraft["kind"] })}
        >
          <option value="">No discount</option>
          <option value="PERCENT">Percentage (%)</option>
          <option value="AMOUNT">Fixed amount (₹)</option>
        </SelectField>
        {draft.kind ? (
          <TextField
            label={draft.kind === "PERCENT" ? "Percent off" : "Amount off (₹)"}
            inputMode="decimal"
            value={draft.value}
            onChange={(e) => onChange({ ...draft, value: e.target.value })}
            error={error}
          />
        ) : null}
      </div>
      {draft.kind ? (
        <TextareaField
          label="Reason for the discount"
          rows={2}
          maxLength={500}
          value={draft.reason}
          onChange={(e) => onChange({ ...draft, reason: e.target.value })}
          error={reasonError}
          hint="Required, and recorded in the audit trail."
        />
      ) : null}
    </fieldset>
  );
}

/** Discount of an existing line / invoice → form draft. Percent lines are stored as paise, so show amount. */
export function draftFromAmount(paise: number, reason: string | null): DiscountDraft {
  if (paise <= 0) return NO_DISCOUNT;
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return {
    kind: "AMOUNT",
    value: p === 0 ? String(r) : `${r}.${String(p).padStart(2, "0")}`,
    reason: reason ?? "",
  };
}
