import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

/** Status is always conveyed by text, never by colour alone (WCAG 1.4.1). */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="dos-badge" data-tone={tone}>
      {children}
    </span>
  );
}
