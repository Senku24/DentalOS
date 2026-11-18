import { type DentistBranchAssignment, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type AssignDentistRequest,
  type ListAssignmentsQuery,
  type TransferDentistRequest,
  assignDentistRequest,
  endAssignmentRequest,
  listAssignmentsQuery,
  transferDentistRequest,
} from "@dentalos/validation";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, branchWhere } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { EventBus } from "../realtime/event-bus";
import { UUID, dateFromDay, dayFromDate, mapDbError, notFound, todayIn } from "./http";

const toAssignment = (a: DentistBranchAssignment) => ({
  id: a.id,
  userId: a.userId,
  branchId: a.branchId,
  effectiveFrom: dayFromDate(a.effectiveFrom),
  effectiveTo: a.effectiveTo ? dayFromDate(a.effectiveTo) : null,
  createdBy: a.createdBy,
  createdAt: a.createdAt,
});

async function loadBranch(tx: Tx, tenantId: string, id: string) {
  const b = await tx.branch.findFirst({ where: { tenantId, id } });
  if (!b) return notFound();
  return b;
}

/** Changes are future-only (PRD 2.5): dates before the branch's local "today" are rejected. */
function assertNotPast(day: string, timeZone: string) {
  if (day < todayIn(timeZone)) throw new BadRequestException({ error: "effective_date_in_past" });
}

async function assertDentist(tx: Tx, tenantId: string, userId: string) {
  const m = await tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
  if (!m) return notFound();
  if (!m.roles.includes("DENTIST")) throw new BadRequestException({ error: "not_a_dentist" });
}

/**
 * Dentist ↔ branch assignments, effective-dated (`effectiveTo` exclusive, NULL = open). A transfer closes
 * the open row and inserts a new one; past rows are never updated. Reads: branch-scoped `staff:read`.
 */
@Controller("dentist-assignments")
export class AssignmentsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
  ) {}

  @Can("staff:read")
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listAssignmentsQuery)) q: ListAssignmentsQuery,
  ) {
    // "current" is judged in each branch's own time zone: the DB pre-filter uses the earliest calendar
    // date on Earth (UTC-12), then rows are re-checked against their branch's local "today".
    const earliestToday = dateFromDay(todayIn("Etc/GMT+12"));
    const { rows, zones } = await withTenant(this.prisma, p.tenantId, async (tx) => {
      const rows = await tx.dentistBranchAssignment.findMany({
        where: {
          tenantId: p.tenantId,
          userId: q.userId,
          ...(q.branchId ? { branchId: q.branchId } : {}),
          AND: [
            branchWhere(p),
            q.status === "current"
              ? { OR: [{ effectiveTo: null }, { effectiveTo: { gt: earliestToday } }] }
              : {},
          ],
        },
        orderBy: [{ userId: "asc" }, { effectiveFrom: "desc" }, { createdAt: "desc" }],
        take: 1000,
      });
      const branchIds = [...new Set(rows.filter((r) => r.effectiveTo).map((r) => r.branchId))];
      const zones = new Map(
        q.status === "current" && branchIds.length
          ? (
              await tx.branch.findMany({
                where: { tenantId: p.tenantId, id: { in: branchIds } },
                select: { id: true, timezone: true },
              })
            ).map((b) => [b.id, b.timezone] as const)
          : [],
      );
      return { rows, zones };
    });
    const now = new Date();
    const current = (a: DentistBranchAssignment) =>
      !a.effectiveTo ||
      dayFromDate(a.effectiveTo) > todayIn(zones.get(a.branchId) ?? "Asia/Kolkata", now);
    const items = q.status === "current" ? rows.filter(current) : rows;
    return { items: items.map(toAssignment) };
  }

  @Can("staff:manage")
  @Post()
  async assign(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(assignDentistRequest)) body: AssignDentistRequest,
  ) {
    const a = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await assertDentist(tx, p.tenantId, body.userId);
        const b = await loadBranch(tx, p.tenantId, body.branchId);
        if (!b.active) throw new ConflictException({ error: "branch_inactive" });
        assertNotPast(body.effectiveFrom, b.timezone);
        return tx.dentistBranchAssignment.create({
          data: {
            tenantId: p.tenantId,
            userId: body.userId,
            branchId: body.branchId,
            effectiveFrom: dateFromDay(body.effectiveFrom),
            createdBy: p.userId,
          },
        });
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "assignment_open" }));
    await this.changed(p, "dentist_assignment.create", a);
    return toAssignment(a);
  }

  /** Closes the open row at `fromBranchId` on `effectiveFrom` and opens one at `toBranchId`. */
  @Can("staff:manage")
  @Post("transfer")
  @HttpCode(200)
  async transfer(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(transferDentistRequest)) body: TransferDentistRequest,
  ) {
    const day = dateFromDay(body.effectiveFrom);
    const { closed, opened } = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await assertDentist(tx, p.tenantId, body.userId);
        const from = await loadBranch(tx, p.tenantId, body.fromBranchId);
        const to = await loadBranch(tx, p.tenantId, body.toBranchId);
        if (!to.active) throw new ConflictException({ error: "branch_inactive" });
        assertNotPast(body.effectiveFrom, from.timezone);
        const open = await tx.dentistBranchAssignment.findFirst({
          where: {
            tenantId: p.tenantId,
            userId: body.userId,
            branchId: body.fromBranchId,
            effectiveTo: null,
          },
        });
        if (!open) throw new ConflictException({ error: "no_open_assignment" });
        if (day <= open.effectiveFrom)
          throw new BadRequestException({ error: "transfer_before_assignment_start" });
        const closed = await tx.dentistBranchAssignment.update({
          where: { id: open.id },
          data: { effectiveTo: day },
        });
        const opened = await tx.dentistBranchAssignment.create({
          data: {
            tenantId: p.tenantId,
            userId: body.userId,
            branchId: body.toBranchId,
            effectiveFrom: day,
            createdBy: p.userId,
          },
        });
        return { closed, opened };
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "assignment_open" }));
    await this.changed(p, "dentist_assignment.close", closed);
    await this.changed(p, "dentist_assignment.create", opened);
    return { closed: toAssignment(closed), opened: toAssignment(opened) };
  }

  @Can("staff:manage")
  @Post(":id/end")
  @HttpCode(200)
  async end(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(endAssignmentRequest)) body: { effectiveTo: string },
  ) {
    const a = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await tx.dentistBranchAssignment.findFirst({
          where: { tenantId: p.tenantId, id },
        });
        if (!cur) return notFound();
        if (cur.effectiveTo) throw new ConflictException({ error: "assignment_closed" });
        const b = await loadBranch(tx, p.tenantId, cur.branchId);
        assertNotPast(body.effectiveTo, b.timezone);
        const to = dateFromDay(body.effectiveTo);
        if (to <= cur.effectiveFrom)
          throw new BadRequestException({ error: "end_before_assignment_start" });
        return tx.dentistBranchAssignment.update({ where: { id }, data: { effectiveTo: to } });
      },
      { actorId: p.userId },
    );
    await this.changed(p, "dentist_assignment.close", a);
    return toAssignment(a);
  }

  private async changed(p: Principal, action: string, a: DentistBranchAssignment) {
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
      data: { id: a.id, userId: a.userId },
    });
  }
}
