import { AlertTriangle, Inbox } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <output style={{ display: "inline-flex" }}>
      <span className="dos-spinner" aria-hidden="true" />
      <span className="dos-sr-only">{label}</span>
    </output>
  );
}

export function Skeleton({
  width = "100%",
  height,
}: { width?: CSSProperties["width"]; height?: CSSProperties["height"] }) {
  return <span className="dos-skeleton" aria-hidden="true" style={{ width, height }} />;
}

interface StateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: StateProps) {
  return (
    <div className="dos-state" data-kind="empty">
      <Inbox className="dos-state__icon" size={32} aria-hidden="true" />
      <div className="dos-state__title">{title}</div>
      {description ? <p className="dos-state__text">{description}</p> : null}
      {action}
    </div>
  );
}

/** role="alert" so a failure that replaces content is announced. */
export function ErrorState({ title, description, action }: StateProps) {
  return (
    <div className="dos-state" data-kind="error" role="alert">
      <AlertTriangle className="dos-state__icon" size={32} aria-hidden="true" />
      <div className="dos-state__title">{title}</div>
      {description ? <p className="dos-state__text">{description}</p> : null}
      {action}
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
}: { tone?: "info" | "success" | "warning" | "danger"; children: ReactNode }) {
  return (
    <div className="dos-alert" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </div>
  );
}
