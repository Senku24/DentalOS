import {
  type PatientAlert,
  type PatientAllergy,
  type PatientMedicalHistory,
  Prisma,
  PrismaClient,
  withTenant,
} from "@dentalos/db";
import type {
  AddAlertRequest,
  AddAllergyRequest,
  AddMedicalHistoryRequest,
  AlertResponse,
  AllergyResponse,
  MedicalHistoryResponse,
} from "@dentalos/validation";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan } from "../common/principal";
import { findActivePatient, findPatientOr404, lineageIds } from "./patient-common";

const toHistory = (h: PatientMedicalHistory): MedicalHistoryResponse => ({
  id: h.id,
  patientId: h.patientId,
  version: h.version,
  medical: h.medical as MedicalHistoryResponse["medical"],
  dental: h.dental as MedicalHistoryResponse["dental"],
  medications: h.medications as MedicalHistoryResponse["medications"],
  notes: h.notes,
  recordedBy: h.recordedBy,
  recordedAt: h.recordedAt.toISOString(),
});

const toAllergy = (a: PatientAllergy): AllergyResponse => ({
  id: a.id,
  substance: a.substance,
  reaction: a.reaction,
  severity: a.severity,
  active: a.active,
  notedBy: a.notedBy,
  notedAt: a.notedAt.toISOString(),
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
});

const toAlert = (a: PatientAlert): AlertResponse => ({
  id: a.id,
  title: a.title,
  details: a.details,
  severity: a.severity,
  active: a.active,
  createdBy: a.createdBy,
  createdAt: a.createdAt.toISOString(),
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
});

/**
 * Medical/dental history (append-only versions), allergies and clinical alerts. Health data:
 * gated by medical:read / medical:write (narrower than patient:read). Reads are audited.
 * Reads on a survivor include records of patients merged into it (history is never re-pointed).
 */
@Injectable()
export class MedicalService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private auditRead(p: Principal, resource: string, patientId: string) {
    return this.audit.record(p, {
      action: `patient.${resource}.read`,
      resource: "patient",
      resourceId: patientId,
      outcome: "success",
    });
  }

  async history(p: Principal, patientId: string) {
    const versions = await withTenant(this.prisma, p.tenantId, async (tx) => {
      await findPatientOr404(tx, patientId);
      const ids = await lineageIds(tx, patientId);
      return tx.patientMedicalHistory.findMany({
        where: { patientId: { in: ids } },
        orderBy: [{ recordedAt: "desc" }, { version: "desc" }],
      });
    });
    await this.auditRead(p, "medical_history", patientId);
    const items = versions.map(toHistory);
    return { latest: items[0] ?? null, versions: items };
  }

  /** Version N+1 of the patient's own history; earlier versions are immutable (DB-enforced). */
  async addHistory(p: Principal, patientId: string, body: AddMedicalHistoryRequest) {
    if (body.branchId) assertCan(p, "branch:read", { branchId: body.branchId });
    const h = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        const max = await tx.patientMedicalHistory.aggregate({
          where: { patientId },
          _max: { version: true },
        });
        try {
          return await tx.patientMedicalHistory.create({
            data: {
              tenantId: p.tenantId,
              patientId,
              branchId: body.branchId,
              version: (max._max.version ?? 0) + 1,
              medical: body.medical as Prisma.InputJsonValue,
              dental: body.dental as Prisma.InputJsonValue,
              medications: body.medications as Prisma.InputJsonValue,
              notes: body.notes,
              recordedBy: p.userId,
            },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
            throw new ConflictException({ error: "concurrent_history_edit" });
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
            throw new NotFoundException({ error: "branch_not_found" });
          throw e;
        }
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.medical_history.add",
      resource: "patient_medical_history",
      resourceId: h.id,
      branchId: h.branchId ?? undefined,
      outcome: "success",
    });
    return toHistory(h);
  }

  async allergies(p: Principal, patientId: string, includeResolved: boolean) {
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      await findPatientOr404(tx, patientId);
      const ids = await lineageIds(tx, patientId);
      return tx.patientAllergy.findMany({
        where: { patientId: { in: ids }, ...(includeResolved ? {} : { active: true }) },
        orderBy: [{ active: "desc" }, { notedAt: "desc" }],
      });
    });
    await this.auditRead(p, "allergies", patientId);
    return { items: rows.map(toAllergy) };
  }

  async addAllergy(p: Principal, patientId: string, body: AddAllergyRequest) {
    const a = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        return tx.patientAllergy.create({
          data: {
            tenantId: p.tenantId,
            patientId,
            substance: body.substance,
            reaction: body.reaction,
            severity: body.severity,
            notedBy: p.userId,
          },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.allergy.add",
      resource: "patient_allergy",
      resourceId: a.id,
      outcome: "success",
    });
    return toAllergy(a);
  }

  /** Deactivates; the row is kept. The free-text reason is not stored (no column) — see Flags. */
  async resolveAllergy(p: Principal, patientId: string, allergyId: string) {
    const a = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        const cur = await tx.patientAllergy.findFirst({ where: { id: allergyId, patientId } });
        if (!cur) throw new NotFoundException({ error: "allergy_not_found" });
        if (!cur.active) throw new ConflictException({ error: "already_resolved" });
        return tx.patientAllergy.update({
          where: { id: allergyId },
          data: { active: false, resolvedBy: p.userId, resolvedAt: new Date() },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.allergy.resolve",
      resource: "patient_allergy",
      resourceId: allergyId,
      outcome: "success",
    });
    return toAllergy(a);
  }

  async alerts(p: Principal, patientId: string, includeResolved: boolean) {
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      await findPatientOr404(tx, patientId);
      const ids = await lineageIds(tx, patientId);
      return tx.patientAlert.findMany({
        where: { patientId: { in: ids }, ...(includeResolved ? {} : { active: true }) },
        orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      });
    });
    await this.auditRead(p, "alerts", patientId);
    return { items: rows.map(toAlert) };
  }

  async addAlert(p: Principal, patientId: string, body: AddAlertRequest) {
    const a = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        return tx.patientAlert.create({
          data: {
            tenantId: p.tenantId,
            patientId,
            title: body.title,
            details: body.details,
            severity: body.severity,
            createdBy: p.userId,
          },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.alert.add",
      resource: "patient_alert",
      resourceId: a.id,
      outcome: "success",
    });
    return toAlert(a);
  }

  async resolveAlert(p: Principal, patientId: string, alertId: string) {
    const a = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        const cur = await tx.patientAlert.findFirst({ where: { id: alertId, patientId } });
        if (!cur) throw new NotFoundException({ error: "alert_not_found" });
        if (!cur.active) throw new ConflictException({ error: "already_resolved" });
        return tx.patientAlert.update({
          where: { id: alertId },
          data: { active: false, resolvedBy: p.userId, resolvedAt: new Date() },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.alert.resolve",
      resource: "patient_alert",
      resourceId: alertId,
      outcome: "success",
    });
    return toAlert(a);
  }
}
