import {
  type PlanItem,
  type PlanItemSession,
  PrismaClient,
  type TreatmentPlan,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  type CreatePlanItemSessionRequest,
  type PlanItemStatus,
  type UpdatePlanItemSessionRequest,
  canTransitionPlanItem,
  planItemTransitionPermissions,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { isUniqueViolation } from "../common/db-errors";
import { assertCan } from "../common/principal";
import {
  assertAny,
  assertOpen,
  assertPatientActive,
  commitPlanChange,
  findItem,
  findLinkedAppointment,
  findLinkedEncounter,
  invalidTransition,
  isPlanClosed,
  lockItem,
  lockPlan,
  mapPlanDbError,
  toSession,
  unbindAppointment,
} from "./plan-common";
import {
  type SessionStatus,
  allowedSessionTransitions,
  canTransitionSession,
  deriveSessionStatus,
  isClosedSession,
} from "./session-status";

/** Items whose sessions can be planned (accepted by the patient, not finished). */
const SCHEDULABLE_ITEM_STATUSES: readonly PlanItemStatus[] = [
  "ACCEPTED",
  "SCHEDULED",
  "IN_PROGRESS",
];

const itemNotSchedulable = (status: PlanItemStatus) =>
  new ConflictException({ error: "item_not_schedulable", status });

/** The appointment is already bound to another plan item (`Appointment.planItemId`). */
const linkedElsewhere = () =>
  new ConflictException({ error: "appointment_linked_elsewhere", field: "appointmentId" });

const serverDerived = () =>
  new BadRequestException({
    error: "session_status_server_derived",
    message:
      "Session status is derived by the server (SCHEDULED from a linked appointment, COMPLETED from a linked encounter/procedure or POST /plan-item-sessions/:id/complete); clients may only cancel",
  });

/**
 * Multi-visit sessions of a plan item (ADR 0003 §3.1; status table in ./session-status.ts).
 * Sessions are cancelled, never deleted (DB grants). Linked appointment / encounter must be the
 * same patient's (composite FKs) — validated by id/FK only, no scheduling/clinical imports.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }).catch(mapPlanDbError);
  }

  private record(p: Principal, action: string, id: string, branchId: string) {
    return this.audit.record(p, {
      action,
      resource: "plan_item_session",
      resourceId: id,
      branchId,
      outcome: "success",
    });
  }

  async list(p: Principal, itemId: string) {
    const res = await this.tx(p, async (tx) => {
      const { plan } = await findItem(tx, p, itemId);
      const rows = await tx.planItemSession.findMany({
        where: { planItemId: itemId },
        orderBy: { sessionNo: "asc" },
      });
      return { rows, branchId: plan.branchId };
    });
    await this.audit.record(p, {
      action: "plan_item_session.list",
      resource: "plan_item",
      resourceId: itemId,
      branchId: res.branchId,
      outcome: "success",
    });
    return { items: res.rows.map(toSession) };
  }

  async create(p: Principal, itemId: string, body: CreatePlanItemSessionRequest) {
    if (body.status !== "PLANNED") throw serverDerived();
    const res = await this.tx(p, async (tx) => {
      const { item, plan } = await lockItem(tx, p, itemId);
      assertCan(p, "plan:write", { branchId: plan.branchId });
      await assertPatientActive(tx, plan.patientId);
      assertOpen(plan);
      if (!SCHEDULABLE_ITEM_STATUSES.includes(item.status)) throw itemNotSchedulable(item.status);
      await this.checkLinks(tx, p, item, body.appointmentId, body.encounterId);
      let sessionNo = body.sessionNo;
      if (sessionNo === undefined) {
        const last = await tx.planItemSession.aggregate({
          where: { planItemId: itemId },
          _max: { sessionNo: true },
        });
        sessionNo = (last._max.sessionNo ?? 0) + 1;
      } else if (await tx.planItemSession.findFirst({ where: { planItemId: itemId, sessionNo } })) {
        throw new ConflictException({ error: "session_no_taken", sessionNo });
      }
      const status = await this.derive(tx, item, "PLANNED", body.appointmentId, body.encounterId);
      let s: PlanItemSession;
      try {
        s = await tx.planItemSession.create({
          data: {
            tenantId: p.tenantId,
            planItemId: itemId,
            patientId: item.patientId,
            sessionNo,
            appointmentId: body.appointmentId ?? null,
            encounterId: body.encounterId ?? null,
            status,
            notes: body.notes || null,
            createdBy: p.userId,
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException({ error: "session_no_taken" });
        throw e;
      }
      await this.linkAppointment(tx, item, body.appointmentId);
      await this.syncItem(tx, p, plan, item.id, "PLANNED", status, s.sessionNo);
      return { s, branchId: plan.branchId };
    });
    await this.record(p, "plan_item_session.create", res.s.id, res.branchId);
    return toSession(res.s);
  }

  /**
   * Links/unlinks appointment and encounter, edits notes, or cancels (`status: "CANCELLED"`, the
   * only status a client may send). The status is re-derived from the links — but only while the
   * plan is open and the item still schedulable: on a COMPLETED / CANCELLED plan or a closed item
   * a PATCH is notes (or cancel, open plans only) and never moves the session, item or version.
   */
  async update(p: Principal, sessionId: string, body: UpdatePlanItemSessionRequest) {
    if (body.status !== undefined && body.status !== "CANCELLED") throw serverDerived();
    const res = await this.tx(p, async (tx) => {
      const { session, item, plan } = await this.lockSession(tx, p, sessionId);
      const cur = session.status as SessionStatus;
      const changesLinks = body.appointmentId !== undefined || body.encounterId !== undefined;
      const touchesLinks = changesLinks || body.status !== undefined;
      if (isClosedSession(cur) && touchesLinks)
        throw new ConflictException({ error: "session_closed", status: cur });
      if (touchesLinks) assertOpen(plan);
      const itemOpen = SCHEDULABLE_ITEM_STATUSES.includes(item.status);
      if (changesLinks && !itemOpen) throw itemNotSchedulable(item.status);
      const appointmentId =
        body.appointmentId !== undefined ? body.appointmentId : session.appointmentId;
      const encounterId = body.encounterId !== undefined ? body.encounterId : session.encounterId;
      await this.checkLinks(
        tx,
        p,
        item,
        body.appointmentId ?? undefined,
        body.encounterId ?? undefined,
      );
      // Frozen plan / closed item: never re-derive (a later appointment or encounter change made
      // elsewhere must not resurrect state there).
      const rederive = !isPlanClosed(plan) && itemOpen;
      const next: SessionStatus =
        body.status === "CANCELLED"
          ? "CANCELLED"
          : rederive
            ? await this.derive(tx, item, cur, appointmentId, encounterId)
            : cur;
      if (next !== cur && !canTransitionSession(cur, next))
        throw invalidTransition(cur, next, allowedSessionTransitions(cur), { sessionId });
      const s = await tx.planItemSession.update({
        where: { id: sessionId },
        data: {
          appointmentId,
          encounterId,
          status: next,
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
        },
      });
      if (body.appointmentId) await this.linkAppointment(tx, item, body.appointmentId);
      // The session let go of its previous appointment (unlinked, replaced or cancelled): free it.
      if (session.appointmentId !== appointmentId || next === "CANCELLED")
        await unbindAppointment(tx, item.id, session.appointmentId);
      await this.syncItem(tx, p, plan, item.id, cur, next, s.sessionNo);
      return { s, branchId: plan.branchId };
    });
    await this.record(p, "plan_item_session.update", sessionId, res.branchId);
    return toSession(res.s);
  }

  /** Explicit completion (treatment done without a signed encounter / procedure record yet). */
  async complete(p: Principal, sessionId: string) {
    const res = await this.tx(p, async (tx) => {
      const { session, item, plan } = await this.lockSession(tx, p, sessionId);
      assertOpen(plan);
      const cur = session.status as SessionStatus;
      if (!canTransitionSession(cur, "COMPLETED"))
        throw invalidTransition(cur, "COMPLETED", allowedSessionTransitions(cur), { sessionId });
      if (!SCHEDULABLE_ITEM_STATUSES.includes(item.status)) throw itemNotSchedulable(item.status);
      const s = await tx.planItemSession.update({
        where: { id: sessionId },
        data: { status: "COMPLETED" },
      });
      await this.syncItem(tx, p, plan, item.id, cur, "COMPLETED", s.sessionNo);
      return { s, branchId: plan.branchId };
    });
    await this.record(p, "plan_item_session.complete", sessionId, res.branchId);
    return toSession(res.s);
  }

  // -------------------------------------------------------------------------------------------

  private async lockSession(tx: Tx, p: Principal, sessionId: string) {
    const found = await tx.planItemSession.findUnique({ where: { id: sessionId } });
    if (!found) throw new NotFoundException({ error: "session_not_found" });
    let ctx: { item: PlanItem; plan: TreatmentPlan };
    try {
      ctx = await lockItem(tx, p, found.planItemId);
    } catch (e) {
      if (e instanceof NotFoundException)
        throw new NotFoundException({ error: "session_not_found" });
      throw e;
    }
    assertCan(p, "plan:write", { branchId: ctx.plan.branchId });
    await assertPatientActive(tx, ctx.plan.patientId);
    const session = await tx.planItemSession.findUniqueOrThrow({ where: { id: sessionId } });
    return { session, ...ctx };
  }

  /**
   * Linked rows: visible to the caller on THEIR branch (404 otherwise, see findLinked*), then same
   * patient (also enforced by the composite FKs). Linking an appointment writes
   * `Appointment.planItemId`, so it also needs plan:write or appointment:write on the
   * appointment's branch.
   */
  private async checkLinks(
    tx: Tx,
    p: Principal,
    item: PlanItem,
    appointmentId?: string,
    encounterId?: string,
  ) {
    if (appointmentId) {
      const a = await findLinkedAppointment(tx, p, appointmentId);
      if (a.patientId !== item.patientId)
        throw new ConflictException({ error: "link_patient_mismatch", field: "appointmentId" });
      assertAny(p, ["plan:write", "appointment:write"], a.branchId);
      if (a.planItemId && a.planItemId !== item.id) throw linkedElsewhere();
    }
    if (encounterId) {
      const e = await findLinkedEncounter(tx, p, encounterId);
      if (e.patientId !== item.patientId)
        throw new ConflictException({ error: "link_patient_mismatch", field: "encounterId" });
    }
  }

  private async derive(
    tx: Tx,
    item: PlanItem,
    current: SessionStatus,
    appointmentId: string | null | undefined,
    encounterId: string | null | undefined,
  ): Promise<SessionStatus> {
    const appt = appointmentId
      ? await tx.appointment.findUnique({ where: { id: appointmentId }, select: { status: true } })
      : null;
    const enc = encounterId
      ? await tx.encounter.findUnique({ where: { id: encounterId }, select: { status: true } })
      : null;
    const procedure = encounterId
      ? await tx.procedureRecord.findFirst({
          where: { encounterId, planItemId: item.id, status: "COMPLETED" },
          select: { id: true },
        })
      : null;
    return deriveSessionStatus(current, {
      appointmentStatus: appt?.status ?? null,
      encounterSigned: enc?.status === "SIGNED",
      procedureCompleted: procedure !== null,
    });
  }

  /**
   * Appointment.planItemId (same patient, composite FK): set when not linked to an item yet. A
   * concurrent link of the same appointment to another item loses here (the guarded update re-checks
   * after the row lock) instead of silently scheduling this item from someone else's appointment.
   */
  private async linkAppointment(tx: Tx, item: PlanItem, appointmentId?: string | null) {
    if (!appointmentId) return;
    const { count } = await tx.appointment.updateMany({
      where: { id: appointmentId, planItemId: null },
      data: { planItemId: item.id },
    });
    if (count === 1) return;
    const a = await tx.appointment.findUnique({
      where: { id: appointmentId },
      select: { planItemId: true },
    });
    if (a?.planItemId !== item.id) throw linkedElsewhere();
  }

  /**
   * Item follows its sessions where the item table allows it (see ./session-status.ts). Each move
   * is checked with canTransitionPlanItem + planItemTransitionPermissions and versioned.
   */
  private async syncItem(
    tx: Tx,
    p: Principal,
    plan: TreatmentPlan,
    itemId: string,
    from: SessionStatus,
    to: SessionStatus,
    sessionNo: number,
  ) {
    if (from === to) return;
    await lockPlan(tx, p, plan.id);
    const item = await tx.planItem.findUniqueOrThrow({ where: { id: itemId } });
    let target: PlanItemStatus | null = null;
    if (to === "SCHEDULED" && item.status === "ACCEPTED") target = "SCHEDULED";
    else if (to === "COMPLETED" && (item.status === "ACCEPTED" || item.status === "SCHEDULED"))
      target = "IN_PROGRESS";
    else if (from === "SCHEDULED" && item.status === "SCHEDULED") {
      const stillScheduled = await tx.planItemSession.count({
        where: { planItemId: itemId, status: "SCHEDULED" },
      });
      if (stillScheduled === 0) target = "ACCEPTED";
    }
    if (!target || !canTransitionPlanItem(item.status, target)) return;
    assertAny(p, planItemTransitionPermissions(item.status, target), plan.branchId);
    await tx.planItem.update({ where: { id: itemId }, data: { status: target } });
    await commitPlanChange(tx, p, plan.id, `Session ${sessionNo} ${to.toLowerCase()}`);
  }
}
