import {
  type PlanItem,
  type PlanItemSession,
  Prisma,
  type Service,
  type TreatmentPlan,
  type TreatmentPlanVersion,
  type Tx,
} from "@dentalos/db";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  type PlanItemResponse,
  type PlanItemSessionResponse,
  type PlanItemStatus,
  type PlanSnapshot,
  type PlanTotals,
  type PlanVersionResponse,
  type TreatmentPlanResponse,
  type TreatmentPlanStatus,
  type TreatmentPlanSummary,
  canTransitionPlan,
  derivePlanStatus,
  planTotals,
  uuid,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { type Permission, type Principal, can } from "../auth/roles";
import { effectivePrice, overridesFor } from "../catalog/pricing";
import { clinicalGuardError, isUniqueViolation } from "../common/db-errors";
import { withBranchScope } from "../common/principal";
import { resolveSurvivorId } from "../patients/patient-common";

/**
 * Shared plan helpers (P1 only): row locking + scoped loading, frozen pricing, version snapshots and
 * response mappers. Rules: docs/adr/0003-clinical-domain-rules.md §3 (proposed).
 */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export type ItemWithService = PlanItem & { service: Pick<Service, "code" | "name"> };

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const invalidTransition = (
  from: string,
  to: string,
  allowed: readonly string[],
  extra: Record<string, unknown> = {},
) => new ConflictException({ error: "invalid_transition", from, to, allowed, ...extra });

export const badRequest = (path: string, message: string) =>
  new BadRequestException({ error: "validation_failed", issues: [{ path, message }] });

/** Any one of `perms` on `branchId`, else 403 (ADR 0003 permission tables are "any one"). */
export function assertAny(p: Principal, perms: readonly string[], branchId: string): void {
  if (!perms.some((perm) => can(p, perm as Permission, { branchId })))
    throw new ForbiddenException();
}

/**
 * Maps DB-enforced failures of plan writes: trigger guards (409 `<code>`), version races (409
 * `concurrent_edit`), composite-FK mismatches (409 `link_patient_mismatch`, i.e. a linked
 * appointment / encounter / plan version belongs to another patient).
 */
export function mapPlanDbError(e: unknown): never {
  const g = clinicalGuardError(e);
  if (g) {
    if (g === "clinical_row_moved") throw new BadRequestException({ error: g });
    throw new ConflictException({ error: g });
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2003") {
      const meta = e.meta as { field_name?: unknown; constraint?: unknown } | undefined;
      const field = `${meta?.field_name ?? ""} ${meta?.constraint ?? ""}`;
      if (field.includes("planVersionId"))
        throw new ConflictException({ error: "plan_version_patient_mismatch" });
      throw new ConflictException({ error: "link_patient_mismatch" });
    }
  }
  if (isUniqueViolation(e)) throw new ConflictException({ error: "concurrent_edit" });
  throw e;
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/**
 * Locks the plan row (FOR UPDATE) so every mutation of one plan is serialised (versions are a
 * strict sequence), then loads it within the caller's branch scope. Out of scope / other tenant
 * (RLS) / missing -> 404.
 */
export async function lockPlan(tx: Tx, p: Principal, planId: string): Promise<TreatmentPlan> {
  await tx.$queryRaw`SELECT "id" FROM "TreatmentPlan" WHERE "id" = ${planId}::uuid FOR UPDATE`;
  const plan = await tx.treatmentPlan.findFirst({ where: withBranchScope(p, { id: planId }) });
  if (!plan) throw new NotFoundException({ error: "plan_not_found" });
  return plan;
}

/** Read-only scoped load. */
export async function findPlan(tx: Tx, p: Principal, planId: string): Promise<TreatmentPlan> {
  const plan = await tx.treatmentPlan.findFirst({ where: withBranchScope(p, { id: planId }) });
  if (!plan) throw new NotFoundException({ error: "plan_not_found" });
  return plan;
}

/** Item + its plan (plan locked), scoped through the plan's branch. */
export async function lockItem(tx: Tx, p: Principal, itemId: string) {
  const item = await tx.planItem.findUnique({ where: { id: itemId } });
  if (!item) throw new NotFoundException({ error: "plan_item_not_found" });
  let plan: TreatmentPlan;
  try {
    plan = await lockPlan(tx, p, item.planId);
  } catch (e) {
    if (e instanceof NotFoundException)
      throw new NotFoundException({ error: "plan_item_not_found" });
    throw e;
  }
  // Re-read after the lock: a concurrent writer may have changed it.
  const fresh = await tx.planItem.findUniqueOrThrow({ where: { id: itemId } });
  return { item: fresh, plan };
}

export async function findItem(tx: Tx, p: Principal, itemId: string) {
  const item = await tx.planItem.findUnique({ where: { id: itemId } });
  if (!item) throw new NotFoundException({ error: "plan_item_not_found" });
  const plan = await tx.treatmentPlan.findFirst({
    where: withBranchScope(p, { id: item.planId }),
  });
  if (!plan) throw new NotFoundException({ error: "plan_item_not_found" });
  return { item, plan };
}

/**
 * A linked appointment / encounter must be visible to the caller: tenant RLS plus the read
 * permission on ITS branch (`appointment:read` / `clinical:read`). Missing and out-of-scope rows
 * both answer 404, checked BEFORE any patient comparison so the response never reveals that an
 * out-of-scope id exists or whose it is.
 */
export async function findLinkedAppointment(tx: Tx, p: Principal, id: string) {
  const a = await tx.appointment.findUnique({ where: { id } });
  if (!a || !can(p, "appointment:read", { branchId: a.branchId }))
    throw new NotFoundException({ error: "appointment_not_found" });
  return a;
}

export async function findLinkedEncounter(tx: Tx, p: Principal, id: string) {
  const e = await tx.encounter.findUnique({ where: { id } });
  if (!e || !can(p, "clinical:read", { branchId: e.branchId }))
    throw new NotFoundException({ error: "encounter_not_found" });
  return e;
}

/**
 * Plans stay on the patient id they were created for (never re-pointed by a merge). Writes to a
 * merged patient's plan answer the M1 contract 409 `patient_merged` with the survivor pointer.
 */
export async function assertPatientActive(tx: Tx, patientId: string): Promise<void> {
  const pt = await tx.patient.findUnique({ where: { id: patientId } });
  if (!pt) throw new NotFoundException({ error: "patient_not_found" });
  if (pt.mergedIntoId)
    throw new ConflictException({
      error: "patient_merged",
      message: "This patient was merged; plan the surviving record",
      mergedIntoId: pt.mergedIntoId,
      survivorId: await resolveSurvivorId(tx, pt),
    });
}

export function assertOpen(plan: TreatmentPlan): void {
  if (isPlanClosed(plan))
    throw new ConflictException({ error: "plan_closed", status: plan.status });
}

export const isPlanClosed = (plan: TreatmentPlan) =>
  plan.status === "COMPLETED" || plan.status === "CANCELLED";

export function assertPresented(plan: TreatmentPlan): void {
  if (plan.status === "DRAFT")
    throw new ConflictException({ error: "plan_not_presented", status: plan.status });
}

/**
 * Cancels the open (PLANNED / SCHEDULED) sessions matching `where` — used when their item or plan
 * is cancelled, so a withdrawn item has no live sessions left (ADR 0003 §3.1: sessions are
 * cancelled, never deleted). Linked appointments are owned by scheduling and are left untouched;
 * the cancelled sessions (with their appointment ids) are returned for auditing.
 */
export async function cancelOpenSessions(
  tx: Tx,
  where: Prisma.PlanItemSessionWhereInput,
): Promise<{ id: string; appointmentId: string | null }[]> {
  const open = await tx.planItemSession.findMany({
    where: { AND: [where, { status: { in: ["PLANNED", "SCHEDULED"] } }] },
    select: { id: true, appointmentId: true },
  });
  if (open.length > 0)
    await tx.planItemSession.updateMany({
      where: { id: { in: open.map((s) => s.id) } },
      data: { status: "CANCELLED" },
    });
  return open;
}

/**
 * The item still holds a live booking: a SCHEDULED session, or an active appointment bound to it
 * (`Appointment.planItemId`). Moves that would leave such an item ACCEPTED / DEFERRED (booking
 * undo, patient defer) are refused with 409 `item_still_scheduled` — release the booking first
 * (cancel the appointment in scheduling, or unlink / cancel the session).
 */
export async function assertNoLiveBooking(tx: Tx, itemId: string): Promise<void> {
  const sessions = await tx.planItemSession.count({
    where: { planItemId: itemId, status: "SCHEDULED" },
  });
  const appointments = await tx.appointment.count({
    where: { planItemId: itemId, status: { in: [...ACTIVE_APPOINTMENT_STATUSES] } },
  });
  if (sessions > 0 || appointments > 0)
    throw new ConflictException({
      error: "item_still_scheduled",
      itemId,
      scheduledSessions: sessions,
      activeAppointments: appointments,
    });
}

/**
 * A session stopped pointing at `appointmentId` (unlinked, replaced or cancelled): clear
 * `Appointment.planItemId` — only while it is still bound to THIS item and no other open session of
 * the item references the appointment — so the appointment is free again and scheduling's release
 * no longer acts on this item for it.
 */
export async function unbindAppointment(
  tx: Tx,
  itemId: string,
  appointmentId: string | null | undefined,
): Promise<void> {
  if (!appointmentId) return;
  const stillUsed = await tx.planItemSession.count({
    where: { planItemId: itemId, appointmentId, status: { in: ["PLANNED", "SCHEDULED"] } },
  });
  if (stillUsed > 0) return;
  await tx.appointment.updateMany({
    where: { id: appointmentId, planItemId: itemId },
    data: { planItemId: null },
  });
}

// ---------------------------------------------------------------------------------------------
// Frozen pricing (ADR 0003 §3.1) — never trust a client price
// ---------------------------------------------------------------------------------------------

export interface FrozenPrice {
  estimatePricePaise: number;
  priceSource: "BASE" | "OVERRIDE";
  pricedAt: Date;
}

/**
 * Effective catalogue price of each service at the plan's branch, now (catalog/pricing.ts).
 * Unknown service -> 404 `service_not_found`; inactive -> 409 `service_inactive`.
 */
export async function freezePrices(
  tx: Tx,
  tenantId: string,
  branchId: string,
  serviceIds: string[],
): Promise<Map<string, FrozenPrice>> {
  const ids = [...new Set(serviceIds)];
  if (ids.length === 0) return new Map();
  const services = await tx.service.findMany({ where: { id: { in: ids } } });
  const byId = new Map(services.map((s) => [s.id, s]));
  for (const id of ids) {
    const s = byId.get(id);
    if (!s) throw new NotFoundException({ error: "service_not_found", serviceId: id });
    if (!s.active) throw new ConflictException({ error: "service_inactive", serviceId: id });
  }
  const at = new Date();
  const overrides = await overridesFor(tx, tenantId, branchId, ids, at);
  return new Map(
    services.map((s) => {
      const e = effectivePrice(s, branchId, overrides.get(s.id));
      return [s.id, { estimatePricePaise: e.pricePaise, priceSource: e.source, pricedAt: at }];
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Versions (append-only snapshots) & derived plan status
// ---------------------------------------------------------------------------------------------

export const loadItems = (tx: Tx, planId: string): Promise<ItemWithService[]> =>
  tx.planItem.findMany({
    where: { planId },
    include: { service: { select: { code: true, name: true } } },
    orderBy: [{ phase: "asc" }, { sequence: "asc" }, { createdAt: "asc" }],
  });

export function buildSnapshot(plan: TreatmentPlan, items: ItemWithService[]): PlanSnapshot {
  return {
    plan: {
      id: plan.id,
      patientId: plan.patientId,
      branchId: plan.branchId,
      title: plan.title,
      notes: plan.notes,
      status: plan.status,
    },
    items: items.map((i) => ({
      id: i.id,
      phase: i.phase,
      sequence: i.sequence,
      serviceId: i.serviceId,
      serviceCode: i.service.code,
      serviceName: i.service.name,
      toothCode: i.toothCode,
      surfaces: i.surfaces,
      quantity: i.quantity,
      estimatePricePaise: i.estimatePricePaise,
      priceSource: i.priceSource as "BASE" | "OVERRIDE",
      status: i.status,
      decisionReason: i.decisionReason,
      notes: i.notes,
    })),
    totals: planTotals(items),
  };
}

/**
 * Commits a change to a plan: once the plan has been presented (currentVersion > 0, or `present`
 * for the presentation itself) it re-derives the plan status from its items (`derivePlanStatus`,
 * applied only when `canTransitionPlan` allows it) and appends version N+1 with a full snapshot in
 * the same transaction. Never-presented DRAFT plans are edited in place (no versions).
 * Callers must hold the plan lock (`lockPlan`).
 */
export async function commitPlanChange(
  tx: Tx,
  p: Principal,
  planId: string,
  reason: string | null | undefined,
  opts: { present?: boolean } = {},
): Promise<void> {
  const plan = await tx.treatmentPlan.findUniqueOrThrow({ where: { id: planId } });
  if (plan.currentVersion === 0 && !opts.present) return;
  const items = await loadItems(tx, planId);
  const derived = derivePlanStatus(
    plan.status,
    items.map((i) => i.status),
  );
  const status: TreatmentPlanStatus =
    derived !== plan.status && canTransitionPlan(plan.status, derived) ? derived : plan.status;
  const version = plan.currentVersion + 1;
  const updated = await tx.treatmentPlan.update({
    where: { id: planId },
    data: { status, currentVersion: version },
  });
  try {
    await tx.treatmentPlanVersion.create({
      data: {
        tenantId: plan.tenantId,
        planId,
        patientId: plan.patientId,
        version,
        snapshot: buildSnapshot(updated, items) as unknown as Prisma.InputJsonValue,
        reason: reason?.trim() ? reason.trim() : null,
        createdBy: p.userId,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictException({ error: "concurrent_edit" });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------

export function toItem(i: PlanItem): PlanItemResponse & { lineTotalPaise: number } {
  return {
    id: i.id,
    planId: i.planId,
    phase: i.phase,
    sequence: i.sequence,
    serviceId: i.serviceId,
    toothCode: i.toothCode,
    surfaces: i.surfaces as PlanItemResponse["surfaces"],
    quantity: i.quantity,
    estimatePricePaise: i.estimatePricePaise,
    lineTotalPaise: i.estimatePricePaise * i.quantity,
    priceSource: i.priceSource as "BASE" | "OVERRIDE",
    pricedAt: i.pricedAt.toISOString(),
    status: i.status,
    notes: i.notes,
    decidedAt: iso(i.decidedAt),
    decidedBy: i.decidedBy,
    decisionReason: i.decisionReason,
  };
}

type PricedItem = { status: PlanItemStatus; estimatePricePaise: number; quantity: number };

/** Totals per phase (ascending), each with the same buckets as the plan totals. */
export function phaseTotals(
  items: (PricedItem & { phase: number })[],
): (PlanTotals & { phase: number })[] {
  const phases = [...new Set(items.map((i) => i.phase))].sort((a, b) => a - b);
  return phases.map((phase) => ({
    phase,
    ...planTotals(items.filter((i) => i.phase === phase)),
  }));
}

export function toSummary(plan: TreatmentPlan, items: PricedItem[]): TreatmentPlanSummary {
  return {
    id: plan.id,
    patientId: plan.patientId,
    branchId: plan.branchId,
    title: plan.title,
    status: plan.status,
    currentVersion: plan.currentVersion,
    totals: planTotals(items),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

export function toPlan(
  plan: TreatmentPlan,
  items: PlanItem[],
): TreatmentPlanResponse & { phaseTotals: ReturnType<typeof phaseTotals> } {
  return {
    ...toSummary(plan, items),
    encounterId: plan.encounterId,
    notes: plan.notes,
    presentedAt: iso(plan.presentedAt),
    presentedBy: plan.presentedBy,
    approvedAt: iso(plan.approvedAt),
    approvedBy: plan.approvedBy,
    cancelReason: plan.cancelReason,
    createdBy: plan.createdBy,
    items: items.map(toItem),
    phaseTotals: phaseTotals(items),
  };
}

export async function loadPlanResponse(tx: Tx, planId: string) {
  const plan = await tx.treatmentPlan.findUniqueOrThrow({ where: { id: planId } });
  return toPlan(plan, await loadItems(tx, planId));
}

export function toVersion(v: TreatmentPlanVersion): PlanVersionResponse {
  return {
    id: v.id,
    planId: v.planId,
    version: v.version,
    reason: v.reason,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    snapshot: v.snapshot as unknown as PlanSnapshot,
  };
}

export function toSession(s: PlanItemSession): PlanItemSessionResponse {
  return {
    id: s.id,
    planItemId: s.planItemId,
    sessionNo: s.sessionNo,
    appointmentId: s.appointmentId,
    encounterId: s.encounterId,
    status: s.status,
    notes: s.notes,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Keyset cursor (createdAt desc, id desc)
// ---------------------------------------------------------------------------------------------

export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  // The id reaches a uuid column: anything else would be an unhandled Prisma error (500).
  if (rest.length > 0 || !uuid.safeParse(id).success || Number.isNaN(createdAt.getTime()))
    throw badRequest("cursor", "Invalid cursor");
  return { createdAt, id: id as string };
}
