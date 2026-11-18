import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useId,
} from "react";
import { cx } from "./cx";

interface FieldMeta {
  label: string;
  hint?: string;
  /** Validation message. Announced via aria-describedby; the control gets aria-invalid. */
  error?: string;
}

function Shell({
  label,
  hint,
  error,
  required,
  id,
  hintId,
  errorId,
  children,
}: FieldMeta & {
  id: string;
  hintId: string;
  errorId: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="dos-field">
      <label className="dos-label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {hint ? (
        <div className="dos-hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="dos-error" id={errorId}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

const aria = (
  hint: string | undefined,
  error: string | undefined,
  hintId: string,
  errorId: string,
) => ({
  "aria-invalid": error ? true : undefined,
  "aria-describedby":
    [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined,
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...p }, ref) {
    return <input ref={ref} {...p} className={cx("dos-input", className)} />;
  },
);

export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & FieldMeta
>(function TextField({ label, hint, error, className, required, ...p }, ref) {
  const uid = useId();
  const [id, hintId, errorId] = [`${uid}-c`, `${uid}-h`, `${uid}-e`];
  return (
    <Shell {...{ label, hint, error, id, hintId, errorId, required }}>
      <input
        ref={ref}
        id={id}
        required={required}
        {...p}
        {...aria(hint, error, hintId, errorId)}
        className={cx("dos-input", className)}
      />
    </Shell>
  );
});

export const TextareaField = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & FieldMeta
>(function TextareaField({ label, hint, error, className, required, ...p }, ref) {
  const uid = useId();
  const [id, hintId, errorId] = [`${uid}-c`, `${uid}-h`, `${uid}-e`];
  return (
    <Shell {...{ label, hint, error, id, hintId, errorId, required }}>
      <textarea
        ref={ref}
        id={id}
        required={required}
        {...p}
        {...aria(hint, error, hintId, errorId)}
        className={cx("dos-textarea", className)}
      />
    </Shell>
  );
});

/** Native <select>: best built-in keyboard/screen-reader/mobile behaviour. */
export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldMeta
>(function SelectField({ label, hint, error, className, required, children, ...p }, ref) {
  const uid = useId();
  const [id, hintId, errorId] = [`${uid}-c`, `${uid}-h`, `${uid}-e`];
  return (
    <Shell {...{ label, hint, error, id, hintId, errorId, required }}>
      <select
        ref={ref}
        id={id}
        required={required}
        {...p}
        {...aria(hint, error, hintId, errorId)}
        className={cx("dos-select", className)}
      >
        {children}
      </select>
    </Shell>
  );
});
