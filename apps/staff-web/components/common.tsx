"use client";
import type { Permission } from "@dentalos/contracts";
import type { BranchResponse } from "@dentalos/validation";
import { Alert, Button, ErrorState, Skeleton } from "@dentalos/ui";
import { type ReactNode, useEffect, useState } from "react";
import { MOCK_MODE } from "../lib/api/client";
import { api } from "../lib/api/endpoints";
import { errorStateFor } from "../lib/api/errors";
import type { QueryState } from "../lib/api/hooks";
import { canDo } from "../lib/session";

/** Renders loading skeleton, an announced error with Retry, or the data. */
export function Loadable<T>({
  state,
  children,
  rows = 4,
}: {
  state: QueryState<T>;
  children: (data: T) => ReactNode;
  rows?: number;
}) {
  if (state.error) {
    const e = errorStateFor(state.error);
    return (
      <ErrorState
        title={e.title}
        description={e.description}
        action={
          <Button variant="secondary" onClick={state.reload}>
            Try again
          </Button>
        }
      />
    );
  }
  if (state.data === undefined) {
    return (
      <div className="dos-stack" data-gap="sm" aria-busy="true">
        <span className="dos-sr-only">Loading</span>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Skeleton key={i} height="1.25em" width={`${90 - i * 12}%`} />
        ))}
      </div>
    );
  }
  return <>{children(state.data)}</>;
}

/** Page-level permission gate (display only — the API enforces every call). */
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  if (!canDo(permission)) {
    return (
      <ErrorState
        title="You don't have access to this page"
        description={`Your role does not include "${permission}". Ask an organisation owner if you need it.`}
      />
    );
  }
  return <>{children}</>;
}

/** Shown once per screen in mock mode so nobody mistakes fixtures for live data. */
export function MockNotice() {
  if (!MOCK_MODE) return null;
  return (
    <Alert tone="info">
      Demo data: no API is configured (set NEXT_PUBLIC_API_URL), so this screen uses synthetic
      fixtures. Changes last until the page is reloaded.
    </Alert>
  );
}

// ---- Branch directory (shared, fetched once per page load) -------------------------------------

let branchCache: Promise<BranchResponse[]> | null = null;
export function invalidateBranches() {
  branchCache = null;
}
export function useBranches() {
  const [branches, setBranches] = useState<BranchResponse[]>([]);
  useEffect(() => {
    let live = true;
    branchCache ??= api.branches.list().then(
      (r) => r.items,
      (e) => {
        branchCache = null;
        throw e;
      },
    );
    branchCache.then(
      (b) => live && setBranches(b),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  const name = (id: string | null | undefined) =>
    id ? (branches.find((b) => b.id === id)?.name ?? "Unknown branch") : "—";
  return { branches, name };
}

export function BranchOptions({
  branches,
  ids,
  includeInactive,
}: {
  branches: BranchResponse[];
  /** Restrict to these ids (e.g. the user's scope). */
  ids?: string[];
  includeInactive?: boolean;
}) {
  return (
    <>
      {branches
        .filter((b) => (includeInactive || b.active) && (!ids || ids.includes(b.id)))
        .map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.active ? "" : " (inactive)"}
          </option>
        ))}
    </>
  );
}

/** Section card with a heading; keeps headings in order (h2 under the page h1). */
export function Section({
  title,
  actions,
  children,
  description,
}: {
  title: string;
  actions?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="dos-card dos-stack">
      <div className="dos-cluster" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 className="dos-section-title" style={{ marginBottom: 0 }}>
            {title}
          </h2>
          {description ? <p className="dos-muted" style={{ margin: "4px 0 0" }}>{description}</p> : null}
        </div>
        {actions ? <div className="dos-cluster">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
