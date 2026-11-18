import type { ReactNode } from "react";
import { Skeleton } from "./feedback";

export function Card({
  children,
  as: Tag = "div",
}: { children: ReactNode; as?: "div" | "section" }) {
  return <Tag className="dos-card">{children}</Tag>;
}

export function StatCard({
  label,
  value,
  hint,
  loading,
}: { label: string; value: ReactNode; hint?: ReactNode; loading?: boolean }) {
  return (
    <div className="dos-card dos-stat" aria-busy={loading ? true : undefined}>
      <div className="dos-stat__label">{label}</div>
      <div className="dos-stat__value">
        {loading ? <Skeleton width="60%" height="1.2em" /> : value}
      </div>
      {hint ? <div className="dos-stat__hint">{hint}</div> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="dos-grid-stats">{children}</div>;
}
