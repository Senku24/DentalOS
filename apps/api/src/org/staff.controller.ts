import { type Membership, Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type ListStaffQuery,
  type UpdateMembershipRequest,
  listStaffQuery,
  updateMembershipRequest,
} from "@dentalos/validation";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Query,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import { type Principal, branchFilter } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { EventBus } from "../realtime/event-bus";
import { UUID, notFound } from "./http";

/**
 * A branch-limited caller sees members who work in one of their branches (plus org-wide members, who
 * work everywhere), and only the overlapping part of each member's branch scope.
 */
function visibleTo(p: Principal): Prisma.MembershipWhereInput {
  const scope = branchFilter(p);
  if (scope === undefined) return {};
  return { OR: [{ orgWide: true }, { branchScope: { hasSome: scope } }] };
}

const toMember = (m: Membership, p: Principal) => {
  const scope = branchFilter(p);
  return {
    id: m.id,
    userId: m.userId,
    roles: m.roles,
    orgWide: m.orgWide,
    branchScope:
      scope === undefined ? m.branchScope : m.branchScope.filter((b) => scope.includes(b)),
    createdAt: m.createdAt,
  };
};

/** Throws 400 unless every id is a branch of this tenant (RLS scopes the lookup). */
export async function assertTenantBranches(tx: Tx, tenantId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return unique;
  const n = await tx.branch.count({ where: { tenantId, id: { in: unique } } });
  if (n !== unique.length) throw new BadRequestException({ error: "unknown_branch" });
  return unique;
}

/** Staff memberships: list (branch-scoped `staff:read`) and access changes (org-wide `staff:manage`). */
@Controller("staff")
export class StaffController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  @Can("staff:read")
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listStaffQuery)) q: ListStaffQuery,
  ) {
    const rows = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.membership.findMany({
        where: {
          tenantId: p.tenantId,
          roles: q.role ? { has: q.role } : undefined,
          AND: [
            visibleTo(p),
            q.branchId ? { OR: [{ orgWide: true }, { branchScope: { has: q.branchId } }] } : {},
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
    return { items: rows.map((m) => toMember(m, p)) };
  }

  @Can("staff:read")
  @Get(":id")
  async get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const m = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.membership.findFirst({ where: { tenantId: p.tenantId, id, ...visibleTo(p) } }),
    );
    return m ? toMember(m, p) : notFound();
  }

  /**
   * Replaces roles + scope. Guard: the tenant must keep at least one org-wide OWNER, otherwise nobody
   * could administer it. All OWNER rows are locked first so two concurrent demotions cannot both pass.
   */
  @Can("staff:manage")
  @Patch(":id")
  async update(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(updateMembershipRequest)) body: UpdateMembershipRequest,
  ) {
    const m = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${p.tenantId}::uuid AND 'OWNER' = ANY(roles) FOR UPDATE`;
        const cur = await tx.membership.findFirst({ where: { tenantId: p.tenantId, id } });
        if (!cur) return notFound();
        const branchScope = body.orgWide
          ? []
          : await assertTenantBranches(tx, p.tenantId, body.branchScope);
        const staysAdminOwner = body.roles.includes("OWNER") && body.orgWide;
        if (cur.roles.includes("OWNER") && cur.orgWide && !staysAdminOwner) {
          const others = await tx.membership.count({
            where: {
              tenantId: p.tenantId,
              id: { not: id },
              orgWide: true,
              roles: { has: "OWNER" },
            },
          });
          if (others === 0) throw new ConflictException({ error: "last_owner" });
        }
        return tx.membership.update({
          where: { id },
          data: { roles: [...new Set(body.roles)], orgWide: body.orgWide, branchScope },
        });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "membership.update",
      resource: "Membership",
      resourceId: id,
      outcome: "success",
    });
    this.bus.publish({ tenantId: p.tenantId, type: "membership.updated", data: { id } });
    return toMember(m, p);
  }
}
