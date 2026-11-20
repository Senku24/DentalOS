import { type Branch, PrismaClient, withTenant } from "@dentalos/db";
import {
  type CreateBranchRequest,
  type ListBranchesQuery,
  type UpdateBranchRequest,
  createBranchRequest,
  listBranchesQuery,
  updateBranchRequest,
} from "@dentalos/validation";
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, withBranchScope } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { EventBus } from "../realtime/event-bus";
import { UUID, mapDbError, notFound } from "./http";

const toBranch = (b: Branch) => ({
  id: b.id,
  code: b.code,
  name: b.name,
  active: b.active,
  addressLine1: b.addressLine1,
  addressLine2: b.addressLine2,
  city: b.city,
  state: b.state,
  postalCode: b.postalCode,
  country: b.country,
  phone: b.phone,
  email: b.email,
  timezone: b.timezone,
  workingHours: b.workingHours,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

/**
 * Branch administration. Reads are branch-scoped (a branch-limited member sees only their branches;
 * out-of-scope ids answer 404 so existence does not leak); writes need org-wide `branch:manage`.
 */
@Controller("branches")
export class BranchesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  @Can("branch:read")
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listBranchesQuery)) q: ListBranchesQuery,
  ) {
    const rows = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.branch.findMany({
        where: withBranchScope(p, { tenantId: p.tenantId, active: q.active }, "id"),
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
    );
    return { items: rows.map(toBranch) };
  }

  @Can("branch:read")
  @Get(":id")
  async get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const b = await withTenant(this.prisma, p.tenantId, (tx) =>
      // AND, not spread: branchWhere(p, "id") would overwrite the `id` key.
      tx.branch.findFirst({ where: withBranchScope(p, { tenantId: p.tenantId, id }, "id") }),
    );
    return b ? toBranch(b) : notFound();
  }

  @Can("branch:manage")
  @Post()
  async create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createBranchRequest)) body: CreateBranchRequest,
  ) {
    const b = await withTenant(
      this.prisma,
      p.tenantId,
      (tx) => tx.branch.create({ data: { ...body, tenantId: p.tenantId } }),
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "branch_code_taken" }));
    await this.changed(p, "branch.create", b.id);
    return toBranch(b);
  }

  @Can("branch:manage")
  @Patch(":id")
  async update(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(updateBranchRequest)) body: UpdateBranchRequest,
  ) {
    const b = await this.write(p, id, body).catch((e) =>
      mapDbError(e, { conflict: "branch_code_taken" }),
    );
    await this.changed(p, "branch.update", id);
    return toBranch(b);
  }

  @Can("branch:manage")
  @Post(":id/activate")
  @HttpCode(200)
  async activate(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const b = await this.write(p, id, { active: true });
    await this.changed(p, "branch.activate", id);
    return toBranch(b);
  }

  /** Deactivation hides the branch from new work; history and attribution stay intact. */
  @Can("branch:manage")
  @Post(":id/deactivate")
  @HttpCode(200)
  async deactivate(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const b = await this.write(p, id, { active: false });
    await this.changed(p, "branch.deactivate", id);
    return toBranch(b);
  }

  private write(
    p: Principal,
    id: string,
    data: Partial<UpdateBranchRequest> & { active?: boolean },
  ) {
    return withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const r = await tx.branch.updateMany({ where: { tenantId: p.tenantId, id }, data });
        if (r.count === 0) return notFound();
        return tx.branch.findUniqueOrThrow({ where: { id } });
      },
      { actorId: p.userId },
    );
  }

  private async changed(p: Principal, action: string, id: string) {
    await this.audit.record(p, {
      action,
      resource: "Branch",
      resourceId: id,
      branchId: id,
      outcome: "success",
    });
    this.bus.publish({ tenantId: p.tenantId, branchId: id, type: action, data: { id } });
  }
}
