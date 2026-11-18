import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Shows a spinner and blocks activation; keeps focus and width. */
  loading?: boolean;
  /** Square icon button. An accessible name (aria-label) is then required. */
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, iconOnly, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cx("dos-btn", className)}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? "true" : undefined}
      disabled={disabled}
      // aria-disabled (not disabled) while loading so keyboard focus is not lost mid-action
      aria-disabled={loading ? true : undefined}
      aria-busy={loading ? true : undefined}
      onClick={loading ? (e) => e.preventDefault() : rest.onClick}
    >
      {loading ? <span className="dos-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
