import { type InputHTMLAttributes, type ReactNode, forwardRef, useId } from "react";

/** Single checkbox with a visible label. `switch` renders role="switch" for on/off settings. */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
    label: ReactNode;
    hint?: string;
    switch?: boolean;
  }
>(function Checkbox({ label, hint, switch: isSwitch, id, className, ...p }, ref) {
  const uid = useId();
  const cid = id ?? `${uid}-c`;
  const hintId = `${uid}-h`;
  return (
    <div className="dos-check">
      <input
        ref={ref}
        id={cid}
        type="checkbox"
        role={isSwitch ? "switch" : undefined}
        aria-describedby={hint ? hintId : undefined}
        className={["dos-check__input", className].filter(Boolean).join(" ")}
        {...p}
      />
      <div>
        <label htmlFor={cid} className="dos-check__label">
          {label}
        </label>
        {hint ? (
          <div className="dos-hint" id={hintId}>
            {hint}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export interface ChoiceOption {
  value: string;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
}

/** Multi-select as a fieldset of checkboxes: the most robust accessible multi-select. */
export function CheckboxGroup({
  legend,
  options,
  value,
  onChange,
  error,
  hint,
  required,
  columns,
}: {
  legend: string;
  options: ChoiceOption[];
  value: string[];
  onChange: (next: string[]) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  /** Lay options out in N columns on wide screens. */
  columns?: 1 | 2 | 3;
}) {
  const uid = useId();
  const describedBy = [hint ? `${uid}-h` : "", error ? `${uid}-e` : ""].filter(Boolean).join(" ");
  return (
    <fieldset
      className="dos-fieldset"
      aria-describedby={describedBy || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="dos-label">
        {legend}
        {required ? <span aria-hidden="true"> *</span> : null}
      </legend>
      {hint ? (
        <div className="dos-hint" id={`${uid}-h`}>
          {hint}
        </div>
      ) : null}
      <div className="dos-choice-grid" data-columns={columns ?? 1}>
        {options.map((o) => (
          <Checkbox
            key={o.value}
            label={o.label}
            hint={o.hint}
            disabled={o.disabled}
            checked={value.includes(o.value)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))
            }
          />
        ))}
      </div>
      {error ? (
        <div className="dos-error" id={`${uid}-e`}>
          {error}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Single choice as a radio group (e.g. merge field picks). */
export function RadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  error,
  hideLegend,
}: {
  legend: string;
  name: string;
  options: ChoiceOption[];
  value: string | undefined;
  onChange: (v: string) => void;
  error?: string;
  /** Keep the legend for screen readers only (e.g. inside a table row with its own heading). */
  hideLegend?: boolean;
}) {
  const uid = useId();
  return (
    <fieldset
      className="dos-fieldset"
      aria-describedby={error ? `${uid}-e` : undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className={hideLegend ? "dos-sr-only" : "dos-label"}>{legend}</legend>
      <div className="dos-choice-grid" data-columns={1}>
        {options.map((o, i) => {
          const id = `${uid}-${i}`;
          return (
            <div className="dos-check" key={o.value}>
              <input
                id={id}
                type="radio"
                name={name}
                className="dos-check__input"
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
              />
              <label htmlFor={id} className="dos-check__label">
                {o.label}
              </label>
            </div>
          );
        })}
      </div>
      {error ? (
        <div className="dos-error" id={`${uid}-e`}>
          {error}
        </div>
      ) : null}
    </fieldset>
  );
}
