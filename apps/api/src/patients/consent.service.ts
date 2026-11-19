import {
  type CommunicationPreference,
  type PatientConsent,
  PrismaClient,
  withTenant,
} from "@dentalos/db";
import type {
  ConsentResponse,
  RecordConsentRequest,
  SetCommunicationPreferencesRequest,
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
import { assertCan } from "../common/principal";
import { findActivePatient, findPatientOr404, lineageIds } from "./patient-common";

const toConsent = (c: PatientConsent): ConsentResponse & { branchId: string | null } => ({
  id: c.id,
  type: c.type,
  version: c.version,
  status: c.status,
  method: c.method,
  documentId: c.documentId,
  capturedBy: c.capturedBy,
  grantedAt: c.grantedAt?.toISOString() ?? null,
  withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
  branchId: c.branchId,
});

const toPref = (c: CommunicationPreference) => ({
  channel: c.channel,
  purpose: c.purpose,
  optIn: c.optIn,
  updatedBy: c.updatedBy,
  updatedAt: c.updatedAt.toISOString(),
});

/**
 * Consent (PRD 7.7: capture, versioning, evidence, withdrawal) and communication preferences.
 * consent:manage is branch-scoped: checked against the branch where consent is captured/withdrawn.
 * Every capture is a new row (history); withdrawal flips status on that row, never deletes.
 */
@Injectable()
export class ConsentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** All consents for the patient (consent applies to the shared profile across branches). */
  async list(p: Principal, patientId: string) {
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      await findPatientOr404(tx, patientId);
      // Plan-version consents of merged records stay on the merged id: read the lineage.
      return tx.patientConsent.findMany({
        where: { patientId: { in: await lineageIds(tx, patientId) } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
    });
    return { items: rows.map(toConsent) };
  }

  async record(p: Principal, patientId: string, body: RecordConsentRequest) {
    // A branch-restricted user must capture at a branch (else the branch check would be vacuous);
    // with a single branch in scope it is implied.
    const branchId =
      body.branchId ?? (!p.orgWide && p.branchScope.length === 1 ? p.branchScope[0] : undefined);
    if (!p.orgWide && !branchId)
      throw new BadRequestException({
        error: "validation_failed",
        issues: [{ path: "branchId", message: "Branch required" }],
      });
    assertCan(p, "consent:manage", { branchId });
    const c = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        if (branchId && !(await tx.branch.findUnique({ where: { id: branchId } })))
          throw new NotFoundException({ error: "branch_not_found" });
        if (
          body.documentId &&
          !(await tx.patientDocument.findFirst({ where: { id: body.documentId, patientId } }))
        )
          throw new NotFoundException({ error: "document_not_found" });
        return tx.patientConsent.create({
          data: {
            tenantId: p.tenantId,
            patientId,
            branchId,
            type: body.type,
            version: body.version,
            status: body.status,
            method: body.method,
            documentId: body.documentId,
            capturedBy: p.userId,
            grantedAt: body.status === "GRANTED" ? new Date() : null,
          },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: body.status === "GRANTED" ? "patient.consent.grant" : "patient.consent.decline",
      resource: "patient_consent",
      resourceId: c.id,
      branchId,
      outcome: "success",
    });
    return toConsent(c);
  }

  /** Only a GRANTED consent can be withdrawn. The reason is stored as `withdrawalReason`. */
  async withdraw(p: Principal, patientId: string, consentId: string, reason?: string) {
    const c = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        const cur = await tx.patientConsent.findFirst({ where: { id: consentId, patientId } });
        if (!cur) throw new NotFoundException({ error: "consent_not_found" });
        assertCan(p, "consent:manage", { branchId: cur.branchId ?? undefined });
        if (cur.status !== "GRANTED")
          throw new ConflictException({ error: "consent_not_granted", status: cur.status });
        return tx.patientConsent.update({
          where: { id: consentId },
          data: { status: "WITHDRAWN", withdrawnAt: new Date(), withdrawalReason: reason ?? null },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.consent.withdraw",
      resource: "patient_consent",
      resourceId: consentId,
      branchId: c.branchId ?? undefined,
      outcome: "success",
    });
    return toConsent(c);
  }

  async preferences(p: Principal, patientId: string) {
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      await findPatientOr404(tx, patientId);
      return tx.communicationPreference.findMany({
        where: { patientId },
        orderBy: [{ channel: "asc" }, { purpose: "asc" }],
      });
    });
    return { items: rows.map(toPref) };
  }

  /** Upserts one row per (channel, purpose); channels not mentioned are left unchanged. */
  async setPreferences(p: Principal, patientId: string, body: SetCommunicationPreferencesRequest) {
    const rows = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findActivePatient(tx, patientId);
        for (const pref of body.preferences) {
          await tx.communicationPreference.upsert({
            where: {
              tenantId_patientId_channel_purpose: {
                tenantId: p.tenantId,
                patientId,
                channel: pref.channel,
                purpose: pref.purpose,
              },
            },
            create: {
              tenantId: p.tenantId,
              patientId,
              channel: pref.channel,
              purpose: pref.purpose,
              optIn: pref.optIn,
              updatedBy: p.userId,
            },
            update: { optIn: pref.optIn, updatedBy: p.userId },
          });
        }
        return tx.communicationPreference.findMany({
          where: { patientId },
          orderBy: [{ channel: "asc" }, { purpose: "asc" }],
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "patient.communication_preferences.update",
      resource: "patient",
      resourceId: patientId,
      outcome: "success",
    });
    return { items: rows.map(toPref) };
  }
}
