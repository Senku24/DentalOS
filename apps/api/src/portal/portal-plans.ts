import {
  type PatientConsent,
  type PlanItemStatus,
  PrismaClient,
  type TreatmentPlan,
  type TreatmentPlanStatus,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  PORTAL_DECIDABLE_ITEM_STATUSES,
  type PortalConsentListResponse,
  type PortalPlanDecisionRequest,
  type PortalPlanResponse,
  type PortalSignConsentRequest,
  type PortalSignConsentResponse,
  computeInvoiceTotals,
  lineTaxRateBp,
  parseDraftContent,
  planTotals,
  portalConsentTextHash,
  portalPlanDecisionRequest,
  portalSignConsentRequest,
  resolveClinicalSettings,
  resolvePortalSettings,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { PRISMA } from "../auth/auth.guard";
import { CurrentPatient, type PatientPrincipal } from "../auth/patient-principal";
import { PortalAuditService } from "../auth/portal-audit";
import { PORTAL_SECRETS, type PortalSecrets } from "../auth/portal-token";
import { PortalAuth, PortalStepUp } from "../auth/portal.guard";
import { loadBranchSettings } from "../billing/billing-common";
import { isUniqueViolation } from "../common/db-errors";
import { ZodPipe } from "../common/zod.pipe";
import { commitPlanChange, isPlanClosed, loadItems, mapPlanDbError } from "../plans/plan-common";
import { isDecisionTransition } from "../plans/plans.service";
import {
  UUID,
  attribution,
  badRequest,
  clientHashes,
  conflict,
  iso,
  isoOrNull,
  notFound,
  portalTx,
  secretsOr503,
} from "./portal-common";

/** Plans a patient may see: never DRAFT (not presented yet) nor CANCELLED. */
const VISIBLE: TreatmentPlanStatus[] = [
  "PRESENTED",
  "ACCEPTED",
  "PARTIALLY_ACCEPTED",
  "REJECTED",
  "COMPLETED",
];
const NEEDS_CONSENT: TreatmentPlanStatus[] = ["ACCEPTED", "PARTIALLY_ACCEPTED"];
const DECIDABLE = PORTAL_DECIDABLE_ITEM_STATUSES as readonly PlanItemStatus[];

/** The active treatment-plan consent template (alphabetical by code) with its current text. */
async function currentPlanConsent(tx: Tx) {
  const t = await tx.consentTemplate.findFirst({
    where: { type: "TREATMENT_PLAN", active: true, currentVersion: { gt: 0 } },
    orderBy: { code: "asc" },
  });
  if (!t) return null;
  const v = await tx.consentTemplateVersion.findFirst({
    where: { templateId: t.id, version: t.currentVersion },
  });
  return v ? { template: t, version: v } : null;
}

/**
 * Plans, estimates, per-item decisions and consents in the portal (ADR 0005 §3.4). The writes mirror the staff path of
 * apps/api/src/plans (`PlansService.decide` / `approve`, `PlanConsentService.sign`) under `withTenant`: same item
 * transition rule (`isDecisionTransition`), same versioning (`commitPlanChange`), same approval condition (a GRANTED
 * TREATMENT_PLAN consent on the CURRENT version). The staff services are not exported from their module, so the minimal
 * equivalent writes are repeated here (flagged in the P1 report).
 */
@Injectable()
export class PortalPlansService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(PORTAL_SECRETS) private readonly secrets: PortalSecrets | null,
    private readonly audit: PortalAuditService,
  ) {}

  async list(me: PatientPrincipal) {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const plans = await tx.treatmentPlan.findMany({
        where: { patientId: { in: me.patientIds }, status: { in: VISIBLE } },
        include: { branch: { select: { id: true, name: true } } },
        orderBy: [{ presentedAt: "desc" }, { id: "desc" }],
        take: 100,
      });
      const items = plans.length
        ? await tx.planItem.findMany({ where: { planId: { in: plans.map((p) => p.id) } } })
        : [];
      return {
        items: plans.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          version: p.currentVersion,
          presentedAt: isoOrNull(p.presentedAt),
          estimatePaise: planTotals(items.filter((i) => i.planId === p.id)).estimatePaise,
          branch: p.branch,
        })),
      };
    });
  }

  async get(me: PatientPrincipal, id: string): Promise<PortalPlanResponse> {
    return withTenant(this.prisma, me.tenantId, (tx) => this.build(tx, me, id));
  }

  private async build(tx: Tx, me: PatientPrincipal, id: string): Promise<PortalPlanResponse> {
    const plan = await tx.treatmentPlan.findFirst({
      where: { id, patientId: { in: me.patientIds }, status: { in: VISIBLE } },
      include: { branch: { select: { id: true, name: true } } },
    });
    if (!plan) throw notFound("plan_not_found");
    const all = await loadItems(tx, plan.id);
    const items = all.filter((i) => i.status !== "CANCELLED");
    const totals = planTotals(all);
    const portal = resolvePortalSettings(
      (await tx.tenant.findUnique({ where: { id: me.tenantId }, select: { settings: true } }))
        ?.settings,
    );
    const open = !isPlanClosed(plan) && plan.patientId === me.patientId;

    // GST exactly as the staff estimate computes it (frozen prices, branch billing settings).
    const { settings: billing } = await loadBranchSettings(tx, me.tenantId, plan.branchId);
    const services = await tx.service.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.serviceId))] } },
      select: { id: true, taxable: true, gstRateBp: true },
    });
    const svc = new Map(services.map((s) => [s.id, s]));
    const counted = items.filter((i) => i.status !== "REJECTED");
    const est = computeInvoiceTotals({
      lines: counted.map((i) => ({
        quantity: i.quantity,
        unitPricePaise: i.estimatePricePaise,
        taxRateBp: lineTaxRateBp(svc.get(i.serviceId), billing.defaultGstRateBp),
      })),
      taxInclusive: billing.taxInclusive,
      interState: false,
    });

    // Dentist-approved explanation only (an unapproved draft is never visible to the patient).
    const versions = await tx.treatmentPlanVersion.findMany({
      where: { planId: plan.id },
      select: { id: true, version: true },
    });
    const draft = versions.length
      ? await tx.aiDraft.findFirst({
          where: {
            kind: "PLAN_EXPLANATION",
            status: "APPROVED",
            patientId: plan.patientId,
            planVersionId: { in: versions.map((v) => v.id) },
          },
          orderBy: [{ reviewedAt: "desc" }, { createdAt: "desc" }],
        })
      : null;
    const parsed = draft ? parseDraftContent("PLAN_EXPLANATION", draft.content) : null;
    const explanation =
      draft && parsed?.success
        ? {
            text: (parsed.data as { text: string }).text,
            aiGenerated: true as const,
            approvedAt: iso(draft.reviewedAt ?? draft.createdAt),
          }
        : null;

    // Consent still to sign (current plan version has none), when the clinic requires one.
    let consentRequired: PortalPlanResponse["consentRequired"] = null;
    if (
      portal.requirePlanConsent &&
      (plan.status === "PRESENTED" || NEEDS_CONSENT.includes(plan.status))
    ) {
      const cur = await currentPlanConsent(tx);
      const pv = versions.find((v) => v.version === plan.currentVersion);
      if (cur && pv) {
        const signed =
          (await tx.patientConsent.count({
            where: {
              patientId: { in: me.patientIds },
              type: "TREATMENT_PLAN",
              status: "GRANTED",
              planVersionId: pv.id,
            },
          })) > 0;
        consentRequired = {
          templateVersionId: cur.version.id,
          title: cur.template.title,
          signed,
        };
      }
    }

    return {
      id: plan.id,
      title: plan.title,
      status: plan.status,
      version: plan.currentVersion,
      presentedAt: isoOrNull(plan.presentedAt),
      estimatePaise: totals.estimatePaise,
      branch: plan.branch,
      items: items.map((i) => ({
        id: i.id,
        serviceName: i.service.name,
        toothLabel: i.toothCode === null ? null : `Tooth ${i.toothCode}`,
        quantity: i.quantity,
        unitEstimatePaise: i.estimatePricePaise,
        estimatePaise: i.estimatePricePaise * i.quantity,
        status: i.status,
        canDecide: open && DECIDABLE.includes(i.status),
      })),
      totals: {
        estimatePaise: totals.estimatePaise,
        acceptedPaise: totals.acceptedPaise,
        pendingPaise: totals.pendingPaise,
      },
      estimate: {
        taxInclusive: billing.taxInclusive,
        subtotalPaise: est.subtotalPaise,
        taxPaise: est.taxPaise,
        totalPaise: est.totalPaise,
      },
      explanation,
      consentRequired,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Decisions (route needs a fresh step-up)
  // -------------------------------------------------------------------------------------------

  async decide(
    me: PatientPrincipal,
    planId: string,
    body: PortalPlanDecisionRequest,
    req: Request,
  ): Promise<PortalPlanResponse> {
    const sec = secretsOr503(this.secrets);
    const hashes = await clientHashes(req, sec.pepper);
    const ids = body.decisions.map((d) => d.planItemId);
    if (new Set(ids).size !== ids.length) throw badRequest("duplicate_plan_item");
    const hasAccept = body.decisions.some((d) => d.decision === "ACCEPTED");

    const out = await portalTx(this.prisma, me, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TreatmentPlan" WHERE "id" = ${planId}::uuid FOR UPDATE`;
      const plan = await tx.treatmentPlan.findFirst({
        where: { id: planId, patientId: { in: me.patientIds }, status: { in: VISIBLE } },
      });
      if (!plan) throw notFound("plan_not_found");
      if (plan.patientId !== me.patientId)
        throw conflict("patient_merged", { message: "This record was merged; contact the clinic" });
      if (isPlanClosed(plan)) throw conflict("plan_closed", { status: plan.status });
      if (body.planVersion !== plan.currentVersion)
        throw conflict("plan_version_stale", { currentVersion: plan.currentVersion });
      const settings = resolvePortalSettings(
        (await tx.tenant.findUnique({ where: { id: me.tenantId }, select: { settings: true } }))
          ?.settings,
      );
      if (hasAccept && settings.requirePlanConsent) {
        if (!body.signature || !body.consentTemplateVersionId || !body.consentBodySha256)
          throw conflict("consent_required", {
            message:
              "Accepting needs the consent text hash, its template version and a typed-name signature",
          });
      }
      const items = new Map(
        (await tx.planItem.findMany({ where: { planId } })).map((i) => [i.id, i]),
      );
      const now = new Date();
      const counts: Record<string, number> = {};
      for (const d of body.decisions) {
        const item = items.get(d.planItemId);
        if (!item) throw notFound("plan_item_not_found");
        if (!DECIDABLE.includes(item.status) || !isDecisionTransition(item.status, d.decision))
          throw conflict("invalid_transition", {
            itemId: item.id,
            from: item.status,
            to: d.decision,
          });
        await tx.planItem.update({
          where: { id: item.id },
          data: {
            status: d.decision,
            decidedAt: now,
            decidedBy: me.actorId,
            decisionReason: d.reason || null,
          },
        });
        counts[d.decision] = (counts[d.decision] ?? 0) + 1;
      }
      const summary = Object.entries(counts)
        .map(([k, n]) => `${n} ${k.toLowerCase()}`)
        .join(", ");
      await commitPlanChange(tx, attribution(me), planId, `Patient decisions (portal): ${summary}`);

      // The consent is signed against the version the patient's decisions produced (same order as the staff flow:
      // decide -> sign on the CURRENT version -> approve).
      let consent: PatientConsent | null = null;
      if (body.signature && body.consentTemplateVersionId && body.consentBodySha256 && hasAccept) {
        const fresh = await tx.treatmentPlan.findUniqueOrThrow({ where: { id: planId } });
        const pv = await tx.treatmentPlanVersion.findFirstOrThrow({
          where: { planId, version: fresh.currentVersion },
        });
        consent = await this.signConsent(tx, me, hashes, {
          templateVersionId: body.consentTemplateVersionId,
          planVersionId: pv.id,
          bodySha256: body.consentBodySha256,
          typedName: body.signature.typedName,
        });
      }
      const approved = await this.approveIfComplete(tx, me, planId, consent?.id ?? null, settings);
      return { consentId: consent?.id ?? null, approved, branchId: plan.branchId };
    }).catch(mapPlanDbError);

    await this.audit.record(me, {
      action: "portal.plan.decide",
      resource: "treatment_plan",
      resourceId: planId,
      branchId: out.branchId,
      outcome: "success",
    });
    if (out.consentId)
      await this.audit.record(me, {
        action: "portal.consent.sign",
        resource: "patient_consent",
        resourceId: out.consentId,
        branchId: out.branchId,
        outcome: "success",
      });
    return this.get(me, planId);
  }

  /** Staff `approve` condition: ACCEPTED / PARTIALLY_ACCEPTED, and a GRANTED consent on the current version when required. */
  private async approveIfComplete(
    tx: Tx,
    me: PatientPrincipal,
    planId: string,
    consentId: string | null,
    portal: { requirePlanConsent: boolean },
  ): Promise<boolean> {
    const plan = await tx.treatmentPlan.findUniqueOrThrow({ where: { id: planId } });
    if (!NEEDS_CONSENT.includes(plan.status)) return false;
    const pv = await tx.treatmentPlanVersion.findFirstOrThrow({
      where: { planId, version: plan.currentVersion },
    });
    if (plan.approvedAt && plan.approvedAt >= pv.createdAt) return false;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: me.tenantId } });
    const needsConsent =
      portal.requirePlanConsent ||
      resolveClinicalSettings(tenant.settings).requirePlanConsentForApproval;
    if (needsConsent) {
      const has =
        consentId !== null ||
        (await tx.patientConsent.count({
          where: {
            patientId: plan.patientId,
            type: "TREATMENT_PLAN",
            status: "GRANTED",
            planVersionId: pv.id,
          },
        })) > 0;
      if (!has) return false;
    }
    await tx.treatmentPlan.update({
      where: { id: planId },
      data: { approvedAt: new Date(), approvedBy: me.actorId },
    });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Consents
  // -------------------------------------------------------------------------------------------

  async consents(me: PatientPrincipal): Promise<PortalConsentListResponse> {
    return withTenant(this.prisma, me.tenantId, async (tx) => {
      const cur = await currentPlanConsent(tx);
      const pending: PortalConsentListResponse["pending"] = [];
      if (cur) {
        const plans = await tx.treatmentPlan.findMany({
          where: {
            patientId: { in: me.patientIds },
            status: { in: ["PRESENTED", ...NEEDS_CONSENT] },
          },
          orderBy: { id: "asc" },
          take: 20,
        });
        const bodySha256 = await portalConsentTextHash(cur.version.body);
        for (const p of plans) {
          const pv = await tx.treatmentPlanVersion.findFirst({
            where: { planId: p.id, version: p.currentVersion },
          });
          if (!pv) continue;
          const signed = await tx.patientConsent.count({
            where: {
              patientId: { in: me.patientIds },
              type: "TREATMENT_PLAN",
              status: "GRANTED",
              planVersionId: pv.id,
            },
          });
          if (signed > 0) continue;
          pending.push({
            templateVersionId: cur.version.id,
            type: cur.template.type,
            title: cur.template.title,
            body: cur.version.body,
            bodySha256,
            planVersionId: pv.id,
            planTitle: p.title,
          });
        }
      }
      const rows = await tx.patientConsent.findMany({
        where: { patientId: { in: me.patientIds }, status: "GRANTED" },
        include: { templateVersion: { select: { template: { select: { title: true } } } } },
        orderBy: [{ grantedAt: "desc" }, { id: "desc" }],
        take: 100,
      });
      return {
        pending,
        signed: rows.map((c) => ({
          consentId: c.id,
          type: c.type,
          title: c.templateVersion?.template.title ?? null,
          signedAt: iso(c.grantedAt ?? c.createdAt),
          typedName: c.signerName,
        })),
      };
    });
  }

  async sign(
    me: PatientPrincipal,
    body: PortalSignConsentRequest,
    req: Request,
  ): Promise<PortalSignConsentResponse> {
    const sec = secretsOr503(this.secrets);
    const hashes = await clientHashes(req, sec.pepper);
    if (!body.planVersionId) throw badRequest("plan_version_required");
    const out = await portalTx(this.prisma, me, async (tx) => {
      const consent = await this.signConsent(tx, me, hashes, {
        templateVersionId: body.templateVersionId,
        planVersionId: body.planVersionId as string,
        bodySha256: body.bodySha256,
        typedName: body.signature.typedName,
      });
      const pv = await tx.treatmentPlanVersion.findUniqueOrThrow({
        where: { id: body.planVersionId as string },
      });
      const settings = resolvePortalSettings(
        (await tx.tenant.findUnique({ where: { id: me.tenantId }, select: { settings: true } }))
          ?.settings,
      );
      await tx.$queryRaw`SELECT "id" FROM "TreatmentPlan" WHERE "id" = ${pv.planId}::uuid FOR UPDATE`;
      await this.approveIfComplete(tx, me, pv.planId, consent.id, settings);
      return consent;
    }).catch(mapPlanDbError);
    await this.audit.record(me, {
      action: "portal.consent.sign",
      resource: "patient_consent",
      resourceId: out.id,
      outcome: "success",
    });
    return { consentId: out.id, signedAt: iso(out.grantedAt ?? out.createdAt) };
  }

  /**
   * PatientConsent (DIGITAL, GRANTED) + the append-only `PortalConsentSignature` evidence row, in the caller's transaction.
   * The server recomputes the text hash (never trusts a client hash) and refuses a text that moved.
   */
  private async signConsent(
    tx: Tx,
    me: PatientPrincipal,
    hashes: { ipHash: string | null; uaHash: string | null },
    i: { templateVersionId: string; planVersionId: string; bodySha256: string; typedName: string },
  ): Promise<PatientConsent> {
    if (!me.stepUpAt) throw new ForbiddenException({ error: "step_up_required" });
    // The signature FK ties account, patient and consent together: after a merge the account still belongs to the
    // original record, so signing happens only on an un-merged one (the clinic re-invites on the surviving record).
    if (me.patientId !== me.accountPatientId)
      throw conflict("patient_merged", { message: "This record was merged; contact the clinic" });
    const tv = await tx.consentTemplateVersion.findUnique({
      where: { id: i.templateVersionId },
      include: { template: true },
    });
    if (!tv) throw notFound("template_version_not_found");
    if (!tv.template.active || tv.template.type !== "TREATMENT_PLAN")
      throw conflict("consent_not_applicable");
    if (tv.version !== tv.template.currentVersion)
      throw conflict("template_version_outdated", { currentVersion: tv.template.currentVersion });
    if ((await portalConsentTextHash(tv.body)) !== i.bodySha256)
      throw conflict("consent_text_changed");
    const pv = await tx.treatmentPlanVersion.findUnique({ where: { id: i.planVersionId } });
    const plan: TreatmentPlan | null = pv
      ? await tx.treatmentPlan.findFirst({
          where: { id: pv.planId, patientId: me.patientId, status: { in: VISIBLE } },
        })
      : null;
    if (!pv || !plan) throw notFound("plan_version_not_found");
    if (pv.version !== plan.currentVersion)
      throw conflict("plan_version_not_current", { currentVersion: plan.currentVersion });
    const existing = await tx.patientConsent.count({
      where: {
        patientId: me.patientId,
        type: "TREATMENT_PLAN",
        status: "GRANTED",
        planVersionId: pv.id,
      },
    });
    if (existing > 0) throw conflict("already_signed");
    const now = new Date();
    const consent = await tx.patientConsent.create({
      data: {
        tenantId: me.tenantId,
        patientId: me.patientId,
        branchId: plan.branchId,
        type: "TREATMENT_PLAN",
        version: String(tv.version),
        status: "GRANTED",
        method: "DIGITAL",
        capturedBy: me.actorId,
        grantedAt: now,
        templateVersionId: tv.id,
        planVersionId: pv.id,
        signerName: i.typedName,
        signerRelationship: "SELF",
      },
    });
    await tx.portalConsentSignature.create({
      data: {
        tenantId: me.tenantId,
        patientId: me.patientId,
        accountId: me.accountId,
        sessionId: me.sessionId,
        consentId: consent.id,
        typedName: i.typedName,
        bodySha256: i.bodySha256,
        otpVerifiedAt: me.stepUpAt,
        signedAt: now,
        ipHash: hashes.ipHash,
        userAgentHash: hashes.uaHash,
      },
    });
    return consent;
  }
}

void isUniqueViolation;

@Controller("portal")
export class PortalPlansController {
  constructor(private readonly svc: PortalPlansService) {}

  @PortalAuth()
  @Get("plans")
  list(@CurrentPatient() me: PatientPrincipal) {
    return this.svc.list(me);
  }

  @PortalAuth()
  @Get("plans/:id")
  get(@CurrentPatient() me: PatientPrincipal, @Param("id", UUID) id: string) {
    return this.svc.get(me, id);
  }

  @PortalAuth()
  @PortalStepUp()
  @Post("plans/:id/decisions")
  @HttpCode(200)
  decide(
    @CurrentPatient() me: PatientPrincipal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(portalPlanDecisionRequest)) body: PortalPlanDecisionRequest,
    @Req() req: Request,
  ) {
    return this.svc.decide(me, id, body, req);
  }

  @PortalAuth()
  @Get("consents")
  consents(@CurrentPatient() me: PatientPrincipal) {
    return this.svc.consents(me);
  }

  @PortalAuth()
  @PortalStepUp()
  @Post("consents/sign")
  @HttpCode(200)
  sign(
    @CurrentPatient() me: PatientPrincipal,
    @Body(new ZodPipe(portalSignConsentRequest)) body: PortalSignConsentRequest,
    @Req() req: Request,
  ) {
    return this.svc.sign(me, body, req);
  }
}
