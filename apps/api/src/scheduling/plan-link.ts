import type { Tx } from "@dentalos/db";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  allowedPlanItemTransitions,
  canTransitionPlanItem,
  planItemTransitionPermissions,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { type Permission, type Principal, can } from "../auth/roles";
import { invalidTransition } from "./scheduling-common";

/**
 * Treatment-plan linkage from the scheduling side (ADR 0003 §3.1). Linked by id/FK only — no imports
 * from apps/api/src/plans. Only two moves are ever made here:
 *   book    : item ACCEPTED -> SCHEDULED, plus a SCHEDULED PlanItemSession pointing at the appointment
 *   release : item SCHEDULED -> ACCEPTED (appointment cancelled / no-show), its session -> CANCELLED
 * Plan items are never touched otherwise. These moves do not append a TreatmentPlanVersion (see the
 * S1 report: a version bump would invalidate consent signed against the current version).
 */

const OPEN_SESSION = ["PLANNED", "SCHEDULED"] as const;

/**
 * Before inserting/updating the appointment. Order matters (no leaks about items the caller cannot
 * see): the item must exist AND its plan's branch be visible to the caller (plan:read or
 * appointment:read there) — else 404 plan_item_not_found, same as a missing id; the caller must hold
 * a SCHEDULED-permission on that branch (403); only then the patient match (the composite FK
 * enforces it too; answer clearly first) and the ACCEPTED status are checked.
 */
export async function assertPlanItemBookable(
  tx: Tx,
  p: Principal,
  patientId: string,
  planItemId: string,
): Promise<void> {
  const item = await tx.planItem.findUnique({
    where: { id: planItemId },
    select: { id: true, status: true, patientId: true, plan: { select: { branchId: true } } },
  });
  const branchId = item?.plan.branchId;
  if (
    !item ||
    !branchId ||
    !(can(p, "plan:read", { branchId }) || can(p, "appointment:read", { branchId }))
  )
    throw new NotFoundException({ error: "plan_item_not_found" });
  const perms = planItemTransitionPermissions("ACCEPTED", "SCHEDULED") as readonly Permission[];
  if (!perms.some((perm) => can(p, perm, { branchId }))) throw new ForbiddenException();
  if (item.patientId !== patientId)
    throw new BadRequestException({ error: "plan_item_patient_mismatch" });
  if (item.status !== "ACCEPTED" || !canTransitionPlanItem(item.status, "SCHEDULED"))
    throw invalidTransition(item.status, "SCHEDULED", allowedPlanItemTransitions(item.status));
}

/** After the appointment row exists (same transaction): item -> SCHEDULED + a SCHEDULED session. */
export async function linkPlanItem(
  tx: Tx,
  p: Principal,
  appt: { id: string; tenantId: string; patientId: string },
  planItemId: string,
): Promise<void> {
  const item = { id: planItemId };
  // Guarded update: a concurrent booking of the same item loses here instead of double-scheduling.
  const moved = await tx.planItem.updateMany({
    where: { id: item.id, status: "ACCEPTED" },
    data: { status: "SCHEDULED" },
  });
  if (moved.count !== 1)
    throw new ConflictException({ error: "plan_item_changed", message: "Retry the booking" });

  // Attach to the first planned session without an appointment, else open the next session.
  const planned = await tx.planItemSession.findFirst({
    where: { planItemId: item.id, status: "PLANNED", appointmentId: null },
    orderBy: { sessionNo: "asc" },
  });
  if (planned) {
    await tx.planItemSession.update({
      where: { id: planned.id },
      data: { status: "SCHEDULED", appointmentId: appt.id },
    });
    return;
  }
  const last = await tx.planItemSession.findFirst({
    where: { planItemId: item.id },
    orderBy: { sessionNo: "desc" },
    select: { sessionNo: true },
  });
  await tx.planItemSession.create({
    data: {
      tenantId: appt.tenantId,
      planItemId: item.id,
      patientId: appt.patientId,
      sessionNo: (last?.sessionNo ?? 0) + 1,
      appointmentId: appt.id,
      status: "SCHEDULED",
      createdBy: p.userId,
    },
  });
}

/**
 * The appointment no longer happens (cancelled / no-show / unlinked): cancel its open session and
 * move the item back SCHEDULED -> ACCEPTED, unless another active appointment still holds the item.
 */
export async function releasePlanItem(
  tx: Tx,
  appointmentId: string,
  planItemId: string,
): Promise<void> {
  await tx.planItemSession.updateMany({
    where: { planItemId, appointmentId, status: { in: [...OPEN_SESSION] } },
    data: { status: "CANCELLED" },
  });
  const stillBooked = await tx.appointment.count({
    where: {
      planItemId,
      id: { not: appointmentId },
      status: { in: [...ACTIVE_APPOINTMENT_STATUSES] },
    },
  });
  if (stillBooked > 0) return;
  const item = await tx.planItem.findUnique({
    where: { id: planItemId },
    select: { status: true },
  });
  if (item && canTransitionPlanItem(item.status, "ACCEPTED") && item.status === "SCHEDULED")
    await tx.planItem.updateMany({
      where: { id: planItemId, status: "SCHEDULED" },
      data: { status: "ACCEPTED" },
    });
}

/** Reschedule: the open session follows the appointment to its successor row. */
export async function movePlanItemSession(
  tx: Tx,
  planItemId: string,
  fromAppointmentId: string,
  toAppointmentId: string,
): Promise<void> {
  await tx.planItemSession.updateMany({
    where: { planItemId, appointmentId: fromAppointmentId, status: { in: [...OPEN_SESSION] } },
    data: { appointmentId: toAppointmentId },
  });
}
