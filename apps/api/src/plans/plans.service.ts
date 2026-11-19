import { type Prisma, PrismaClient, type TreatmentPlan, type Tx, withTenant } from "@dentalos/db";
import {
  type AddPlanItemRequest,
  type ApprovePlanRequest,
  type CancelPlanRequest,
  type CreatePlanRequest,
  type DecidePlanItemsRequest,
  type ListPlansQuery,
  PLAN_ITEM_DECISIONS,
  type PlanItemInput,
  type PlanItemStatus,
  type PlanItemTransitionRequest,
  type PlanSnapshot,
  type PresentPlanRequest,
  TREATMENT_PLAN_TRANSITIONS,
  type UpdatePlanItemRequest,
  type UpdatePlanRequest,
  allowedPlanItemTransitions,
  areValidSurfaces,
  canTransitionPlan,
  canTransitionPlanItem,
  diffPlanSnapshots,
  isStatusEndpointTransition,
  planItemTransitionPermissions,
  resolveClinicalSettings,
} from "@dentalos/validation";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan, branchWhere } from "../common/principal";
import { findActivePatient, findPatientOr404, lineageIds } from "../patients/patient-common";
import {
  type FrozenPrice,
  assertAny,
  assertNoLiveBooking,
  assertOpen,
  assertPatientActive,
  assertPresented,
  badRequest,
  cancelOpenSessions,
  commitPlanChange,
  decodeCursor,
  encodeCursor,
  findLinkedEncounter,
  findPlan,
  freezePrices,
  invalidTransition,
  loadPlanResponse,
  lockItem,
  lockPlan,
  mapPlanDbError,
  toSummary,
  toVersion,
} from "./plan-common";
import type { ReorderPlanItemsRequest } from "./plans.dto";

/** Items that may still be edited / re-priced (not yet accepted or closed). */
const EDITABLE_ITEM_STATUSES: readonly PlanItemStatus[] = ["PROPOSED", "DEFERRED"];

/**
 * Patient decisions (POST /plans/:id/decisions) only move an item out of a patient-decision state:
 * PROPOSED / DEFERRED -> ACCEPTED / REJECTED / DEFERRED, ACCEPTED -> DEFERRED. SCHEDULED ->
 * ACCEPTED is in the item table only as the booking undo (driven by sessions / the status
 * endpoint) and is never a patient decision.
 */
export const isDecisionTransition = (from: PlanItemStatus, to: PlanItemStatus) =>
  from !== "SCHEDULED" &&
  (PLAN_ITEM_DECISIONS as readonly string[]).includes(to) &&
  canTransitionPlanItem(from, to);

/**
 * Treatment plans and their items (PRD 4.5, ADR 0003 §3). Estimates are frozen server-side from the
 * plan branch's effective catalogue price; every change after presentation appends an immutable
 * version snapshot (`commitPlanChange`). plan:* is branch-scoped to the plan's branch.
 */
@Injectable()
export class PlansService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }).catch(mapPlanDbError);
  }

  private record(p: Principal, action: string, resourceId: string, branchId?: string) {
    return this.audit.record(p, {
      action,
      resource: "treatment_plan",
      resourceId,
      branchId,
      outcome: "success",
    });
  }

  // -------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------

  async create(p: Principal, body: CreatePlanRequest) {
    assertCan(p, "plan:write", { branchId: body.branchId });
    const res = await this.tx(p, async (tx) => {
      await findActivePatient(tx, body.patientId);
      if (!(await tx.branch.findUnique({ where: { id: body.branchId } })))
        throw new NotFoundException({ error: "branch_not_found" });
      if (body.encounterId) {
        // Out of the caller's clinical:read scope -> 404 before the patient check (no oracle).
        const enc = await findLinkedEncounter(tx, p, body.encounterId);
        if (enc.patientId !== body.patientId)
          throw new ConflictException({ error: "link_patient_mismatch", field: "encounterId" });
      }
      const plan = await tx.treatmentPlan.create({
        data: {
          tenantId: p.tenantId,
          patientId: body.patientId,
          branchId: body.branchId,
          encounterId: body.encounterId,
          title: body.title,
          notes: body.notes || null,
          createdBy: p.userId,
        },
      });
      const prices = await freezePrices(
        tx,
        p.tenantId,
        plan.branchId,
        body.items.map((i) => i.serviceId),
      );
      for (const input of body.items) await this.insertItem(tx, p, plan, input, prices);
      return loadPlanResponse(tx, plan.id);
    });
    await this.record(p, "plan.create", res.id, res.branchId);
    return res;
  }

  async list(p: Principal, q: ListPlansQuery) {
    const res = await this.tx(p, async (tx) => {
      const and: Prisma.TreatmentPlanWhereInput[] = [branchWhere(p)];
      if (q.patientId) {
        await findPatientOr404(tx, q.patientId);
        // Plans stay on merged ids: a survivor's list includes its merge lineage.
        and.push({ patientId: { in: await lineageIds(tx, q.patientId) } });
      }
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.status) and.push({ status: q.status });
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        and.push({
          OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
        });
      }
      const rows = await tx.treatmentPlan.findMany({
        where: { AND: and },
        include: { items: { select: { status: true, estimatePricePaise: true, quantity: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const pageRows = rows.slice(0, q.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((r) => toSummary(r, r.items)),
        nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
    // Every list returns plan summaries of patients in scope, filtered or not.
    if (q.patientId) await this.record(p, "plan.list", q.patientId);
    else
      await this.audit.record(p, {
        action: "plan.list",
        resource: "treatment_plan",
        branchId: q.branchId,
        outcome: "success",
      });
    return res;
  }

  async get(p: Principal, id: string) {
    const res = await this.tx(p, async (tx) => {
      await findPlan(tx, p, id);
      return loadPlanResponse(tx, id);
    });
    await this.record(p, "plan.read", id, res.branchId);
    return res;
  }

  async update(p: Principal, id: string, body: UpdatePlanRequest) {
    const res = await this.tx(p, async (tx) => {
      const plan = await this.lockForWrite(tx, p, id, "plan:write");
      assertOpen(plan);
      const data: Prisma.TreatmentPlanUpdateInput = {};
      if (body.title !== undefined && body.title !== plan.title) data.title = body.title;
      if (body.notes !== undefined && (body.notes || null) !== plan.notes)
        data.notes = body.notes || null;
      if (Object.keys(data).length > 0) {
        await tx.treatmentPlan.update({ where: { id }, data });
        await commitPlanChange(tx, p, id, body.reason || "Plan details updated");
      }
      return loadPlanResponse(tx, id);
    });
    await this.record(p, "plan.update", id, res.branchId);
    return res;
  }

  /**
   * DRAFT -> PRESENTED takes version 1; REJECTED -> PRESENTED re-presents a revised plan (needs at
   * least one PROPOSED/DEFERRED item, otherwise the derived status would fall back to REJECTED).
   */
  async present(p: Principal, id: string, body: PresentPlanRequest) {
    const res = await this.tx(p, async (tx) => {
      const plan = await this.lockForWrite(tx, p, id, "plan:write");
      if (!canTransitionPlan(plan.status, "PRESENTED"))
        throw invalidTransition(plan.status, "PRESENTED", TREATMENT_PLAN_TRANSITIONS[plan.status]);
      const items = await tx.planItem.findMany({ where: { planId: id } });
      const live = items.filter((i) => i.status !== "CANCELLED");
      if (live.length === 0) throw new ConflictException({ error: "plan_empty" });
      if (
        plan.status === "REJECTED" &&
        !live.some((i) => i.status === "PROPOSED" || i.status === "DEFERRED")
      )
        throw new ConflictException({ error: "nothing_to_present" });
      await tx.treatmentPlan.update({
        where: { id },
        data: { status: "PRESENTED", presentedAt: new Date(), presentedBy: p.userId },
      });
      await commitPlanChange(tx, p, id, body.reason || "Presented", { present: true });
      return loadPlanResponse(tx, id);
    });
    await this.record(p, "plan.present", id, res.branchId);
    return res;
  }

  async cancel(p: Principal, id: string, body: CancelPlanRequest) {
    const res = await this.tx(p, async (tx) => {
      const plan = await this.lockForWrite(tx, p, id, "plan:write");
      if (!canTransitionPlan(plan.status, "CANCELLED"))
        throw invalidTransition(plan.status, "CANCELLED", TREATMENT_PLAN_TRANSITIONS[plan.status]);
      await tx.treatmentPlan.update({
        where: { id },
        data: { status: "CANCELLED", cancelReason: body.reason },
      });
      // Items are frozen with the plan; their open sessions are withdrawn with it.
      const sessions = await cancelOpenSessions(tx, { planItem: { planId: id } });
      await commitPlanChange(tx, p, id, body.reason);
      return { plan: await loadPlanResponse(tx, id), sessions };
    });
    await this.record(p, "plan.cancel", id, res.plan.branchId);
    await this.recordCancelledSessions(p, res.sessions, res.plan.branchId);
    return res.plan;
  }

  /**
   * Per-item patient decisions (ACCEPTED / REJECTED / DEFERRED) in one version. Each move is checked
   * with `canTransitionPlanItem` and `planItemTransitionPermissions`; the plan status is re-derived.
   */
  async decide(p: Principal, id: string, body: DecidePlanItemsRequest) {
    const res = await this.tx(p, async (tx) => {
      const plan = await this.lockForWrite(tx, p, id, "plan:approve");
      assertOpen(plan);
      assertPresented(plan);
      const items = new Map(
        (await tx.planItem.findMany({ where: { planId: id } })).map((i) => [i.id, i]),
      );
      const now = new Date();
      const counts: Record<string, number> = {};
      for (const d of body.decisions) {
        const item = items.get(d.itemId);
        if (!item) throw new NotFoundException({ error: "plan_item_not_found", itemId: d.itemId });
        if (!isDecisionTransition(item.status, d.decision))
          throw invalidTransition(
            item.status,
            d.decision,
            allowedPlanItemTransitions(item.status).filter((s) =>
              isDecisionTransition(item.status, s),
            ),
            { itemId: item.id },
          );
        assertAny(p, planItemTransitionPermissions(item.status, d.decision), plan.branchId);
        // ACCEPTED -> DEFERRED while still booked would leave a live session / appointment behind.
        if (item.status === "ACCEPTED") await assertNoLiveBooking(tx, item.id);
        await tx.planItem.update({
          where: { id: item.id },
          data: {
            status: d.decision,
            decidedAt: now,
            decidedBy: p.userId,
            decisionReason: d.reason || null,
          },
        });
        counts[d.decision] = (counts[d.decision] ?? 0) + 1;
      }
      const summary = PLAN_ITEM_DECISIONS.filter((k) => counts[k])
        .map((k) => `${counts[k]} ${k.toLowerCase()}`)
        .join(", ");
      await commitPlanChange(tx, p, id, `Patient decisions: ${summary}`);
      return loadPlanResponse(tx, id);
    });
    await this.record(p, "plan.items.decide", id, res.branchId);
    return res;
  }

  /**
   * Records the patient's approval of a decided plan (ACCEPTED / PARTIALLY_ACCEPTED). With the
   * tenant knob `requirePlanConsentForApproval` (default true) a GRANTED TREATMENT_PLAN consent
   * signed against the CURRENT version is required (409 `consent_required`). Approval does not
   * change the snapshot, so it does not take a version (the consent keeps pointing at the current
   * one). A plan changed after approval (new version) can be approved again.
   */
  async approve(p: Principal, id: string, body: ApprovePlanRequest) {
    const res = await this.tx(p, async (tx) => {
      const plan = await this.lockForWrite(tx, p, id, "plan:approve");
      if (plan.status !== "ACCEPTED" && plan.status !== "PARTIALLY_ACCEPTED")
        throw new ConflictException({ error: "plan_not_decided", status: plan.status });
      const current = await tx.treatmentPlanVersion.findFirstOrThrow({
        where: { planId: id, version: plan.currentVersion },
      });
      if (plan.approvedAt && plan.approvedAt >= current.createdAt)
        throw new ConflictException({ error: "already_approved", version: current.version });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId } });
      let consentId: string | null = null;
      if (resolveClinicalSettings(tenant.settings).requirePlanConsentForApproval) {
        const consent = await tx.patientConsent.findFirst({
          where: {
            ...(body.consentId ? { id: body.consentId } : {}),
            patientId: plan.patientId,
            type: "TREATMENT_PLAN",
            status: "GRANTED",
            planVersionId: current.id,
          },
          orderBy: { createdAt: "desc" },
        });
        if (!consent)
          throw new ConflictException({
            error: "consent_required",
            planVersionId: current.id,
            version: current.version,
          });
        consentId = consent.id;
      }
      await tx.treatmentPlan.update({
        where: { id },
        data: { approvedAt: new Date(), approvedBy: p.userId },
      });
      return { plan: await loadPlanResponse(tx, id), consentId };
    });
    await this.record(p, "plan.approve", id, res.plan.branchId);
    if (res.consentId)
      await this.audit.record(p, {
        action: "plan.approve.consent",
        resource: "patient_consent",
        resourceId: res.consentId,
        branchId: res.plan.branchId,
        outcome: "success",
      });
    return res.plan;
  }

  // -------------------------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------------------------

  async addItem(p: Principal, planId: string, body: AddPlanItemRequest) {
    const res = await this.tx(p, async (tx) => {
      const plan = await this.lockForWrite(tx, p, planId, "plan:write");
      assertOpen(plan);
      const prices = await freezePrices(tx, p.tenantId, plan.branchId, [body.serviceId]);
      await this.insertItem(tx, p, plan, body, prices);
      await commitPlanChange(tx, p, planId, "Item added");
      return loadPlanResponse(tx, planId);
    });
    await this.record(p, "plan.item.add", planId, res.branchId);
    return res;
  }

  /** PROPOSED / DEFERRED items only; `reprice` re-freezes the current effective price. */
  async updateItem(p: Principal, itemId: string, body: UpdatePlanItemRequest) {
    const res = await this.tx(p, async (tx) => {
      const { item, plan } = await lockItem(tx, p, itemId);
      assertCan(p, "plan:write", { branchId: plan.branchId });
      await assertPatientActive(tx, plan.patientId);
      assertOpen(plan);
      if (!EDITABLE_ITEM_STATUSES.includes(item.status))
        throw new ConflictException({ error: "item_not_editable", status: item.status });
      const toothCode = body.toothCode !== undefined ? body.toothCode : item.toothCode;
      // A new (or cleared) tooth resets surfaces unless they are sent with it.
      const finalSurfaces = body.surfaces ?? (body.toothCode !== undefined ? [] : item.surfaces);
      if (
        finalSurfaces.length > 0 &&
        (toothCode === null || !areValidSurfaces(toothCode, finalSurfaces))
      )
        throw badRequest("surfaces", "Surfaces are not valid for this tooth");
      const data: Prisma.PlanItemUncheckedUpdateInput = {};
      if (body.phase !== undefined) data.phase = body.phase;
      if (body.sequence !== undefined) data.sequence = body.sequence;
      if (body.toothCode !== undefined || body.surfaces !== undefined) {
        data.toothCode = toothCode;
        data.surfaces = finalSurfaces;
      }
      if (body.quantity !== undefined) data.quantity = body.quantity;
      if (body.notes !== undefined) data.notes = body.notes || null;
      if (body.reprice) Object.assign(data, await this.price(tx, p, plan, item.serviceId));
      if (Object.keys(data).length > 0) {
        await tx.planItem.update({ where: { id: itemId }, data });
        await commitPlanChange(
          tx,
          p,
          plan.id,
          body.reason || (body.reprice ? "Item re-priced" : "Item updated"),
        );
      }
      return loadPlanResponse(tx, plan.id);
    });
    await this.record(p, "plan.item.update", res.id, res.branchId);
    return res;
  }

  /** Only items of a never-presented DRAFT plan (DB trigger `plan_item_history` enforces it too). */
  async removeItem(p: Principal, itemId: string) {
    const res = await this.tx(p, async (tx) => {
      const { plan } = await lockItem(tx, p, itemId);
      assertCan(p, "plan:write", { branchId: plan.branchId });
      if (plan.status !== "DRAFT" || plan.currentVersion > 0)
        throw new ConflictException({ error: "plan_item_history" });
      await tx.planItem.delete({ where: { id: itemId } });
      return loadPlanResponse(tx, plan.id);
    });
    await this.record(p, "plan.item.delete", res.id, res.branchId);
    return res;
  }

  /**
   * Re-sequences the plan: `items` lists EVERY item of the plan exactly once, in the desired order,
   * optionally moving it to another phase. Sequences are renumbered 1..n within each phase.
   */
  async reorder(p: Principal, planId: string, body: ReorderPlanItemsRequest) {
    const res = await this.tx(p, async (tx) => {
      const plan = await this.lockForWrite(tx, p, planId, "plan:write");
      assertOpen(plan);
      const items = await tx.planItem.findMany({ where: { planId } });
      const byId = new Map(items.map((i) => [i.id, i]));
      if (body.items.length !== items.length || body.items.some((x) => !byId.has(x.itemId)))
        throw new ConflictException({
          error: "reorder_mismatch",
          message: "List every item of the plan exactly once",
        });
      const next = new Map<number, number>();
      let changed = false;
      for (const entry of body.items) {
        const cur = byId.get(entry.itemId);
        if (!cur) continue;
        const phase = entry.phase ?? cur.phase;
        const sequence = (next.get(phase) ?? 0) + 1;
        next.set(phase, sequence);
        if (phase !== cur.phase || sequence !== cur.sequence) {
          changed = true;
          await tx.planItem.update({ where: { id: cur.id }, data: { phase, sequence } });
        }
      }
      if (changed) await commitPlanChange(tx, p, planId, body.reason || "Items re-ordered");
      return loadPlanResponse(tx, planId);
    });
    await this.record(p, "plan.items.reorder", planId, res.branchId);
    return res;
  }

  /**
   * POST /plan-items/:id/status — clinician moves (`isStatusEndpointTransition`): re-propose
   * (re-freezes the price), SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED and the SCHEDULED ->
   * ACCEPTED undo (only once nothing is booked: 409 `item_still_scheduled`). COMPLETED is refused
   * while a session is SCHEDULED (409 `item_has_scheduled_sessions`); CANCELLED / COMPLETED cancel
   * the item's open sessions. Patient decisions go through POST /plans/:id/decisions.
   */
  async transitionItem(p: Principal, itemId: string, body: PlanItemTransitionRequest) {
    const res = await this.tx(p, async (tx) => {
      const { item, plan } = await lockItem(tx, p, itemId);
      // Permission first (any one, plan's branch) so a caller without it never learns more.
      assertAny(p, planItemTransitionPermissions(item.status, body.to), plan.branchId);
      await assertPatientActive(tx, plan.patientId);
      assertOpen(plan);
      assertPresented(plan);
      if (!isStatusEndpointTransition(item.status, body.to))
        throw invalidTransition(
          item.status,
          body.to,
          allowedPlanItemTransitions(item.status).filter((s) =>
            isStatusEndpointTransition(item.status, s),
          ),
          { itemId },
        );
      // Booking undo only once nothing is booked any more (the session / appointment would
      // otherwise stay live under an ACCEPTED item).
      if (item.status === "SCHEDULED" && body.to === "ACCEPTED")
        await assertNoLiveBooking(tx, itemId);
      // Completion: a still-SCHEDULED session must be completed or cancelled first; leftover
      // PLANNED sessions are withdrawn with it (a COMPLETED plan could never close them later).
      if (body.to === "COMPLETED") {
        const scheduled = await tx.planItemSession.count({
          where: { planItemId: itemId, status: "SCHEDULED" },
        });
        if (scheduled > 0)
          throw new ConflictException({
            error: "item_has_scheduled_sessions",
            itemId,
            scheduledSessions: scheduled,
          });
      }
      const data: Prisma.PlanItemUncheckedUpdateInput = { status: body.to };
      if (body.to === "PROPOSED") {
        Object.assign(data, await this.price(tx, p, plan, item.serviceId), {
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
        });
      } else if (body.to === "CANCELLED") {
        Object.assign(data, {
          decidedAt: new Date(),
          decidedBy: p.userId,
          decisionReason: body.reason || null,
        });
      }
      await tx.planItem.update({ where: { id: itemId }, data });
      // A withdrawn or completed item keeps no live sessions (linked appointments stay with
      // scheduling). For COMPLETED only PLANNED ones can be left here (SCHEDULED refused above).
      const sessions =
        body.to === "CANCELLED" || body.to === "COMPLETED"
          ? await cancelOpenSessions(tx, { planItemId: itemId })
          : [];
      await commitPlanChange(tx, p, plan.id, body.reason || `Item ${body.to.toLowerCase()}`);
      return { plan: await loadPlanResponse(tx, plan.id), sessions };
    });
    await this.record(p, "plan.item.status", res.plan.id, res.plan.branchId);
    await this.recordCancelledSessions(p, res.sessions, res.plan.branchId);
    return res.plan;
  }

  // -------------------------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------------------------

  async versions(p: Principal, planId: string) {
    const res = await this.tx(p, async (tx) => {
      const plan = await findPlan(tx, p, planId);
      const rows = await tx.treatmentPlanVersion.findMany({
        where: { planId },
        orderBy: { version: "asc" },
      });
      return { plan, items: rows.map(toVersion) };
    });
    await this.record(p, "plan.versions.read", planId, res.plan.branchId);
    return { items: res.items };
  }

  async version(p: Principal, planId: string, version: number) {
    const res = await this.tx(p, async (tx) => {
      const plan = await findPlan(tx, p, planId);
      return { plan, v: await this.findVersion(tx, planId, version) };
    });
    await this.record(p, "plan.versions.read", planId, res.plan.branchId);
    return toVersion(res.v);
  }

  /** Field-level diff from version `a` to version `b` (added / removed / changed items). */
  async diff(p: Principal, planId: string, a: number, b: number) {
    const res = await this.tx(p, async (tx) => {
      const plan = await findPlan(tx, p, planId);
      const from = await this.findVersion(tx, planId, a);
      const to = await this.findVersion(tx, planId, b);
      return { plan, from, to };
    });
    await this.record(p, "plan.versions.read", planId, res.plan.branchId);
    return {
      fromVersion: a,
      toVersion: b,
      ...diffPlanSnapshots(
        res.from.snapshot as unknown as PlanSnapshot,
        res.to.snapshot as unknown as PlanSnapshot,
      ),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /** Ids-only audit of sessions cancelled by an item cancellation / completion or plan cancel. */
  private async recordCancelledSessions(
    p: Principal,
    sessions: { id: string }[],
    branchId: string,
  ) {
    for (const s of sessions)
      await this.audit.record(p, {
        action: "plan_item_session.cancel",
        resource: "plan_item_session",
        resourceId: s.id,
        branchId,
        outcome: "success",
      });
  }

  private async findVersion(tx: Tx, planId: string, version: number) {
    const v = await tx.treatmentPlanVersion.findFirst({ where: { planId, version } });
    if (!v) throw new NotFoundException({ error: "plan_version_not_found", version });
    return v;
  }

  /** Lock + scope + permission on the plan's branch + patient not merged. */
  private async lockForWrite(
    tx: Tx,
    p: Principal,
    planId: string,
    perm: "plan:write" | "plan:approve",
  ): Promise<TreatmentPlan> {
    const plan = await lockPlan(tx, p, planId);
    assertCan(p, perm, { branchId: plan.branchId });
    await assertPatientActive(tx, plan.patientId);
    return plan;
  }

  private async price(tx: Tx, p: Principal, plan: TreatmentPlan, serviceId: string) {
    const frozen = (await freezePrices(tx, p.tenantId, plan.branchId, [serviceId])).get(serviceId);
    if (!frozen) throw new NotFoundException({ error: "service_not_found", serviceId });
    return frozen;
  }

  /**
   * Inserts a PROPOSED item with its frozen estimate. Without `sequence` it goes last in its phase;
   * with one, later items of that phase shift down by one.
   */
  private async insertItem(
    tx: Tx,
    p: Principal,
    plan: TreatmentPlan,
    input: PlanItemInput,
    prices: Map<string, FrozenPrice>,
  ) {
    const price = prices.get(input.serviceId);
    if (!price) throw new NotFoundException({ error: "service_not_found" });
    let sequence = input.sequence;
    if (sequence === undefined) {
      const last = await tx.planItem.aggregate({
        where: { planId: plan.id, phase: input.phase },
        _max: { sequence: true },
      });
      sequence = (last._max.sequence ?? 0) + 1;
    } else {
      await tx.planItem.updateMany({
        where: { planId: plan.id, phase: input.phase, sequence: { gte: sequence } },
        data: { sequence: { increment: 1 } },
      });
    }
    return tx.planItem.create({
      data: {
        tenantId: p.tenantId,
        planId: plan.id,
        patientId: plan.patientId,
        phase: input.phase,
        sequence,
        serviceId: input.serviceId,
        toothCode: input.toothCode ?? null,
        surfaces: input.toothCode === undefined ? [] : input.surfaces,
        quantity: input.quantity,
        notes: input.notes || null,
        estimatePricePaise: price.estimatePricePaise,
        priceSource: price.priceSource,
        pricedAt: price.pricedAt,
        createdBy: p.userId,
      },
    });
  }
}
