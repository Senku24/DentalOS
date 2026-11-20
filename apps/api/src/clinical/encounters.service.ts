import { type Encounter, type Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  APPOINTMENT_TRANSITION_PERMISSIONS,
  type AppointmentStatus,
  type CreateAmendmentRequest,
  type CreateDiagnosisRequest,
  type CreateNoteRequest,
  type CreateProcedureRequest,
  type ListEncountersQuery,
  type OpenEncounterRequest,
  type UpdateDiagnosisRequest,
  type UpdateEncounterRequest,
  type UpdateNoteRequest,
  type UpdateProcedureRequest,
  canTransitionAppointment,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Permission, Principal } from "../auth/roles";
import { isUniqueViolation } from "../common/db-errors";
import { assertCan, branchWhere } from "../common/principal";
import { findActivePatient, findPatientOr404, lineageIds } from "../patients/patient-common";
import { EventBus } from "../realtime/event-bus";
import {
  PROCEDURE_INITIAL_STATUSES,
  assertAuthor,
  assertAuthorOrTreating,
  assertLinkablePlanItem,
  assertOpen,
  assertProcedureTransition,
  assertToothSurfaces,
  assertTreatingDentist,
  canAny,
  encounterSigned,
  guarded,
  isOnlyEvidenceOfPlanProgress,
  loadEncounter,
  lockEncounter,
  startPlanItem,
  toAmendment,
  toDiagnosis,
  toDocument,
  toEncounter,
  toNote,
  toProcedure,
  toTooth,
} from "./clinical-common";

type AuditEntry = { action: string; resource: string; resourceId?: string; branchId?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Appointment statuses an encounter cannot be opened from (the visit did not happen). */
const DEAD_APPOINTMENT: readonly AppointmentStatus[] = ["CANCELLED", "NO_SHOW", "RESCHEDULED"];

/**
 * Encounters, notes, amendments, diagnoses, procedures and encounter documents (PRD 3.4, 4.4;
 * ADR 0003 §2). clinical:* permissions are branch-scoped and checked against the encounter's
 * branch. Signed encounters are immutable (checked here first, DB triggers as the backstop) and
 * corrected only through append-only amendments. Every read and write is audited (ids only).
 */
@Injectable()
export class EncountersService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly auditSvc: AuditService,
    private readonly events: EventBus,
  ) {}

  private audit(p: Principal, e: AuditEntry) {
    return this.auditSvc.record(p, { ...e, outcome: "success" });
  }

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return guarded(() => withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }));
  }

  /** Loads the encounter and checks `perm` at its branch (403 outside the caller's scope). */
  private async encounterFor(tx: Tx, p: Principal, id: string, perm: Permission) {
    const e = await loadEncounter(tx, id);
    assertCan(p, perm, { branchId: e.branchId });
    return e;
  }

  /**
   * clinical:write at the encounter's branch and OPEN (409 encounter_signed). `lock` first takes
   * FOR SHARE on the row, for writes that no DB trigger serialises against a concurrent sign.
   */
  private async openFor(tx: Tx, p: Principal, id: string, lock = false): Promise<Encounter> {
    if (lock) await lockEncounter(tx, id);
    const e = await this.encounterFor(tx, p, id, "clinical:write");
    assertOpen(e);
    return e;
  }

  // ------------------------------------------------------------------------------------------
  // Encounters
  // ------------------------------------------------------------------------------------------

  async open(p: Principal, body: OpenEncounterRequest) {
    assertCan(p, "clinical:write", { branchId: body.branchId });
    const treating = body.treatingDentistUserId ?? p.userId;
    const result = await this.tx(p, async (tx) => {
      await findActivePatient(tx, body.patientId);
      const branch = await tx.branch.findUnique({ where: { id: body.branchId } });
      if (!branch) throw new NotFoundException({ error: "branch_not_found" });

      let moved: { appointmentId: string; startsAt: Date } | null = null;
      if (body.appointmentId) {
        const appt = await tx.appointment.findUnique({ where: { id: body.appointmentId } });
        if (!appt) throw new NotFoundException({ error: "appointment_not_found" });
        if (appt.patientId !== body.patientId)
          throw new BadRequestException({ error: "appointment_patient_mismatch" });
        if (appt.branchId !== body.branchId)
          throw new BadRequestException({ error: "appointment_branch_mismatch" });
        if (DEAD_APPOINTMENT.includes(appt.status))
          throw new ConflictException({ error: "appointment_not_active", status: appt.status });
        const existing = await tx.encounter.findUnique({
          where: { tenantId_appointmentId: { tenantId: p.tenantId, appointmentId: appt.id } },
          select: { id: true },
        });
        if (existing)
          throw new ConflictException({ error: "encounter_exists", encounterId: existing.id });
        // Opening the encounter seats the patient: CHECKED_IN -> IN_CHAIR (+ event).
        // Only CHECKED_IN may move to IN_CHAIR; other live statuses are left as they are.
        if (
          canTransitionAppointment(appt.status, "IN_CHAIR") &&
          canAny(p, APPOINTMENT_TRANSITION_PERMISSIONS.IN_CHAIR, appt.branchId)
        ) {
          const r = await tx.appointment.updateMany({
            where: { id: appt.id, status: "CHECKED_IN" },
            data: { status: "IN_CHAIR" },
          });
          if (r.count === 1) {
            await tx.appointmentEvent.create({
              data: {
                tenantId: p.tenantId,
                appointmentId: appt.id,
                fromStatus: "CHECKED_IN",
                toStatus: "IN_CHAIR",
                actorId: p.userId,
              },
            });
            moved = { appointmentId: appt.id, startsAt: appt.startsAt };
          }
        }
      }

      await assertTreatingDentist(tx, p.tenantId, treating, body.branchId);
      try {
        const enc = await tx.encounter.create({
          data: {
            tenantId: p.tenantId,
            patientId: body.patientId,
            branchId: body.branchId,
            appointmentId: body.appointmentId ?? null,
            treatingDentistUserId: treating,
            openedBy: p.userId,
          },
        });
        return { enc, moved };
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictException({ error: "encounter_exists" });
        throw e;
      }
    });

    const { enc, moved } = result;
    if (moved) {
      this.events.publish({
        tenantId: p.tenantId,
        branchId: enc.branchId,
        type: "appointment.status_changed",
        data: {
          appointmentId: moved.appointmentId,
          patientId: enc.patientId,
          fromStatus: "CHECKED_IN",
          toStatus: "IN_CHAIR",
          startsAt: moved.startsAt.toISOString(),
        },
      });
      await this.audit(p, {
        action: "appointment.status.in_chair",
        resource: "appointment",
        resourceId: moved.appointmentId,
        branchId: enc.branchId,
      });
    }
    await this.audit(p, {
      action: "clinical.encounter.open",
      resource: "encounter",
      resourceId: enc.id,
      branchId: enc.branchId,
    });
    return toEncounter(enc);
  }

  async list(p: Principal, q: ListEncountersQuery) {
    if (q.branchId) assertCan(p, "clinical:read", { branchId: q.branchId });
    if (q.cursor !== undefined && !UUID_RE.test(q.cursor))
      throw new BadRequestException({ error: "invalid_cursor" });
    const rows = await this.tx(p, async (tx) => {
      const and: Prisma.EncounterWhereInput[] = [branchWhere(p)];
      if (q.patientId) {
        await findPatientOr404(tx, q.patientId);
        and.push({ patientId: { in: await lineageIds(tx, q.patientId) } });
      }
      if (q.branchId) and.push({ branchId: q.branchId });
      if (q.status) and.push({ status: q.status });
      if (q.treatingDentistUserId) and.push({ treatingDentistUserId: q.treatingDentistUserId });
      if (q.from) and.push({ openedAt: { gte: new Date(q.from) } });
      if (q.to) and.push({ openedAt: { lt: new Date(q.to) } });
      return tx.encounter.findMany({
        where: { AND: and },
        orderBy: [{ openedAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
    });
    const items = rows.slice(0, q.limit);
    await this.audit(p, {
      action: "clinical.encounter.list",
      resource: q.patientId ? "patient" : "encounter",
      resourceId: q.patientId,
      branchId: q.branchId,
    });
    return {
      items: items.map(toEncounter),
      nextCursor: rows.length > q.limit ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async get(p: Principal, id: string) {
    const r = await this.tx(p, async (tx) => {
      const enc = await this.encounterFor(tx, p, id, "clinical:read");
      const [notes, amendments, diagnoses, procedures, toothRecords] = await Promise.all([
        tx.clinicalNote.findMany({ where: { encounterId: id }, orderBy: { createdAt: "asc" } }),
        tx.clinicalNoteAmendment.findMany({
          where: { encounterId: id },
          orderBy: { createdAt: "asc" },
        }),
        tx.diagnosis.findMany({ where: { encounterId: id }, orderBy: { createdAt: "asc" } }),
        tx.procedureRecord.findMany({
          where: { encounterId: id },
          orderBy: { performedAt: "asc" },
        }),
        tx.toothRecord.findMany({ where: { encounterId: id }, orderBy: { recordedAt: "asc" } }),
      ]);
      return { enc, notes, amendments, diagnoses, procedures, toothRecords };
    });
    await this.audit(p, {
      action: "clinical.encounter.read",
      resource: "encounter",
      resourceId: id,
      branchId: r.enc.branchId,
    });
    return {
      ...toEncounter(r.enc),
      notes: r.notes.map((n) =>
        toNote(
          n,
          r.amendments.filter((a) => a.noteId === n.id),
        ),
      ),
      amendments: r.amendments.filter((a) => a.noteId === null).map(toAmendment),
      diagnoses: r.diagnoses.map(toDiagnosis),
      procedures: r.procedures.map(toProcedure),
      toothRecords: r.toothRecords.map(toTooth),
    };
  }

  /**
   * Hand-over to another dentist while OPEN (audited). Only the current treating dentist or the
   * opener may hand over (403 not_treating_dentist), so nobody can take an encounter to sign it.
   */
  async update(p: Principal, id: string, body: UpdateEncounterRequest) {
    const enc = await this.tx(p, async (tx) => {
      const cur = await this.openFor(tx, p, id);
      const next = body.treatingDentistUserId;
      if (next === undefined || next === cur.treatingDentistUserId) return cur;
      if (p.userId !== cur.treatingDentistUserId && p.userId !== cur.openedBy)
        throw new ForbiddenException({ error: "not_treating_dentist" });
      await assertTreatingDentist(tx, p.tenantId, next, cur.branchId);
      const r = await tx.encounter.updateMany({
        where: { id, status: "OPEN" },
        data: { treatingDentistUserId: next },
      });
      if (r.count === 0) throw encounterSigned();
      return loadEncounter(tx, id);
    });
    await this.audit(p, {
      action: "clinical.encounter.update",
      resource: "encounter",
      resourceId: id,
      branchId: enc.branchId,
    });
    return toEncounter(enc);
  }

  /** Final: only the treating dentist with clinical:sign on the branch; never reopened. */
  async sign(p: Principal, id: string) {
    const enc = await this.tx(p, async (tx) => {
      const cur = await this.encounterFor(tx, p, id, "clinical:sign");
      assertOpen(cur);
      if (cur.treatingDentistUserId !== p.userId)
        throw new ForbiddenException({ error: "not_treating_dentist" });
      const r = await tx.encounter.updateMany({
        where: { id, status: "OPEN", treatingDentistUserId: p.userId },
        data: { status: "SIGNED", signedAt: new Date(), signedBy: p.userId },
      });
      if (r.count === 0) throw encounterSigned();
      return loadEncounter(tx, id);
    });
    await this.audit(p, {
      action: "clinical.encounter.sign",
      resource: "encounter",
      resourceId: id,
      branchId: enc.branchId,
    });
    return toEncounter(enc);
  }

  // ------------------------------------------------------------------------------------------
  // Notes & amendments
  // ------------------------------------------------------------------------------------------

  async addNote(p: Principal, encounterId: string, body: CreateNoteRequest) {
    const { enc, note } = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const note = await tx.clinicalNote.create({
        data: {
          tenantId: p.tenantId,
          encounterId,
          kind: body.kind,
          body: body.body,
          authorId: p.userId,
        },
      });
      return { enc, note };
    });
    await this.audit(p, {
      action: "clinical.note.create",
      resource: "clinical_note",
      resourceId: note.id,
      branchId: enc.branchId,
    });
    return toNote(note);
  }

  async updateNote(p: Principal, encounterId: string, noteId: string, body: UpdateNoteRequest) {
    const { enc, note } = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const cur = await tx.clinicalNote.findFirst({ where: { id: noteId, encounterId } });
      if (!cur) throw new NotFoundException({ error: "note_not_found" });
      assertAuthor(p, cur.authorId);
      const note = await tx.clinicalNote.update({
        where: { id: noteId },
        data: {
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
        },
      });
      return { enc, note };
    });
    await this.audit(p, {
      action: "clinical.note.update",
      resource: "clinical_note",
      resourceId: noteId,
      branchId: enc.branchId,
    });
    return toNote(note);
  }

  /** Draft notes of an OPEN encounter may be deleted (ADR 0003 §2). */
  async deleteNote(p: Principal, encounterId: string, noteId: string) {
    const enc = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const cur = await tx.clinicalNote.findFirst({ where: { id: noteId, encounterId } });
      if (!cur) throw new NotFoundException({ error: "note_not_found" });
      assertAuthorOrTreating(p, cur.authorId, enc);
      const r = await tx.clinicalNote.deleteMany({ where: { id: noteId, encounterId } });
      if (r.count === 0) throw new NotFoundException({ error: "note_not_found" });
      return enc;
    });
    await this.audit(p, {
      action: "clinical.note.delete",
      resource: "clinical_note",
      resourceId: noteId,
      branchId: enc.branchId,
    });
  }

  /** Append-only correction of a SIGNED encounter (whole encounter or one of its notes). */
  async addAmendment(p: Principal, encounterId: string, body: CreateAmendmentRequest) {
    const { enc, a } = await this.tx(p, async (tx) => {
      const enc = await this.encounterFor(tx, p, encounterId, "clinical:amend");
      if (enc.status !== "SIGNED") throw new ConflictException({ error: "encounter_not_signed" });
      if (body.noteId) {
        const note = await tx.clinicalNote.findFirst({
          where: { id: body.noteId, encounterId },
          select: { id: true },
        });
        if (!note) throw new NotFoundException({ error: "note_not_found" });
      }
      const a = await tx.clinicalNoteAmendment.create({
        data: {
          tenantId: p.tenantId,
          encounterId,
          noteId: body.noteId ?? null,
          body: body.body,
          reason: body.reason,
          authorId: p.userId,
        },
      });
      return { enc, a };
    });
    await this.audit(p, {
      action: "clinical.amendment.create",
      resource: "clinical_note_amendment",
      resourceId: a.id,
      branchId: enc.branchId,
    });
    return toAmendment(a);
  }

  async listAmendments(p: Principal, encounterId: string) {
    const { enc, rows } = await this.tx(p, async (tx) => {
      const enc = await this.encounterFor(tx, p, encounterId, "clinical:read");
      const rows = await tx.clinicalNoteAmendment.findMany({
        where: { encounterId },
        orderBy: { createdAt: "asc" },
      });
      return { enc, rows };
    });
    await this.audit(p, {
      action: "clinical.amendment.list",
      resource: "encounter",
      resourceId: encounterId,
      branchId: enc.branchId,
    });
    return { items: rows.map(toAmendment) };
  }

  // ------------------------------------------------------------------------------------------
  // Diagnoses
  // ------------------------------------------------------------------------------------------

  async addDiagnosis(p: Principal, encounterId: string, body: CreateDiagnosisRequest) {
    const { enc, d } = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const d = await tx.diagnosis.create({
        data: {
          tenantId: p.tenantId,
          encounterId,
          patientId: enc.patientId,
          code: body.code,
          label: body.label,
          toothCode: body.toothCode ?? null,
          surfaces: body.surfaces,
          notes: body.notes ?? null,
          diagnosedBy: p.userId,
        },
      });
      return { enc, d };
    });
    await this.audit(p, {
      action: "clinical.diagnosis.create",
      resource: "diagnosis",
      resourceId: d.id,
      branchId: enc.branchId,
    });
    return toDiagnosis(d);
  }

  async updateDiagnosis(
    p: Principal,
    encounterId: string,
    diagnosisId: string,
    body: UpdateDiagnosisRequest,
  ) {
    const { enc, d } = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const cur = await tx.diagnosis.findFirst({ where: { id: diagnosisId, encounterId } });
      if (!cur) throw new NotFoundException({ error: "diagnosis_not_found" });
      assertAuthor(p, cur.diagnosedBy);
      const toothCode = body.toothCode !== undefined ? body.toothCode : cur.toothCode;
      const surfaces =
        body.surfaces ??
        (body.toothCode !== undefined && body.toothCode !== cur.toothCode ? [] : cur.surfaces);
      assertToothSurfaces(toothCode, surfaces);
      const d = await tx.diagnosis.update({
        where: { id: diagnosisId },
        data: {
          ...(body.code !== undefined ? { code: body.code } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          toothCode,
          surfaces,
        },
      });
      return { enc, d };
    });
    await this.audit(p, {
      action: "clinical.diagnosis.update",
      resource: "diagnosis",
      resourceId: diagnosisId,
      branchId: enc.branchId,
    });
    return toDiagnosis(d);
  }

  async deleteDiagnosis(p: Principal, encounterId: string, diagnosisId: string) {
    const enc = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const cur = await tx.diagnosis.findFirst({ where: { id: diagnosisId, encounterId } });
      if (!cur) throw new NotFoundException({ error: "diagnosis_not_found" });
      assertAuthorOrTreating(p, cur.diagnosedBy, enc);
      const r = await tx.diagnosis.deleteMany({ where: { id: diagnosisId, encounterId } });
      if (r.count === 0) throw new NotFoundException({ error: "diagnosis_not_found" });
      return enc;
    });
    await this.audit(p, {
      action: "clinical.diagnosis.delete",
      resource: "diagnosis",
      resourceId: diagnosisId,
      branchId: enc.branchId,
    });
  }

  // ------------------------------------------------------------------------------------------
  // Procedures (local status table IN_PROGRESS -> COMPLETED | ABANDONED, see clinical-common)
  // ------------------------------------------------------------------------------------------

  async addProcedure(p: Principal, encounterId: string, body: CreateProcedureRequest) {
    if (!PROCEDURE_INITIAL_STATUSES.includes(body.status))
      throw new BadRequestException({ error: "invalid_initial_status", status: body.status });
    const { enc, r, planItemMoved } = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      if (body.serviceId) {
        const svc = await tx.service.findUnique({
          where: { id: body.serviceId },
          select: { id: true },
        });
        if (!svc) throw new BadRequestException({ error: "service_not_found", field: "serviceId" });
      }
      if (body.planItemId) await assertLinkablePlanItem(tx, p, body.planItemId, enc.patientId);
      const r = await tx.procedureRecord.create({
        data: {
          tenantId: p.tenantId,
          encounterId,
          patientId: enc.patientId,
          serviceId: body.serviceId ?? null,
          planItemId: body.planItemId ?? null,
          description: body.description || null,
          toothCode: body.toothCode ?? null,
          surfaces: body.surfaces,
          status: body.status,
          notes: body.notes ?? null,
          performedBy: p.userId,
          ...(body.performedAt ? { performedAt: new Date(body.performedAt) } : {}),
        },
      });
      // Only completed work starts a plan item (see startPlanItem).
      const planItemMoved =
        r.planItemId && r.status === "COMPLETED" ? await startPlanItem(tx, p, r.planItemId) : null;
      return { enc, r, planItemMoved };
    });
    await this.audit(p, {
      action: "clinical.procedure.create",
      resource: "procedure_record",
      resourceId: r.id,
      branchId: enc.branchId,
    });
    if (planItemMoved) await this.auditPlanItem(p, planItemMoved);
    return toProcedure(r);
  }

  async updateProcedure(
    p: Principal,
    encounterId: string,
    procedureId: string,
    body: UpdateProcedureRequest,
  ) {
    const { enc, r, planItemMoved } = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const cur = await tx.procedureRecord.findFirst({ where: { id: procedureId, encounterId } });
      if (!cur) throw new NotFoundException({ error: "procedure_not_found" });
      assertAuthor(p, cur.performedBy);
      // Same-status PATCH is 409 invalid_transition too (M2 conventions).
      if (body.status !== undefined) assertProcedureTransition(cur.status, body.status);
      const toothCode = body.toothCode !== undefined ? body.toothCode : cur.toothCode;
      const surfaces =
        body.surfaces ??
        (body.toothCode !== undefined && body.toothCode !== cur.toothCode ? [] : cur.surfaces);
      assertToothSurfaces(toothCode, surfaces);
      const description =
        body.description !== undefined ? body.description || null : cur.description;
      if (!cur.serviceId && !description)
        throw new BadRequestException({
          error: "validation_failed",
          issues: [{ path: "description", message: "serviceId or description required" }],
        });
      const r = await tx.procedureRecord.update({
        where: { id: procedureId },
        data: {
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.performedAt !== undefined ? { performedAt: new Date(body.performedAt) } : {}),
          description,
          toothCode,
          surfaces,
        },
      });
      const planItemMoved =
        r.planItemId && r.status === "COMPLETED" && cur.status !== "COMPLETED"
          ? await startPlanItem(tx, p, r.planItemId)
          : null;
      return { enc, r, planItemMoved };
    });
    await this.audit(p, {
      action: "clinical.procedure.update",
      resource: "procedure_record",
      resourceId: procedureId,
      branchId: enc.branchId,
    });
    if (planItemMoved) await this.auditPlanItem(p, planItemMoved);
    return toProcedure(r);
  }

  async deleteProcedure(p: Principal, encounterId: string, procedureId: string) {
    const enc = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId);
      const cur = await tx.procedureRecord.findFirst({ where: { id: procedureId, encounterId } });
      if (!cur) throw new NotFoundException({ error: "procedure_not_found" });
      assertAuthorOrTreating(p, cur.performedBy, enc);
      // Its plan item moved to IN_PROGRESS, which has no way back (ADR 0003 §3.1): keep the
      // procedure that justifies it. A link whose item never moved does not block deletion.
      if (
        cur.planItemId &&
        cur.status === "COMPLETED" &&
        (await isOnlyEvidenceOfPlanProgress(tx, cur.id, cur.planItemId))
      )
        throw new ConflictException({
          error: "procedure_linked_to_plan",
          planItemId: cur.planItemId,
        });
      const r = await tx.procedureRecord.deleteMany({ where: { id: procedureId, encounterId } });
      if (r.count === 0) throw new NotFoundException({ error: "procedure_not_found" });
      return enc;
    });
    await this.audit(p, {
      action: "clinical.procedure.delete",
      resource: "procedure_record",
      resourceId: procedureId,
      branchId: enc.branchId,
    });
  }

  private auditPlanItem(p: Principal, planItemId: string) {
    return this.audit(p, {
      action: "plan_item.status.in_progress",
      resource: "plan_item",
      resourceId: planItemId,
    });
  }

  // ------------------------------------------------------------------------------------------
  // Encounter documents (X-rays, photos): existing PatientDocument rows of the same patient
  // ------------------------------------------------------------------------------------------

  async listDocuments(p: Principal, encounterId: string) {
    const { enc, docs } = await this.tx(p, async (tx) => {
      const enc = await this.encounterFor(tx, p, encounterId, "clinical:read");
      assertCan(p, "document:read", { branchId: enc.branchId });
      const docs = await tx.patientDocument.findMany({
        where: { AND: [{ encounterId, status: { not: "DELETED" } }, branchWhere(p)] },
        orderBy: { createdAt: "asc" },
      });
      return { enc, docs };
    });
    await this.audit(p, {
      action: "clinical.encounter_documents.list",
      resource: "encounter",
      resourceId: encounterId,
      branchId: enc.branchId,
    });
    return { items: docs.map(toDocument) };
  }

  /**
   * Links an AVAILABLE document of the encounter's patient. The DB does not stop attaching to a
   * signed encounter, so the OPEN check here is the only guard (409 encounter_signed); it runs
   * under a FOR SHARE lock on the encounter so a concurrent sign cannot slip in between.
   */
  async attachDocument(p: Principal, encounterId: string, documentId: string) {
    const { enc, doc } = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId, true);
      const doc = await this.documentFor(tx, p, documentId);
      if (doc.patientId !== enc.patientId)
        throw new BadRequestException({ error: "document_patient_mismatch" });
      if (doc.status !== "AVAILABLE")
        throw new ConflictException({ error: "document_not_available", status: doc.status });
      if (doc.encounterId === encounterId) return { enc, doc };
      if (doc.encounterId)
        throw new ConflictException({
          error: "document_already_attached",
          encounterId: doc.encounterId,
        });
      const r = await tx.patientDocument.updateMany({
        where: { id: documentId, encounterId: null },
        data: { encounterId },
      });
      if (r.count === 0) throw new ConflictException({ error: "document_already_attached" });
      return {
        enc,
        doc: await tx.patientDocument.findUniqueOrThrow({ where: { id: documentId } }),
      };
    });
    await this.audit(p, {
      action: "clinical.encounter_document.attach",
      resource: "patient_document",
      resourceId: doc.id,
      branchId: enc.branchId,
    });
    return toDocument(doc);
  }

  /** Unlinks a document from an OPEN encounter (same FOR SHARE lock as attach). */
  async detachDocument(p: Principal, encounterId: string, documentId: string) {
    const enc = await this.tx(p, async (tx) => {
      const enc = await this.openFor(tx, p, encounterId, true);
      const doc = await this.documentFor(tx, p, documentId);
      if (doc.encounterId !== encounterId)
        throw new NotFoundException({ error: "document_not_attached" });
      await tx.patientDocument.updateMany({
        where: { id: documentId, encounterId },
        data: { encounterId: null },
      });
      return enc;
    });
    await this.audit(p, {
      action: "clinical.encounter_document.detach",
      resource: "patient_document",
      resourceId: documentId,
      branchId: enc.branchId,
    });
  }

  /** Changing a document's encounter link is a document write at the document's branch. */
  private async documentFor(tx: Tx, p: Principal, documentId: string) {
    const doc = await tx.patientDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException({ error: "document_not_found" });
    assertCan(p, "document:write", { branchId: doc.branchId });
    return doc;
  }
}
