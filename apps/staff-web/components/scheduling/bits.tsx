"use client";
import { Badge, Button, EmptyState, ErrorState } from "@dentalos/ui";
import type { AppointmentResponse, AppointmentStatus } from "@dentalos/validation";
import type { ReactNode } from "react";
import { errorStateFor } from "../../lib/api/errors";
import type { LiveStatus } from "../../lib/api/scheduling-live";
import { STATUS_LABELS, STATUS_TONES } from "../../lib/api/scheduling-rules";
import { humanize, patientName } from "../../lib/format";

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function SourceBadge({ source }: { source: AppointmentResponse["source"] }) {
  if (source === "SCHEDULED") return null;
  return <Badge tone={source === "URGENT" ? "danger" : "info"}>{humanize(source)}</Badge>;
}

export const apptPatientName = (a: Pick<AppointmentResponse, "patient" | "patientId">) =>
  a.patient ? patientName(a.patient) : "Patient";

export function LiveIndicator({ status }: { status: LiveStatus }) {
  const text =
    status === "live"
      ? "Live"
      : status === "polling"
        ? "Reconnecting (refreshing every 20 s)"
        : "Connecting…";
  return (
    <output className="sch-live" data-status={status} aria-live="polite">
      {text}
    </output>
  );
}

const LEGEND: AppointmentStatus[] = [
  "BOOKED",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_CHAIR",
  "COMPLETED",
  "CANCELLED",
];

export function StatusLegend() {
  return (
    <ul className="sch-legend" aria-label="Status colours">
      {LEGEND.map((s) => (
        <li key={s} data-status={s}>
          <span className="sch-legend__swatch" aria-hidden="true" />
          {STATUS_LABELS[s]}
          {s === "CANCELLED" ? " / no-show" : ""}
        </li>
      ))}
      <li>
        <span
          className="sch-legend__swatch"
          aria-hidden="true"
          style={{ background: "var(--color-surface-muted)", borderInlineStartWidth: 0 }}
        />
        Hatched = closed
      </li>
    </ul>
  );
}

/** Segmented control (aria-pressed toggle buttons) for view switching. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="sch-seg" aria-label={label} style={{ margin: 0, padding: 0 }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/**
 * Body of a scheduling screen until it has a branch: ErrorState + retry when GET /branches failed,
 * EmptyState when the user has no active branch in scope, else the screen. (Without this every
 * branch-scoped query stays disabled and the screen shows skeletons forever.)
 */
export function BranchGate({
  sb,
  children,
}: {
  sb: {
    branchesLoaded: boolean;
    branchesError: unknown;
    scoped: readonly string[];
    reloadBranches: () => void;
  };
  children: ReactNode;
}) {
  if (sb.branchesError)
    return (
      <ErrorState
        {...errorStateFor(sb.branchesError)}
        action={
          <Button variant="secondary" onClick={sb.reloadBranches}>
            Try again
          </Button>
        }
      />
    );
  if (sb.branchesLoaded && sb.scoped.length === 0)
    return (
      <EmptyState
        title="No branch to show"
        description="Your account isn't assigned to an active branch. Ask an organisation owner."
      />
    );
  return <>{children}</>;
}
