"use client";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  SelectField,
  TextField,
  TextareaField,
  useToast,
} from "@dentalos/ui";
import {
  type AddPlanItemRequest,
  type PlanItemStatus,
  type PlanItemTransitionRequest,
  type UpdatePlanItemRequest,
  addPlanItemRequest,
  planItemTransitionRequest,
  updatePlanItemRequest,
} from "@dentalos/validation";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { useState } from "react";
import type { PlanDetail, PlanItemDetail } from "../../../lib/api/clinical-types";
import { useMutation } from "../../../lib/api/hooks";
import { plansApi } from "../../../lib/api/plans";
import { groupByPhase, lineTotalPaise, nextPhase, totalsOf } from "../../../lib/api/plans-money";
import {
  EDITABLE_ITEM_STATUSES,
  SCHEDULABLE_ITEM_STATUSES,
  canDeleteItems,
  clinicianTargets,
  needsReason,
  planItemPatch,
  reorderToPhase,
} from "../../../lib/api/plans-rules";
import { formatPaise, humanize } from "../../../lib/format";
import { type FieldErrors, validate } from "../../../lib/forms";
import { StatusBadge, ToothSurfaceFields, type useServiceDirectory } from "../bits";
import { toothLong, toothShort } from "../fdi";

type Services = ReturnType<typeof useServiceDirectory>;

/** Totals line: estimate / accepted / completed / pending (₹ from paise, server-frozen). */
export function TotalsLine({
  totals,
  label,
}: {
  totals: {
    estimatePaise: number;
    acceptedPaise: number;
    completedPaise: number;
    pendingPaise: number;
  };
  label: string;
}) {
  return (
    <div className="cw-totals" aria-label={label}>
      <span>
        Estimate <b>{formatPaise(totals.estimatePaise)}</b>
      </span>
      <span>
        Accepted <b>{formatPaise(totals.acceptedPaise)}</b>
      </span>
      <span>
        Completed <b>{formatPaise(totals.completedPaise)}</b>
      </span>
      <span>
        Pending decision <b>{formatPaise(totals.pendingPaise)}</b>
      </span>
    </div>
  );
}

/**
 * Plan builder: items grouped by phase in sequence, per-phase and plan totals, reordering (up/down
 * and phase), add/edit items from the catalogue, clinician status moves and sessions.
 */
export function PlanItemsBuilder({
  plan,
  services,
  canWrite,
  onPlan,
  onSessions,
}: {
  plan: PlanDetail;
  services: Services;
  canWrite: boolean;
  onPlan: (p: PlanDetail) => void;
  onSessions: (item: PlanItemDetail) => void;
}) {
  const groups = groupByPhase(plan);
  const [adding, setAdding] = useState<number | null>(null);
  const [editing, setEditing] = useState<PlanItemDetail | null>(null);
  const [moving, setMoving] = useState<PlanItemDetail | null>(null);
  const ordered = groups.flatMap((g) => g.items);
  const maxPhase = nextPhase(plan.items);

  const reorder = useMutation(
    (items: { itemId: string; phase?: number }[]) => plansApi.reorder(plan.id, { items }),
    { success: "Order updated", onSuccess: onPlan },
  );
  const move = (item: PlanItemDetail, delta: -1 | 1) => {
    const inPhase = ordered.filter((i) => i.phase === item.phase);
    const idx = inPhase.findIndex((i) => i.id === item.id);
    const swap = inPhase[idx + delta];
    if (!swap) return;
    const next = ordered.map((i) => (i.id === item.id ? swap : i.id === swap.id ? item : i));
    void reorder.run(next.map((i) => ({ itemId: i.id, phase: i.phase })));
  };
  const toPhase = (item: PlanItemDetail, phase: number) => {
    if (phase === item.phase) return;
    void reorder.run(reorderToPhase(plan.items, item.id, phase));
  };

  return (
    <div className="dos-stack">
      {canWrite ? (
        <div className="dos-cluster">
          <Button size="sm" onClick={() => setAdding(groups[groups.length - 1]?.phase ?? 1)}>
            <Plus size={16} aria-hidden="true" /> Add item
          </Button>
          {plan.items.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => setAdding(maxPhase)}>
              <Plus size={16} aria-hidden="true" /> Add phase {maxPhase}
            </Button>
          ) : null}
        </div>
      ) : null}
      {groups.length === 0 ? (
        <p className="dos-muted" style={{ margin: 0 }}>
          No items yet.{canWrite ? " Add services from the catalogue to build the plan." : ""}
        </p>
      ) : null}
      {groups.map((g) => (
        <section key={g.phase} className="cw-phase" aria-labelledby={`phase-${plan.id}-${g.phase}`}>
          <div className="cw-row">
            <h3
              id={`phase-${plan.id}-${g.phase}`}
              style={{ fontSize: "var(--text-md)", margin: 0 }}
            >
              Phase {g.phase}
            </h3>
            <TotalsLine totals={g.totals} label={`Phase ${g.phase} totals`} />
          </div>
          <div className="cw-table-wrap">
            <table className="cw-table">
              <caption className="dos-sr-only">Phase {g.phase} items in treatment order</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Service</th>
                  <th scope="col">Tooth</th>
                  <th scope="col" className="cw-money">
                    Qty
                  </th>
                  <th scope="col" className="cw-money">
                    Unit estimate
                  </th>
                  <th scope="col" className="cw-money">
                    Line total
                  </th>
                  <th scope="col">Status</th>
                  {canWrite ? (
                    <th scope="col">
                      <span className="dos-sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {g.items.map((i, k) => {
                  const name = services.label(i.serviceId);
                  const struck = i.status === "REJECTED" || i.status === "CANCELLED";
                  return (
                    <tr key={i.id}>
                      <td>{i.sequence}</td>
                      <td style={{ minWidth: 160 }}>
                        {struck ? <s>{name}</s> : name}
                        {i.notes ? <div className="cw-meta">{i.notes}</div> : null}
                      </td>
                      <td>
                        <span aria-hidden="true">{toothShort(i.toothCode, i.surfaces)}</span>
                        <span className="dos-sr-only">{toothLong(i.toothCode, i.surfaces)}</span>
                      </td>
                      <td className="cw-money">{i.quantity}</td>
                      <td className="cw-money">
                        {formatPaise(i.estimatePricePaise)}
                        {i.priceSource === "OVERRIDE" ? (
                          <div className="cw-meta">branch price</div>
                        ) : null}
                      </td>
                      <td className="cw-money">{formatPaise(lineTotalPaise(i))}</td>
                      <td>
                        <StatusBadge status={i.status} />
                        {i.decisionReason ? (
                          <div className="cw-meta">{i.decisionReason}</div>
                        ) : null}
                      </td>
                      {canWrite ? (
                        <td>
                          <div className="dos-cluster" style={{ flexWrap: "nowrap" }}>
                            <Button
                              size="sm"
                              variant="ghost"
                              iconOnly
                              aria-label={`Move ${name} up`}
                              disabled={k === 0 || reorder.pending}
                              onClick={() => move(i, -1)}
                            >
                              <ArrowUp size={14} aria-hidden="true" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              iconOnly
                              aria-label={`Move ${name} down`}
                              disabled={k === g.items.length - 1 || reorder.pending}
                              onClick={() => move(i, 1)}
                            >
                              <ArrowDown size={14} aria-hidden="true" />
                            </Button>
                            <select
                              className="dos-select"
                              style={{ minWidth: 92, minHeight: "var(--control-height-sm, 32px)" }}
                              aria-label={`Phase for ${name}`}
                              value={i.phase}
                              disabled={reorder.pending}
                              onChange={(e) => toPhase(i, Number(e.target.value))}
                            >
                              {Array.from({ length: maxPhase }, (_, n) => n + 1).map((n) => (
                                <option key={n} value={n}>
                                  Phase {n}
                                </option>
                              ))}
                            </select>
                            {EDITABLE_ITEM_STATUSES.includes(i.status) ? (
                              <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                                Edit<span className="dos-sr-only"> {name}</span>
                              </Button>
                            ) : null}
                            {canDeleteItems(plan) || clinicianTargets(i.status).length ? (
                              <Button size="sm" variant="ghost" onClick={() => setMoving(i)}>
                                {canDeleteItems(plan) ? "Remove" : "Status"}
                                <span className="dos-sr-only"> {name}</span>
                              </Button>
                            ) : null}
                            {SCHEDULABLE_ITEM_STATUSES.includes(i.status) ? (
                              <Button size="sm" variant="ghost" onClick={() => onSessions(i)}>
                                Sessions<span className="dos-sr-only"> for {name}</span>
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5}>Phase {g.phase} estimate</td>
                  <td className="cw-money">{formatPaise(g.totals.estimatePaise)}</td>
                  <td colSpan={canWrite ? 2 : 1} />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      ))}
      {groups.length > 0 ? (
        <div className="cw-item" style={{ background: "var(--color-surface-muted)" }}>
          <strong>Plan total</strong>
          <TotalsLine totals={totalsOf(plan)} label="Plan totals" />
          <span className="cw-meta">
            Estimates are frozen by the server at the branch price when each item is added; rejected
            and cancelled items are excluded.
          </span>
        </div>
      ) : null}

      {adding !== null ? (
        <ItemDialog
          plan={plan}
          services={services}
          phase={adding}
          onClose={() => setAdding(null)}
          onDone={(p) => {
            setAdding(null);
            onPlan(p);
          }}
        />
      ) : null}
      {editing ? (
        <ItemDialog
          plan={plan}
          services={services}
          item={editing}
          phase={editing.phase}
          onRefresh={onPlan}
          onClose={() => setEditing(null)}
          onDone={(p) => {
            setEditing(null);
            onPlan(p);
          }}
        />
      ) : null}
      {moving ? (
        <ItemStatusDialog
          plan={plan}
          item={moving}
          name={services.label(moving.serviceId)}
          onClose={() => setMoving(null)}
          onDone={(p) => {
            setMoving(null);
            onPlan(p);
          }}
        />
      ) : null}
    </div>
  );
}

/** Add (catalogue service) or edit (PROPOSED/DEFERRED) an item. The server freezes the estimate. */
function ItemDialog({
  plan,
  services,
  item,
  phase: initialPhase,
  onRefresh,
  onClose,
  onDone,
}: {
  plan: PlanDetail;
  services: Services;
  item?: PlanItemDetail;
  phase: number;
  /** Plan state after a partial edit (phase moved, field update then failed). */
  onRefresh?: (p: PlanDetail) => void;
  onClose: () => void;
  onDone: (p: PlanDetail) => void;
}) {
  const [serviceId, setServiceId] = useState(item?.serviceId ?? "");
  const [phase, setPhase] = useState(String(initialPhase));
  const [tooth, setTooth] = useState<number | undefined>(item?.toothCode ?? undefined);
  const [surfaces, setSurfaces] = useState<string[]>(item?.surfaces ?? []);
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [reprice, setReprice] = useState(false);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const presented = plan.currentVersion > 0;
  const svc = services.map.get(serviceId);

  const opts = {
    onSuccess: onDone,
    onError: (e: { fieldErrors: FieldErrors; message: string }) =>
      setErrors({ ...e.fieldErrors, _form: e.message }),
  };
  const add = useMutation((b: AddPlanItemRequest) => plansApi.addItem(plan.id, b), {
    ...opts,
    success: "Item added",
  });
  const { toast } = useToast();
  /**
   * Only what changed is sent: every key the API receives commits a new version of a presented
   * plan (outdating its consent). A phase move goes through reorder so sequences are renumbered.
   */
  const update = useMutation(
    async (id: string, patch: UpdatePlanItemRequest | null, toPhase: number | null) => {
      let latest: PlanDetail | undefined;
      try {
        if (toPhase !== null)
          latest = await plansApi.reorder(plan.id, {
            items: reorderToPhase(plan.items, id, toPhase),
            reason: reason.trim() || undefined,
          });
        if (patch) latest = await plansApi.items.update(id, patch);
        return latest as PlanDetail;
      } catch (e) {
        if (latest) onRefresh?.(latest);
        throw e;
      }
    },
    { ...opts, success: "Item updated" },
  );
  const pending = add.pending || update.pending;
  const submit = () => {
    if (item) {
      const r = validate(updatePlanItemRequest, {
        toothCode: tooth ?? null,
        surfaces,
        quantity: Number(quantity),
        notes: notes.trim() || null,
        reprice: reprice || undefined,
        reason,
      });
      if (!r.ok) return setErrors(r.errors);
      const patch = planItemPatch(item, r.data);
      const toPhase = Number(phase) !== item.phase ? Number(phase) : null;
      if (!patch && toPhase === null) {
        toast({ tone: "info", title: "No changes to save" });
        return onClose();
      }
      void update.run(item.id, patch, toPhase);
      return;
    }
    const r = validate(addPlanItemRequest, {
      serviceId,
      phase: Number(phase),
      toothCode: tooth,
      surfaces,
      quantity: Number(quantity),
      notes,
    });
    if (!r.ok) return setErrors(r.errors);
    void add.run(r.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? "Edit plan item" : "Add plan item"}
      description={
        item
          ? "Only proposed or deferred items can be changed."
          : "The estimate is frozen by the server at this branch's current price."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={pending} onClick={submit}>
            {item ? "Save item" : "Add item"}
          </Button>
        </>
      }
    >
      <div className="dos-stack">
        {item ? (
          <p style={{ margin: 0 }}>
            <strong>{services.label(item.serviceId)}</strong> ·{" "}
            {formatPaise(item.estimatePricePaise)} each
          </p>
        ) : (
          <SelectField
            label="Service"
            required
            value={serviceId}
            error={errors.serviceId}
            onChange={(e) => setServiceId(e.target.value)}
          >
            <option value="">{services.loading ? "Loading catalogue…" : "Select a service"}</option>
            {services.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name} — {formatPaise(s.pricePaise)}
              </option>
            ))}
          </SelectField>
        )}
        <div className="dos-form-grid">
          <SelectField
            label="Phase"
            value={phase}
            error={errors.phase}
            onChange={(e) => setPhase(e.target.value)}
          >
            {Array.from(
              { length: Math.max(nextPhase(plan.items), initialPhase) },
              (_, n) => n + 1,
            ).map((n) => (
              <option key={n} value={n}>
                Phase {n}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Quantity"
            type="number"
            min={1}
            max={100}
            inputMode="numeric"
            value={quantity}
            error={errors.quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </div>
        <ToothSurfaceFields
          tooth={tooth}
          surfaces={surfaces}
          error={errors.toothCode}
          surfacesError={errors.surfaces}
          onChange={(t, s) => {
            setTooth(t);
            setSurfaces(s);
          }}
        />
        <TextareaField
          label="Notes"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        {!item && svc?.pricePaise !== undefined ? (
          <p className="cw-meta" style={{ margin: 0 }}>
            Current branch price {formatPaise(svc.pricePaise)} × {Number(quantity) || 1} ={" "}
            {formatPaise(svc.pricePaise * (Number(quantity) || 1))} (shown for reference; the server
            sets the estimate).
          </p>
        ) : null}
        {item ? (
          <Checkbox
            label="Re-price at the current branch price"
            checked={reprice}
            onChange={(e) => setReprice(e.target.checked)}
          />
        ) : null}
        {item && presented ? (
          <TextField
            label="Reason for change"
            hint="Stored on the new plan version"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        ) : null}
        {errors._form ? <Alert tone="danger">{errors._form}</Alert> : null}
      </div>
    </Dialog>
  );
}

/** Clinician moves (POST /plan-items/:id/status) or removal from a never-presented draft. */
function ItemStatusDialog({
  plan,
  item,
  name,
  onClose,
  onDone,
}: {
  plan: PlanDetail;
  item: PlanItemDetail;
  name: string;
  onClose: () => void;
  onDone: (p: PlanDetail) => void;
}) {
  const deletable = canDeleteItems(plan);
  const targets = clinicianTargets(item.status);
  const [to, setTo] = useState<PlanItemStatus | "">(deletable ? "" : (targets[0] ?? ""));
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const opts = {
    onSuccess: onDone,
    onError: (e: { fieldErrors: FieldErrors; message: string }) =>
      setErrors({ ...e.fieldErrors, _form: e.message }),
  };
  const remove = useMutation(() => plansApi.items.remove(item.id), {
    ...opts,
    success: "Item removed",
  });
  const transition = useMutation(
    (b: PlanItemTransitionRequest) => plansApi.items.transition(item.id, b),
    { ...opts, success: "Status updated" },
  );
  const submit = () => {
    if (deletable) return void remove.run();
    const r = validate(planItemTransitionRequest, { to, reason });
    if (!r.ok) return setErrors(r.errors);
    void transition.run(r.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={deletable ? `Remove ${name}?` : `Change status of ${name}`}
      description={
        deletable
          ? "The plan has never been presented, so the item is deleted."
          : "Presented items are never deleted; withdraw them by cancelling (reason required)."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} autoFocus>
            Cancel
          </Button>
          <Button
            variant={deletable || to === "CANCELLED" ? "danger" : "primary"}
            disabled={!deletable && !to}
            loading={remove.pending || transition.pending}
            onClick={submit}
          >
            {deletable ? "Remove item" : "Update status"}
          </Button>
        </>
      }
    >
      {deletable ? null : (
        <div className="dos-stack">
          <p style={{ margin: 0 }}>
            Current status: <StatusBadge status={item.status} />
          </p>
          <SelectField
            label="New status"
            value={to}
            onChange={(e) => setTo(e.target.value as PlanItemStatus)}
          >
            {targets.map((t) => (
              <option key={t} value={t}>
                {t === "PROPOSED" ? "Re-propose (re-prices at today's price)" : humanize(t)}
              </option>
            ))}
          </SelectField>
          {to && needsReason(to) ? (
            <TextareaField
              label="Reason"
              required
              rows={2}
              value={reason}
              error={errors.reason}
              onChange={(e) => setReason(e.target.value)}
            />
          ) : null}
          {errors._form ? <Alert tone="danger">{errors._form}</Alert> : null}
        </div>
      )}
      {deletable && errors._form ? <Alert tone="danger">{errors._form}</Alert> : null}
    </Dialog>
  );
}
