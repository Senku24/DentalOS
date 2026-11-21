import { type Prisma, PrismaClient } from "@dentalos/db";
import {
  type BillingSettingsResponse,
  type UpdateServiceTaxProfileRequest,
  branchSettings,
  resolveBillingSettings,
  tenantSettings,
  updateBranchBillingSettingsRequest,
  updateTenantBillingSettingsRequest,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan, withBranchScope } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { badRequest, notFound, runTx } from "./billing-common";

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Billing knobs per tenant / branch (ADR 0004 §10) and the GST classification of services. */
@Injectable()
export class BillingSettingsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async get(p: Principal, branchId?: string): Promise<BillingSettingsResponse> {
    return runTx(this.prisma, p, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: p.tenantId } });
      if (!branchId) {
        return {
          branchId: null,
          stored: asObject(asObject(tenant?.settings).billing),
          effective: resolveBillingSettings(tenant?.settings),
        };
      }
      assertCan(p, "billing:read", { branchId });
      const branch = await tx.branch.findFirst({
        where: withBranchScope(p, { id: branchId }, "id"),
      });
      if (!branch) throw notFound("branch_not_found");
      return {
        branchId,
        stored: asObject(asObject(branch.settings).billing),
        effective: resolveBillingSettings(tenant?.settings, branch.settings),
      };
    });
  }

  /** Merges the given keys into the stored section and re-validates the whole settings object. */
  async update(p: Principal, branchId: string | undefined, rawBody: unknown) {
    assertCan(p, branchId ? "branch:manage" : "org:manage", branchId ? { branchId } : {});
    const body = branchId
      ? new ZodPipe(updateBranchBillingSettingsRequest).transform(rawBody)
      : new ZodPipe(updateTenantBillingSettingsRequest).transform(rawBody);
    await runTx(this.prisma, p, async (tx) => {
      if (branchId) {
        const branch = await tx.branch.findUnique({ where: { id: branchId } });
        if (!branch) throw notFound("branch_not_found");
        const cur = asObject(branch.settings);
        const next = { ...cur, billing: { ...asObject(cur.billing), ...body } };
        const ok = branchSettings.safeParse(next);
        if (!ok.success) throw badRequest("validation_failed");
        await tx.branch.update({
          where: { id: branchId },
          data: { settings: next as Prisma.InputJsonValue },
        });
      } else {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: p.tenantId } });
        const cur = asObject(tenant.settings);
        const next = { ...cur, billing: { ...asObject(cur.billing), ...body } };
        const ok = tenantSettings.safeParse(next);
        if (!ok.success) throw badRequest("validation_failed");
        await tx.tenant.update({
          where: { id: p.tenantId },
          data: { settings: next as Prisma.InputJsonValue },
        });
      }
    });
    await this.audit.record(p, {
      action: "billing.settings.update",
      resource: "billing_settings",
      resourceId: branchId ?? p.tenantId,
      branchId,
      outcome: "success",
    });
    return this.get(p, branchId);
  }

  async updateTaxProfile(p: Principal, serviceId: string, body: UpdateServiceTaxProfileRequest) {
    const s = await runTx(this.prisma, p, async (tx) => {
      const svc = await tx.service.findUnique({ where: { id: serviceId } });
      if (!svc) throw notFound("service_not_found");
      return tx.service.update({
        where: { id: serviceId },
        data: {
          ...(body.hsnSac !== undefined ? { hsnSac: body.hsnSac } : {}),
          ...(body.gstRateBp !== undefined ? { gstRateBp: body.gstRateBp } : {}),
        },
      });
    });
    await this.audit.record(p, {
      action: "service.tax_profile.update",
      resource: "service",
      resourceId: serviceId,
      outcome: "success",
    });
    return {
      serviceId: s.id,
      code: s.code,
      name: s.name,
      taxable: s.taxable,
      hsnSac: s.hsnSac,
      gstRateBp: s.gstRateBp,
    };
  }
}
