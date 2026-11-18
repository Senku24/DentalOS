import { PrismaClient, type Tenant, withTenant } from "@dentalos/db";
import {
  type TenantSettings,
  type UpdateTenantRequest,
  tenantSettings,
  updateTenantRequest,
} from "@dentalos/validation";
import { BadRequestException, Body, Controller, Get, Inject, Patch } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { EventBus } from "../realtime/event-bus";
import { notFound } from "./http";

const toTenant = (t: Tenant) => ({
  id: t.id,
  name: t.name,
  settings: tenantSettings.catch({}).parse(t.settings ?? {}) as TenantSettings,
  onboardingStatus: t.onboardingStatus,
  onboardedAt: t.onboardedAt,
  createdAt: t.createdAt,
});

/** Organisation settings + onboarding (PRD 4.1). */
@Controller("org")
export class TenantController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  @Can("org:read")
  @Get()
  async get(@CurrentPrincipal() p: Principal) {
    const t = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: p.tenantId } }),
    );
    return t ? toTenant(t) : notFound();
  }

  /** Settings are merged key-by-key (PATCH); the merged object must still satisfy `tenantSettings`. */
  @Can("org:manage")
  @Patch()
  async update(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(updateTenantRequest)) body: UpdateTenantRequest,
  ) {
    const t = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await tx.tenant.findUnique({ where: { id: p.tenantId } });
        if (!cur) return notFound();
        let settings: TenantSettings | undefined;
        if (body.settings) {
          const merged = tenantSettings.safeParse({
            ...(cur.settings as object),
            ...body.settings,
          });
          if (!merged.success) throw new BadRequestException({ error: "invalid_settings" });
          settings = merged.data;
        }
        const completing =
          body.onboardingStatus === "COMPLETED" && cur.onboardingStatus !== "COMPLETED";
        return tx.tenant.update({
          where: { id: p.tenantId },
          data: {
            name: body.name,
            settings,
            onboardingStatus: body.onboardingStatus,
            ...(completing ? { onboardedAt: new Date() } : {}),
            ...(body.onboardingStatus && body.onboardingStatus !== "COMPLETED"
              ? { onboardedAt: null }
              : {}),
          },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "tenant.update",
      resource: "Tenant",
      resourceId: p.tenantId,
      outcome: "success",
    });
    this.bus.publish({ tenantId: p.tenantId, type: "tenant.updated", data: { id: p.tenantId } });
    return toTenant(t);
  }

  /** Onboarding checklist derived from data (no separate state to drift). */
  @Can("org:read")
  @Get("onboarding")
  async onboarding(@CurrentPrincipal() p: Principal) {
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id: p.tenantId } });
      if (!t) return notFound();
      const [branches, services, members, invitations] = await Promise.all([
        tx.branch.count({ where: { tenantId: p.tenantId, active: true } }),
        tx.service.count({ where: { tenantId: p.tenantId, active: true } }),
        tx.membership.count({ where: { tenantId: p.tenantId } }),
        tx.staffInvitation.count({ where: { tenantId: p.tenantId } }),
      ]);
      const s = toTenant(t).settings;
      const steps = {
        settings: Boolean(s.displayName && s.defaultTimeZone),
        branches: branches > 0,
        services: services > 0,
        staff: members > 1 || invitations > 0,
      };
      return {
        status: t.onboardingStatus,
        onboardedAt: t.onboardedAt,
        steps,
        complete: Object.values(steps).every(Boolean),
      };
    });
  }
}
