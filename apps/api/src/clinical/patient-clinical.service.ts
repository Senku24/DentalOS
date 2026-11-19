import { type Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type AlertResponse,
  type AllergyResponse,
  type ChartTeethRequest,
  type ClinicalContextResponse,
  type MedicalHistoryResponse,
  type OdontogramQuery,
  type OdontogramResponse,
  type SupersedeToothRecordsRequest,
  dentitionOf,
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
import { type Principal, branchFilter, can } from "../auth/roles";
import { assertCan, branchWhere } from "../common/principal";
import {
  findActivePatient,
  findPatientOr404,
  lineageIds,
  toSummary,
} from "../patients/patient-common";
import {
  TOOTH_ENCOUNTER_BRANCH,
  assertOpen,
  guarded,
  loadEncounter,
  odontogramScope,
  toEncounter,
  toTooth,
  toVisibleTooth,
} from "./clinical-common";

const RECENT_SIGNED_ENCOUNTERS = 10;
const TERMINAL_PLAN_STATUSES = ["COMPLETED", "CANCELLED"] as const;

/**
 * Patient-level clinical views: odontogram (chart / supersede / snapshot) and the clinical
 * workspace context. Reads span the merge lineage (clinical rows are never re-pointed); writes go
 * to the surviving patient only (409 patient_merged on a tombstone). Tooth records carry no
 * branch: the chart is patient-level (any clinician with a branch scope reads every condition and
 * may chart / supersede encounter-less rows), but rows charted inside an encounter outside the
 * caller's scope come back redacted (no notes, no encounterId), and charting inside an encounter
 * or retiring a row charted inside one is checked at that encounter's branch. A non-org-wide principal without any branch gets 403. Audited (ids only).
 */
@Injectable()
export class PatientClinicalService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return guarded(() => withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }));
  }

  /** Optional encounter of a chart/supersede: same patient, OPEN, clinical:write at its branch. */
  private async chartingEncounter(tx: Tx, p: Principal, patientId: string, id?: string) {
    odontogramScope(p); // 403 without any branch, with or without an encounter
    if (!id) return null;
    const enc = await loadEncounter(tx, id);
    assertCan(p, "clinical:write", { branchId: enc.branchId });
    if (enc.patientId !== patientId)
      throw new BadRequestException({ error: "encounter_patient_mismatch" });
    assertOpen(enc);
    return enc;
  }

  /**
   * A row charted inside an encounter belongs to that encounter's branch: retiring it needs
   * clinical:write there (403), like charting into that encounter. Encounter-less rows stay
   * patient-level (any clinician with a branch). Pending an ADR 0003 §2.1 ruling (flagged).
   */
  private assertRowsWritable(p: Principal, rows: { encounter: { branchId: string } | null }[]) {
    for (const r of rows)
      if (r.encounter) assertCan(p, "clinical:write", { branchId: r.encounter.branchId });
  }

  /** Marks CURRENT rows of the lineage HISTORICAL; all-or-nothing (409 if any is not CURRENT). */
  private async supersedeRows(tx: Tx, p: Principal, lineage: string[], ids: string[]) {
    if (ids.length === 0) return;
    const r = await tx.toothRecord.updateMany({
      where: { id: { in: ids }, patientId: { in: lineage }, status: "CURRENT" },
      data: { status: "HISTORICAL", supersededAt: new Date(), supersededBy: p.userId },
    });
    if (r.count !== ids.length) throw new ConflictException({ error: "tooth_record_not_current" });
  }

  // ------------------------------------------------------------------------------------------
  // Odontogram
  // ------------------------------------------------------------------------------------------

  /** Batch charting: inserts new CURRENT rows and retires the rows they supersede, atomically. */
  async chart(p: Principal, patientId: string, body: ChartTeethRequest) {
    const supersedes = body.records.flatMap((r) => (r.supersedesId ? [r.supersedesId] : []));
    if (new Set(supersedes).size !== supersedes.length)
      throw new BadRequestException({ error: "duplicate_supersedes" });
    const { rows, branchId } = await this.tx(p, async (tx) => {
      await findActivePatient(tx, patientId);
      const enc = await this.chartingEncounter(tx, p, patientId, body.encounterId);
      const lineage = await lineageIds(tx, patientId);
      if (supersedes.length > 0) {
        const old = await tx.toothRecord.findMany({
          where: { id: { in: supersedes }, patientId: { in: lineage } },
          select: { id: true, toothCode: true, status: true, ...TOOTH_ENCOUNTER_BRANCH },
        });
        this.assertRowsWritable(p, old);
        const byId = new Map(old.map((o) => [o.id, o]));
        for (const r of body.records) {
          if (!r.supersedesId) continue;
          const o = byId.get(r.supersedesId);
          if (!o) throw new NotFoundException({ error: "tooth_record_not_found" });
          if (o.status !== "CURRENT")
            throw new ConflictException({ error: "tooth_record_not_current" });
          if (o.toothCode !== r.toothCode)
            throw new BadRequestException({ error: "supersede_tooth_mismatch" });
        }
      }
      await this.supersedeRows(tx, p, lineage, supersedes);
      const now = new Date();
      const rows = [];
      for (const r of body.records) {
        rows.push(
          await tx.toothRecord.create({
            data: {
              tenantId: p.tenantId,
              patientId,
              encounterId: enc?.id ?? null,
              toothCode: r.toothCode,
              dentition: dentitionOf(r.toothCode),
              condition: r.condition,
              surfaces: r.surfaces,
              notes: r.notes || null,
              recordedBy: p.userId,
              recordedAt: now,
            },
          }),
        );
      }
      return { rows, branchId: enc?.branchId };
    });
    await this.audit.record(p, {
      action: "clinical.odontogram.chart",
      resource: "patient",
      resourceId: patientId,
      branchId,
      outcome: "success",
    });
    return { items: rows.map(toTooth) };
  }

  /** Retires CURRENT rows without a replacement (charted in error). The reason is not stored. */
  async supersede(p: Principal, patientId: string, body: SupersedeToothRecordsRequest) {
    const ids = [...new Set(body.recordIds)];
    const { rows, branchId } = await this.tx(p, async (tx) => {
      await findActivePatient(tx, patientId);
      const enc = await this.chartingEncounter(tx, p, patientId, body.encounterId);
      const lineage = await lineageIds(tx, patientId);
      const found = await tx.toothRecord.findMany({
        where: { id: { in: ids }, patientId: { in: lineage } },
        select: { id: true, ...TOOTH_ENCOUNTER_BRANCH },
      });
      if (found.length !== ids.length)
        throw new NotFoundException({ error: "tooth_record_not_found" });
      this.assertRowsWritable(p, found);
      await this.supersedeRows(tx, p, lineage, ids);
      const rows = await tx.toothRecord.findMany({
        where: { id: { in: ids } },
        include: TOOTH_ENCOUNTER_BRANCH,
      });
      return { rows, branchId: enc?.branchId };
    });
    await this.audit.record(p, {
      action: "clinical.odontogram.supersede",
      resource: "patient",
      resourceId: patientId,
      branchId,
      outcome: "success",
    });
    return { items: rows.map(toVisibleTooth(branchFilter(p))) };
  }

  /** CURRENT rows (optionally full history, optionally as of an instant) across the lineage. */
  async odontogram(
    p: Principal,
    patientId: string,
    q: OdontogramQuery,
  ): Promise<OdontogramResponse> {
    const asOf = q.asOf ? new Date(q.asOf) : new Date();
    const scope = odontogramScope(p);
    const rows = await this.tx(p, async (tx) => {
      await findPatientOr404(tx, patientId);
      const lineage = await lineageIds(tx, patientId);
      const where: Prisma.ToothRecordWhereInput = { patientId: { in: lineage } };
      if (q.asOf) {
        where.recordedAt = { lte: asOf };
        if (!q.includeHistory) where.OR = [{ supersededAt: null }, { supersededAt: { gt: asOf } }];
      } else if (!q.includeHistory) {
        where.status = "CURRENT";
      }
      return tx.toothRecord.findMany({
        where,
        include: TOOTH_ENCOUNTER_BRANCH,
        orderBy: [{ toothCode: "asc" }, { recordedAt: "asc" }, { id: "asc" }],
      });
    });
    await this.audit.record(p, {
      action: "clinical.odontogram.read",
      resource: "patient",
      resourceId: patientId,
      outcome: "success",
    });
    return { patientId, asOf: asOf.toISOString(), records: rows.map(toVisibleTooth(scope)) };
  }

  // ------------------------------------------------------------------------------------------
  // Clinical workspace context (PRD 3.4)
  // ------------------------------------------------------------------------------------------

  /**
   * Patient header + health data + encounters + odontogram in one audited read. Allergies,
   * alerts and medical history need medical:read (empty/null otherwise); plans need plan:read and
   * are restricted to the caller's branches; encounters to the caller's clinical scope (and to
   * `branchId` when given).
   */
  async context(
    p: Principal,
    patientId: string,
    branchId?: string,
  ): Promise<ClinicalContextResponse> {
    if (branchId) assertCan(p, "clinical:read", { branchId });
    const scope = branchFilter(p);
    const medical = can(p, "medical:read");
    const plans = can(p, "plan:read");
    const r = await this.tx(p, async (tx) => {
      const patient = await findPatientOr404(tx, patientId);
      const lineage = await lineageIds(tx, patientId);
      const inLineage = { patientId: { in: lineage } };
      const encScope: Prisma.EncounterWhereInput[] = [
        inLineage,
        branchWhere(p),
        ...(branchId ? [{ branchId }] : []),
      ];
      const [alerts, allergies, history, open, recent, activePlans, teeth] = await Promise.all([
        medical
          ? tx.patientAlert.findMany({
              where: { ...inLineage, active: true },
              orderBy: { createdAt: "desc" },
            })
          : [],
        medical
          ? tx.patientAllergy.findMany({
              where: { ...inLineage, active: true },
              orderBy: { notedAt: "desc" },
            })
          : [],
        medical
          ? tx.patientMedicalHistory.findFirst({
              where: inLineage,
              orderBy: [{ recordedAt: "desc" }, { version: "desc" }],
            })
          : null,
        tx.encounter.findMany({
          where: { AND: [...encScope, { status: "OPEN" }] },
          orderBy: { openedAt: "desc" },
        }),
        tx.encounter.findMany({
          where: { AND: [...encScope, { status: "SIGNED" }] },
          orderBy: { signedAt: "desc" },
          take: RECENT_SIGNED_ENCOUNTERS,
        }),
        plans
          ? tx.treatmentPlan.findMany({
              where: {
                AND: [
                  inLineage,
                  branchWhere(p),
                  { status: { notIn: [...TERMINAL_PLAN_STATUSES] } },
                ],
              },
              select: { id: true, title: true, status: true },
              orderBy: { createdAt: "desc" },
            })
          : [],
        // Same rule as GET odontogram; no branch at all = no chart (instead of a 403 here).
        scope?.length === 0
          ? []
          : tx.toothRecord.findMany({
              where: { ...inLineage, status: "CURRENT" },
              include: TOOTH_ENCOUNTER_BRANCH,
              orderBy: [{ toothCode: "asc" }, { recordedAt: "asc" }],
            }),
      ]);
      return { patient, alerts, allergies, history, open, recent, activePlans, teeth };
    });
    await this.audit.record(p, {
      action: "clinical.context.read",
      resource: "patient",
      resourceId: patientId,
      branchId,
      outcome: "success",
    });
    return {
      patient: toSummary(r.patient),
      alerts: r.alerts.map(
        (a): AlertResponse => ({
          id: a.id,
          title: a.title,
          details: a.details,
          severity: a.severity,
          active: a.active,
          createdBy: a.createdBy,
          createdAt: a.createdAt.toISOString(),
          resolvedAt: a.resolvedAt?.toISOString() ?? null,
        }),
      ),
      allergies: r.allergies.map(
        (a): AllergyResponse => ({
          id: a.id,
          substance: a.substance,
          reaction: a.reaction,
          severity: a.severity,
          active: a.active,
          notedBy: a.notedBy,
          notedAt: a.notedAt.toISOString(),
          resolvedAt: a.resolvedAt?.toISOString() ?? null,
        }),
      ),
      latestMedicalHistory: r.history
        ? ({
            id: r.history.id,
            patientId: r.history.patientId,
            version: r.history.version,
            medical: r.history.medical,
            dental: r.history.dental,
            medications: r.history.medications,
            notes: r.history.notes,
            recordedBy: r.history.recordedBy,
            recordedAt: r.history.recordedAt.toISOString(),
          } as MedicalHistoryResponse)
        : null,
      openEncounters: r.open.map(toEncounter),
      recentEncounters: r.recent.map(toEncounter),
      activePlans: r.activePlans,
      odontogram: r.teeth.map(toVisibleTooth(scope)),
    };
  }
}
