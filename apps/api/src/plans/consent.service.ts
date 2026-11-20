import {
  type ConsentTemplate,
  type ConsentTemplateVersion,
  type PatientConsent,
  type Prisma,
  PrismaClient,
  type Tx,
  withTenant,
} from "@dentalos/db";
import type {
  ConsentTemplateResponse,
  ConsentTemplateVersionResponse,
  CreateConsentTemplateRequest,
  ListConsentTemplatesQuery,
  PublishConsentTemplateVersionRequest,
  SignConsentRequest,
  SignedConsentResponse,
  UpdateConsentTemplateRequest,
} from "@dentalos/validation";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, can } from "../auth/roles";
import { isUniqueViolation } from "../common/db-errors";
import { assertCan } from "../common/principal";
import { findActivePatient } from "../patients/patient-common";
import { badRequest, findPlan, mapPlanDbError } from "./plan-common";

type TemplateWithCurrent = ConsentTemplate & { versions: ConsentTemplateVersion[] };

const toTemplate = (
  t: ConsentTemplate,
  currentVersionId: string | null,
): ConsentTemplateResponse & { currentVersionId: string | null } => ({
  id: t.id,
  code: t.code,
  type: t.type,
  title: t.title,
  active: t.active,
  currentVersion: t.currentVersion,
  currentVersionId,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

const toTemplateVersion = (v: ConsentTemplateVersion): ConsentTemplateVersionResponse => ({
  id: v.id,
  templateId: v.templateId,
  version: v.version,
  body: v.body,
  createdBy: v.createdBy,
  createdAt: v.createdAt.toISOString(),
});

export const toSignedConsent = (c: PatientConsent): SignedConsentResponse => ({
  id: c.id,
  type: c.type,
  version: c.version,
  status: c.status,
  method: c.method,
  branchId: c.branchId,
  documentId: c.documentId,
  capturedBy: c.capturedBy,
  grantedAt: c.grantedAt?.toISOString() ?? null,
  withdrawnAt: c.withdrawnAt?.toISOString() ?? null,
  withdrawalReason: c.withdrawalReason,
  templateVersionId: c.templateVersionId,
  planVersionId: c.planVersionId,
  signerName: c.signerName,
  signerRelationship: c.signerRelationship as SignedConsentResponse["signerRelationship"],
});

const withCurrent = { versions: { orderBy: { version: "desc" as const }, take: 1 } };
const fromRow = (t: TemplateWithCurrent) => toTemplate(t, t.versions[0]?.id ?? null);

/**
 * Versioned consent templates (consent:template, org scope — OWNER) and signing a consent against
 * a template version / plan version (consent:manage on the branch). ADR 0003 §4.
 * Template versions are append-only (DB grants); templates are deactivated, never deleted.
 */
@Injectable()
export class PlanConsentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private tx<T>(p: Principal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, p.tenantId, fn, { actorId: p.userId }).catch(mapPlanDbError);
  }

  private record(p: Principal, action: string, resource: string, id: string, branchId?: string) {
    return this.audit.record(p, { action, resource, resourceId: id, branchId, outcome: "success" });
  }

  // -------------------------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------------------------

  async listTemplates(p: Principal, q: ListConsentTemplatesQuery) {
    const rows = await this.tx(p, (tx) =>
      tx.consentTemplate.findMany({
        where: {
          ...(q.type ? { type: q.type } : {}),
          ...(q.active !== undefined ? { active: q.active } : {}),
        },
        include: withCurrent,
        orderBy: [{ code: "asc" }],
      }),
    );
    return { items: rows.map(fromRow) };
  }

  async getTemplate(p: Principal, id: string) {
    return this.tx(p, async (tx) => fromRow(await this.findTemplate(tx, id)));
  }

  /** Creates the template and publishes version 1. */
  async createTemplate(p: Principal, body: CreateConsentTemplateRequest) {
    let res: ReturnType<typeof toTemplate>;
    try {
      res = await withTenant(
        this.prisma,
        p.tenantId,
        async (tx) => {
          const t = await tx.consentTemplate.create({
            data: {
              tenantId: p.tenantId,
              code: body.code,
              type: body.type,
              title: body.title,
              currentVersion: 1,
              createdBy: p.userId,
            },
          });
          const v = await tx.consentTemplateVersion.create({
            data: {
              tenantId: p.tenantId,
              templateId: t.id,
              version: 1,
              body: body.body,
              createdBy: p.userId,
            },
          });
          return toTemplate(t, v.id);
        },
        { actorId: p.userId },
      );
    } catch (e) {
      if (isUniqueViolation(e))
        throw new ConflictException({ error: "template_code_taken", code: body.code });
      throw e;
    }
    await this.record(p, "consent_template.create", "consent_template", res.id);
    return res;
  }

  async updateTemplate(p: Principal, id: string, body: UpdateConsentTemplateRequest) {
    const res = await this.tx(p, async (tx) => {
      await this.lockTemplate(tx, id);
      const data: Prisma.ConsentTemplateUpdateInput = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.active !== undefined) data.active = body.active;
      if (Object.keys(data).length > 0) await tx.consentTemplate.update({ where: { id }, data });
      return fromRow(await this.findTemplate(tx, id));
    });
    await this.record(p, "consent_template.update", "consent_template", id);
    return res;
  }

  setActive(p: Principal, id: string, active: boolean) {
    return this.updateTemplate(p, id, { active });
  }

  async listVersions(p: Principal, id: string) {
    const rows = await this.tx(p, async (tx) => {
      await this.findTemplate(tx, id);
      return tx.consentTemplateVersion.findMany({
        where: { templateId: id },
        orderBy: { version: "desc" },
      });
    });
    return { items: rows.map(toTemplateVersion) };
  }

  /** Publishes version N+1 (append-only); earlier consents keep pointing at their version. */
  async publishVersion(p: Principal, id: string, body: PublishConsentTemplateVersionRequest) {
    const res = await this.tx(p, async (tx) => {
      const t = await this.lockTemplate(tx, id);
      const version = t.currentVersion + 1;
      const v = await tx.consentTemplateVersion.create({
        data: {
          tenantId: p.tenantId,
          templateId: id,
          version,
          body: body.body,
          createdBy: p.userId,
        },
      });
      await tx.consentTemplate.update({ where: { id }, data: { currentVersion: version } });
      return v;
    });
    await this.record(p, "consent_template.publish", "consent_template_version", res.id);
    return toTemplateVersion(res);
  }

  // -------------------------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------------------------

  /**
   * POST /patients/:id/consents/sign. The template must be active and the version its CURRENT one
   * (the patient signs the text in force). TREATMENT_PLAN needs `planVersionId` = the plan's
   * current version; consent:manage is checked on both `branchId` and the plan's branch. The
   * plan version must be this patient's — enforced by the composite FK
   * (tenantId, planVersionId, patientId) -> 409 `plan_version_patient_mismatch`.
   * The signature is an AVAILABLE CONSENT_FORM PatientDocument of the same patient.
   */
  async sign(p: Principal, patientId: string, body: SignConsentRequest) {
    assertCan(p, "consent:manage", { branchId: body.branchId });
    const res = await this.tx(p, async (tx) => {
      await findActivePatient(tx, patientId);
      if (!(await tx.branch.findUnique({ where: { id: body.branchId } })))
        throw new NotFoundException({ error: "branch_not_found" });
      const tv = await tx.consentTemplateVersion.findUnique({
        where: { id: body.templateVersionId },
        include: { template: true },
      });
      if (!tv) throw new NotFoundException({ error: "template_version_not_found" });
      if (!tv.template.active)
        throw new ConflictException({ error: "template_inactive", templateId: tv.templateId });
      if (tv.version !== tv.template.currentVersion)
        throw new ConflictException({
          error: "template_version_outdated",
          currentVersion: tv.template.currentVersion,
        });

      let planVersionId: string | null = null;
      if (tv.template.type === "TREATMENT_PLAN") {
        if (!body.planVersionId)
          throw badRequest("planVersionId", "Required for a TREATMENT_PLAN consent");
        const pv = await tx.treatmentPlanVersion.findUnique({ where: { id: body.planVersionId } });
        if (!pv) throw new NotFoundException({ error: "plan_version_not_found" });
        let plan: Awaited<ReturnType<typeof findPlan>>;
        try {
          plan = await findPlan(tx, p, pv.planId);
        } catch {
          throw new NotFoundException({ error: "plan_version_not_found" });
        }
        assertCan(p, "consent:manage", { branchId: plan.branchId });
        if (plan.status === "CANCELLED" || plan.status === "DRAFT")
          throw new ConflictException({ error: "plan_closed", status: plan.status });
        if (pv.version !== plan.currentVersion)
          throw new ConflictException({
            error: "plan_version_not_current",
            currentVersion: plan.currentVersion,
          });
        planVersionId = pv.id;
      } else if (body.planVersionId) {
        throw badRequest("planVersionId", "Only TREATMENT_PLAN consents link a plan version");
      }

      const doc = await tx.patientDocument.findFirst({
        where: { id: body.signatureDocumentId, patientId },
      });
      // The signer must be able to read the evidence they attach (document:read on its branch).
      if (!doc || doc.status === "DELETED" || !can(p, "document:read", { branchId: doc.branchId }))
        throw new NotFoundException({ error: "document_not_found" });
      if (doc.status !== "AVAILABLE" || doc.category !== "CONSENT_FORM")
        throw new ConflictException({
          error: "invalid_signature_document",
          reason: doc.status !== "AVAILABLE" ? "not_uploaded" : "not_consent_form",
        });

      return tx.patientConsent.create({
        data: {
          tenantId: p.tenantId,
          patientId,
          branchId: body.branchId,
          type: tv.template.type,
          version: String(tv.version),
          status: "GRANTED",
          method: body.method,
          documentId: doc.id,
          capturedBy: p.userId,
          grantedAt: new Date(),
          templateVersionId: tv.id,
          planVersionId,
          signerName: body.signerName ?? null,
          signerRelationship: body.signerRelationship,
        },
      });
    });
    await this.record(p, "patient.consent.sign", "patient_consent", res.id, body.branchId);
    return toSignedConsent(res);
  }

  /** Consents signed against any version of the plan (newest first). */
  async planConsents(p: Principal, planId: string) {
    const res = await this.tx(p, async (tx) => {
      const plan = await findPlan(tx, p, planId);
      assertCan(p, "consent:manage", { branchId: plan.branchId });
      const rows = await tx.patientConsent.findMany({
        where: { planVersion: { planId } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return { rows, branchId: plan.branchId };
    });
    await this.record(p, "plan.consents.read", "treatment_plan", planId, res.branchId);
    return { items: res.rows.map(toSignedConsent) };
  }

  // -------------------------------------------------------------------------------------------

  private async findTemplate(tx: Tx, id: string): Promise<TemplateWithCurrent> {
    const t = await tx.consentTemplate.findUnique({ where: { id }, include: withCurrent });
    if (!t) throw new NotFoundException({ error: "template_not_found" });
    return t;
  }

  private async lockTemplate(tx: Tx, id: string): Promise<ConsentTemplate> {
    await tx.$queryRaw`SELECT "id" FROM "ConsentTemplate" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const t = await tx.consentTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ error: "template_not_found" });
    return t;
  }
}
