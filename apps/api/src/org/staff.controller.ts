import { type Membership, Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type ListStaffQuery,
  type UpdateMembershipRequest,
  type UpdateStaffProfileRequest,
  listStaffQuery,
  updateMembershipRequest,
  updateStaffProfileRequest,
} from "@dentalos/validation";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Query,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import { type Principal, branchFilter, can } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { EventBus } from "../realtime/event-bus";
import { UUID, dateFromDay, dayFromDate, notFound, todayIn } from "./http";

/**
 * Soft removal (0007_m2_member_removal): a removed member keeps its Membership row — so
 * DentistBranchAssignment history (RESTRICT FK) and display name/e-mail for historical attribution
 * survive — with `removedAt`/`removedBy` set and no roles or scope (DB CHECK). AuthGuard refuses a
 * removed member on every route, `@Can` or not. Re-inviting restores it (clears both columns).
 * `roles.length === 0` is kept as a fallback for rows written before the column existed.
 */
export const isRemoved = (m: Pick<Membership, "roles" | "removedAt">) =>
  m.removedAt !== null || m.roles.length === 0;

const FALLBACK_TZ = "Asia/Kolkata";

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
    displayName: m.displayName,
    email: m.email,
    removedAt: m.removedAt,
    removedBy: m.removedBy,
    createdAt: m.createdAt,
  };
};

/**
 * Takes a leaving member off every branch from the branch-local "today": rows still running are
 * closed at today (`effectiveTo` is exclusive), rows that have not started yet (`effectiveFrom >
 * today`) carry no history and are deleted. A row that started TODAY may already cover today's
 * appointments, so it is kept and closed at tomorrow (the DB CHECK forbids effectiveTo =
 * effectiveFrom). Past rows are never touched (PRD 2.5).
 */
async function endAssignmentsOf(tx: Tx, tenantId: string, userId: string) {
  const earliestToday = dateFromDay(todayIn("Etc/GMT+12"));
  const rows = await tx.dentistBranchAssignment.findMany({
    where: {
      tenantId,
      userId,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: earliestToday } }],
    },
  });
  if (rows.length === 0) return { closed: [], cancelled: [] };
  const zones = new Map(
    (
      await tx.branch.findMany({
        where: { tenantId, id: { in: [...new Set(rows.map((r) => r.branchId))] } },
        select: { id: true, timezone: true },
      })
    ).map((b) => [b.id, b.timezone] as const),
  );
  const closed: { id: string; branchId: string }[] = [];
  const cancelled: { id: string; branchId: string }[] = [];
  for (const r of rows) {
    const today = todayIn(zones.get(r.branchId) ?? FALLBACK_TZ);
    const from = dayFromDate(r.effectiveFrom);
    // Earliest legal end: today, or tomorrow for a row that started today.
    const end = from === today ? nextDay(today) : today;
    if (from > today) {
      await tx.dentistBranchAssignment.delete({ where: { id: r.id } });
      cancelled.push({ id: r.id, branchId: r.branchId });
    } else if (!r.effectiveTo || dayFromDate(r.effectiveTo) > end) {
      await tx.dentistBranchAssignment.update({
        where: { id: r.id },
        data: { effectiveTo: dateFromDay(end) },
      });
      closed.push({ id: r.id, branchId: r.branchId });
    }
  }
  return { closed, cancelled };
}

const nextDay = (day: string) => {
  const d = dateFromDay(day);
  d.setUTCDate(d.getUTCDate() + 1);
  return dayFromDate(d);
};

/** Locks every OWNER row, then refuses when `id` is the tenant's only org-wide OWNER. */
async function assertNotLastOwner(tx: Tx, tenantId: string, cur: Membership) {
  if (!(cur.roles.includes("OWNER") && cur.orgWide)) return;
  const others = await tx.membership.count({
    where: { tenantId, id: { not: cur.id }, orgWide: true, roles: { has: "OWNER" } },
  });
  if (others === 0) throw new ConflictException({ error: "last_owner" });
}

const lockOwners = (tx: Tx, tenantId: string) =>
  tx.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${tenantId}::uuid AND 'OWNER' = ANY(roles) FOR UPDATE`;

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
    // Removed members are not staff any more (GET /staff/:id still resolves them). Listing them is
    // an administrative view: org-wide `staff:manage` only.
    if (q.includeRemoved && !can(p, "staff:manage")) throw new ForbiddenException();
    const rows = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.membership.findMany({
        where: {
          tenantId: p.tenantId,
          // `isEmpty: false` also hides rows removed before 0007 (no roles, no removedAt).
          ...(q.role
            ? { roles: { has: q.role } }
            : q.includeRemoved
              ? {}
              : { roles: { isEmpty: false } }),
          ...(q.includeRemoved ? {} : { removedAt: null }),
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
        await lockOwners(tx, p.tenantId);
        const cur = await tx.membership.findFirst({ where: { tenantId: p.tenantId, id } });
        if (!cur) return notFound();
        // Restoring a removed member goes through a new invitation (re-binds the verified e-mail).
        if (isRemoved(cur)) throw new ConflictException({ error: "member_removed" });
        const branchScope = body.orgWide
          ? []
          : await assertTenantBranches(tx, p.tenantId, body.branchScope);
        const staysAdminOwner = body.roles.includes("OWNER") && body.orgWide;
        if (!staysAdminOwner) await assertNotLastOwner(tx, p.tenantId, cur);
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

  /**
   * Display details. Org-wide `staff:manage`, or the member themself (no `@Can`: the check needs the
   * target row). E-mail is not editable here: it is set from the IdP-verified claim on invite accept.
   */
  @Patch(":id/profile")
  async updateProfile(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(updateStaffProfileRequest)) body: UpdateStaffProfileRequest,
  ) {
    const m = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await tx.membership.findFirst({
          where: { tenantId: p.tenantId, id, ...visibleTo(p) },
        });
        if (!cur) return notFound();
        if (cur.userId !== p.userId && !can(p, "staff:manage")) throw new ForbiddenException();
        if (isRemoved(cur)) throw new ConflictException({ error: "member_removed" });
        if (body.displayName === undefined) return cur;
        return tx.membership.update({ where: { id }, data: { displayName: body.displayName } });
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "membership.profile_update",
      resource: "Membership",
      resourceId: id,
      outcome: "success",
    });
    this.bus.publish({ tenantId: p.tenantId, type: "membership.updated", data: { id } });
    return toMember(m, p);
  }

  /**
   * Removes a member (soft, see `isRemoved`): `removedAt`/`removedBy` are set and roles and scope
   * cleared, so the user can no longer act in the tenant, while the row keeps history attributable (assignments, appointments,
   * encounters reference the user id). Open dentist assignments end at each branch's local today;
   * not-yet-started ones are cancelled. Same last-owner guard as PATCH. Answers the removed member
   * (`roles: []`, `removedAt`, `removedBy`) plus the assignment ids that were ended / cancelled.
   */
  @Can("staff:manage")
  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const { m, closed, cancelled } = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await lockOwners(tx, p.tenantId);
        // Lock the target too, before reading it: POST /dentist-assignments takes FOR SHARE on the
        // same row (assignments.controller.ts assertDentist), so it cannot insert an open assignment
        // from pre-removal roles that endAssignmentsOf below would miss — it waits, then sees the
        // removal.
        await tx.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${p.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
        const cur = await tx.membership.findFirst({ where: { tenantId: p.tenantId, id } });
        if (!cur) return notFound();
        if (isRemoved(cur)) throw new ConflictException({ error: "member_removed" });
        await assertNotLastOwner(tx, p.tenantId, cur);
        const ended = await endAssignmentsOf(tx, p.tenantId, cur.userId);
        const m = await tx.membership.update({
          where: { id },
          data: {
            roles: [],
            orgWide: false,
            branchScope: [],
            removedAt: new Date(),
            removedBy: p.userId,
          },
        });
        return { m, ...ended };
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "membership.remove",
      resource: "Membership",
      resourceId: id,
      outcome: "success",
    });
    for (const [action, list] of [
      ["dentist_assignment.close", closed],
      ["dentist_assignment.cancel", cancelled],
    ] as const) {
      for (const a of list) {
        await this.audit.record(p, {
          action,
          resource: "DentistBranchAssignment",
          resourceId: a.id,
          branchId: a.branchId,
          outcome: "success",
        });
        this.bus.publish({
          tenantId: p.tenantId,
          branchId: a.branchId,
          type: action,
          data: { id: a.id, userId: m.userId },
        });
      }
    }
    this.bus.publish({ tenantId: p.tenantId, type: "membership.removed", data: { id } });
    return {
      ...toMember(m, p),
      endedAssignmentIds: closed.map((a) => a.id),
      cancelledAssignmentIds: cancelled.map((a) => a.id),
    };
  }
}
