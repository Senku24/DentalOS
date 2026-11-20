"use client";
import { SelectField, Timeline } from "@dentalos/ui";
import type { PlanSnapshot, PlanSnapshotItem, PlanVersionResponse } from "@dentalos/validation";
import { useState } from "react";
import type { PlanDetail } from "../../../lib/api/clinical-types";
import { useQuery } from "../../../lib/api/hooks";
import { plansApi } from "../../../lib/api/plans";
import { formatDateTime, formatPaise, humanize } from "../../../lib/format";
import { Loadable } from "../../common";
import { personLabel } from "../bits";
import { toothShort } from "../fdi";
import { TotalsLine } from "./plan-items";

const FIELD_LABEL: Record<string, string> = {
  estimatePricePaise: "Unit estimate",
  priceSource: "Price source",
  decisionReason: "Reason",
  toothCode: "Tooth",
  serviceName: "Service",
  serviceCode: "Service code",
};

function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (field.endsWith("Paise") && typeof v === "number") return formatPaise(v);
  if (field === "status" || field === "priceSource") return humanize(String(v));
  if (Array.isArray(v)) return v.length ? v.join("") : "—";
  return String(v);
}

const itemName = (i: PlanSnapshotItem) =>
  `${i.serviceCode ? `${i.serviceCode} · ` : ""}${i.serviceName ?? "Service"}${
    i.toothCode ? ` · ${toothShort(i.toothCode, i.surfaces)}` : ""
  }`;

/** Version history (append-only snapshots) and a field-level diff between any two versions. */
export function PlanHistory({ plan }: { plan: PlanDetail }) {
  const versions = useQuery(
    () => plansApi.versions(plan.id),
    [plan.id, plan.currentVersion],
    plan.currentVersion > 0,
  );
  if (plan.currentVersion === 0)
    return (
      <p className="dos-muted" style={{ margin: 0 }}>
        No versions yet. The first version is created when the plan is presented.
      </p>
    );
  return (
    <Loadable state={versions}>
      {(v) => (
        <HistoryBody
          versions={[...v.items].sort((a, b) => b.version - a.version)}
          planId={plan.id}
        />
      )}
    </Loadable>
  );
}

function HistoryBody({ versions, planId }: { versions: PlanVersionResponse[]; planId: string }) {
  const latest = versions[0]?.version ?? 1;
  const [to, setTo] = useState(latest);
  const [from, setFrom] = useState(Math.max(1, latest - 1));
  const canDiff = versions.length > 1 && from !== to;
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const diff = useQuery(() => plansApi.diff(planId, a, b), [planId, a, b], canDiff);
  const before = versions.find((v) => v.version === a)?.snapshot;
  const after = versions.find((v) => v.version === b)?.snapshot;

  return (
    <div className="dos-stack" data-gap="lg">
      <Timeline
        label="Plan versions"
        items={versions.map((v) => ({
          id: v.id,
          title: `Version ${v.version} · ${humanize(v.snapshot.plan.status)}`,
          meta: `${formatDateTime(v.createdAt)} · ${personLabel(v.createdBy)}`,
          description: (
            <>
              {v.reason ? <div>{v.reason}</div> : null}
              <TotalsLine totals={v.snapshot.totals} label={`Version ${v.version} totals`} />
            </>
          ),
          current: v.version === latest,
          tone: v.version === latest ? "brand" : "neutral",
        }))}
      />
      {versions.length > 1 ? (
        <section className="dos-stack" aria-labelledby={`diff-${planId}`}>
          <h3 id={`diff-${planId}`} style={{ fontSize: "var(--text-md)", margin: 0 }}>
            Compare versions
          </h3>
          <div className="dos-form-grid">
            <SelectField
              label="From"
              value={from}
              onChange={(e) => setFrom(Number(e.target.value))}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.version}>
                  Version {v.version}
                </option>
              ))}
            </SelectField>
            <SelectField label="To" value={to} onChange={(e) => setTo(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.id} value={v.version}>
                  Version {v.version}
                </option>
              ))}
            </SelectField>
          </div>
          {!canDiff ? (
            <p className="cw-meta">Pick two different versions.</p>
          ) : (
            <Loadable state={diff} rows={3}>
              {(d) =>
                before && after ? (
                  <DiffView
                    before={before}
                    after={after}
                    planFields={d.planFields}
                    added={d.added}
                    removed={d.removed}
                    changed={d.changed}
                    a={a}
                    b={b}
                  />
                ) : null
              }
            </Loadable>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Change({ field, from, to }: { field: string; from: unknown; to: unknown }) {
  return (
    <li>
      {FIELD_LABEL[field] ?? humanize(field)}: <del>{show(field, from)}</del>
      <span aria-hidden="true"> → </span>
      <span className="dos-sr-only"> changed to </span>
      <ins>{show(field, to)}</ins>
    </li>
  );
}

function DiffView({
  before,
  after,
  planFields,
  added,
  removed,
  changed,
  a,
  b,
}: {
  before: PlanSnapshot;
  after: PlanSnapshot;
  planFields: string[];
  added: string[];
  removed: string[];
  changed: { itemId: string; fields: string[] }[];
  a: number;
  b: number;
}) {
  const prev = new Map(before.items.map((i) => [i.id, i]));
  const next = new Map(after.items.map((i) => [i.id, i]));
  const empty = !planFields.length && !added.length && !removed.length && !changed.length;
  if (empty)
    return (
      <p className="cw-meta">
        No differences between version {a} and version {b}.
      </p>
    );
  return (
    <ul className="cw-list" aria-label={`Changes from version ${a} to version ${b}`}>
      {planFields.length ? (
        <li className="cw-item cw-diff" data-kind="changed">
          <strong>Plan details</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {planFields.map((f) => (
              <Change
                key={f}
                field={f}
                from={before.plan[f as keyof PlanSnapshot["plan"]]}
                to={after.plan[f as keyof PlanSnapshot["plan"]]}
              />
            ))}
          </ul>
        </li>
      ) : null}
      {added.map((id) => {
        const i = next.get(id);
        return i ? (
          <li key={id} className="cw-item cw-diff" data-kind="added">
            <strong>Added: {itemName(i)}</strong>
            <span className="cw-meta">
              Phase {i.phase} · {i.quantity} × {formatPaise(i.estimatePricePaise)} ·{" "}
              {humanize(i.status)}
            </span>
          </li>
        ) : null;
      })}
      {removed.map((id) => {
        const i = prev.get(id);
        return i ? (
          <li key={id} className="cw-item cw-diff" data-kind="removed">
            <strong>Removed: {itemName(i)}</strong>
          </li>
        ) : null;
      })}
      {changed.map((c) => {
        const o = prev.get(c.itemId);
        const n = next.get(c.itemId);
        if (!o || !n) return null;
        return (
          <li key={c.itemId} className="cw-item cw-diff" data-kind="changed">
            <strong>Changed: {itemName(n)}</strong>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {c.fields.map((f) => (
                <Change
                  key={f}
                  field={f}
                  from={o[f as keyof PlanSnapshotItem]}
                  to={n[f as keyof PlanSnapshotItem]}
                />
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
