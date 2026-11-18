import type { ReactNode } from "react";

type Tone = "neutral" | "success" | "warning" | "danger";
const color: Record<Tone, string> = {
  neutral: "var(--color-text-muted)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
};

/** Status is conveyed by text, not colour alone (WCAG 2.2 AA). */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      style={{
        color: color[tone],
        border: `1px solid ${color[tone]}`,
        borderRadius: "var(--radius-sm)",
        padding: "2px var(--space-2)",
        fontSize: 12,
      }}
    >
      {children}
    </span>
  );
}
