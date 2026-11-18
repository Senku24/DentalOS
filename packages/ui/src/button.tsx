import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger";

const styles: Record<Variant, React.CSSProperties> = {
  primary: {
    background: "var(--color-primary)",
    color: "var(--color-primary-contrast)",
    border: "1px solid var(--color-primary)",
  },
  secondary: {
    background: "var(--color-surface)",
    color: "var(--color-text)",
    border: "1px solid var(--color-border)",
  },
  danger: {
    background: "var(--color-danger)",
    color: "#fff",
    border: "1px solid var(--color-danger)",
  },
};

export function Button({
  variant = "primary",
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...rest}
      style={{
        padding: "var(--space-2) var(--space-4)",
        borderRadius: "var(--radius-md)",
        font: "inherit",
        cursor: "pointer",
        ...styles[variant],
        ...style,
      }}
    />
  );
}
