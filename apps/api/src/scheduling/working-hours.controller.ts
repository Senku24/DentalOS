import { type Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type ListWorkingHoursQuery,
  type SetWorkingHoursRequest,
  type UpdateSchedulingSettingsRequest,
  branchSettings,
  listWorkingHoursQuery,
  resolveSchedulingSettings,
  setWorkingHoursRequest,
  updateSchedulingSettingsRequest,
} from "@dentalos/validation";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Patch,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, assertCan } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import {
  dateFromDay,
  findBranchOr404,
  rethrowDb,
  toWorkingHours,
  todayIn,
} from "./scheduling-common";

/**
 * Working hours (effective-dated weekly sessions, branch-local) and the per-branch scheduling knobs.
 * Setting hours replaces the subject's schedule from `effectiveFrom`: rows already in force are
 * closed (effectiveTo = effectiveFrom) and rows that would only start AFTER today (branch time
 * zone) are superseded (removed — they never took effect), then `sessions` are inserted. Rows that
 * took effect (today or earlier) are never deleted or rewritten, so `effectiveFrom` may not be
 * before today, and replacing rows that already took effect today needs `effectiveFrom` > today
 * (409 working_hours_in_force) — dates are day-granular, so a same-day period cannot be closed.
 */
@Injectable()
export class WorkingHoursService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal, q: ListWorkingHoursQuery) {
    assertCan(p, "appointment:read", { branchId: q.branchId });
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      const branch = await findBranchOr404(tx, q.branchId);
      const where: Prisma.WorkingHoursWhereInput = {
        branchId: q.branchId,
        ...(q.scope ? { scope: q.scope } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.chairId ? { chairId: q.chairId } : {}),
      };
      if (!q.includeHistory) {
        const on = dateFromDay(q.on ?? todayIn(branch.timezone));
        where.effectiveFrom = { lte: on };
        where.OR = [{ effectiveTo: null }, { effectiveTo: { gt: on } }];
      }
      return tx.workingHours.findMany({
        where,
        orderBy: [
          { scope: "asc" },
          { userId: "asc" },
          { chairId: "asc" },
          { effectiveFrom: "asc" },
          { weekday: "asc" },
          { startMinute: "asc" },
        ],
      });
    });
    return { items: rows.map(toWorkingHours) };
  }

  async set(p: Principal, body: SetWorkingHoursRequest) {
    assertCan(p, "schedule:manage", { branchId: body.branchId });
    const rows = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const branch = await findBranchOr404(tx, body.branchId);
        const today = todayIn(branch.timezone);
        if (body.effectiveFrom < today)
          throw new BadRequestException({
            error: "validation_failed",
            issues: [{ path: "effectiveFrom", message: "Cannot change past working hours" }],
          });
        if (body.scope === "CHAIR" && body.chairId) {
          const chair = await tx.chair.findFirst({
            where: { id: body.chairId, branchId: body.branchId },
            select: { id: true },
          });
          if (!chair) throw new NotFoundException({ error: "chair_not_found" });
        }
        if (body.scope === "DENTIST" && body.userId) await this.assertDentistAt(tx, p, body);

        const from = dateFromDay(body.effectiveFrom);
        const subject: Prisma.WorkingHoursWhereInput = {
          scope: body.scope,
          branchId: body.branchId,
          userId: body.scope === "DENTIST" ? body.userId : null,
          chairId: body.scope === "CHAIR" ? body.chairId : null,
        };
        const todayDate = dateFromDay(today);
        // Rows that took effect today were in force (bookings were checked against them): keep them.
        if (body.effectiveFrom === today) {
          const inForceToday = await tx.workingHours.count({
            where: { ...subject, effectiveFrom: todayDate },
          });
          if (inForceToday > 0)
            throw new ConflictException({
              error: "working_hours_in_force",
              message: "These hours already took effect today; replace them from tomorrow or later",
            });
        }
        // Rows that would only start after today (and on/after `from`) never took effect: superseded.
        await tx.workingHours.deleteMany({
          where: { ...subject, effectiveFrom: { gte: from, gt: todayDate } },
        });
        // Rows in force across `from`: close them.
        await tx.workingHours.updateMany({
          where: {
            ...subject,
            effectiveFrom: { lt: from },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }],
          },
          data: { effectiveTo: from },
        });
        if (body.sessions.length > 0)
          await tx.workingHours.createMany({
            data: body.sessions.map((s) => ({
              tenantId: p.tenantId,
              scope: body.scope,
              branchId: body.branchId,
              userId: body.scope === "DENTIST" ? body.userId : null,
              chairId: body.scope === "CHAIR" ? body.chairId : null,
              weekday: s.weekday,
              startMinute: s.startMinute,
              endMinute: s.endMinute,
              effectiveFrom: from,
              createdBy: p.userId,
            })),
          });
        return tx.workingHours.findMany({
          where: { ...subject, effectiveFrom: from },
          orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
        });
      },
      { actorId: p.userId },
    ).catch((e) => rethrowDb(e));
    await this.audit.record(p, {
      action: "working_hours.set",
      resource: "WorkingHours",
      resourceId: body.scope === "CHAIR" ? body.chairId : body.branchId,
      branchId: body.branchId,
      outcome: "success",
    });
    return { items: rows.map(toWorkingHours) };
  }

  /** DENTIST hours: a tenant member with the DENTIST role, assigned to the branch from `effectiveFrom` on. */
  private async assertDentistAt(tx: Tx, p: Principal, body: SetWorkingHoursRequest) {
    const userId = body.userId as string;
    const m = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId: p.tenantId, userId } },
    });
    if (!m) throw new BadRequestException({ error: "not_a_member", field: "userId" });
    if (!m.roles.includes("DENTIST"))
      throw new BadRequestException({ error: "not_a_dentist", field: "userId" });
    const from = dateFromDay(body.effectiveFrom);
    const assigned = await tx.dentistBranchAssignment.findFirst({
      where: {
        userId,
        branchId: body.branchId,
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }],
      },
      select: { id: true },
    });
    if (!assigned)
      throw new BadRequestException({ error: "dentist_not_assigned", field: "userId" });
  }

  async settings(p: Principal, branchId: string) {
    assertCan(p, "appointment:read", { branchId });
    const branch = await withTenant(this.prisma, p.tenantId, (tx) => findBranchOr404(tx, branchId));
    return { branchId, ...resolveSchedulingSettings(branch.settings) };
  }

  async updateSettings(p: Principal, branchId: string, body: UpdateSchedulingSettingsRequest) {
    assertCan(p, "schedule:manage", { branchId });
    const result = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const branch = await findBranchOr404(tx, branchId);
        const existing =
          branch.settings && typeof branch.settings === "object" && !Array.isArray(branch.settings)
            ? (branch.settings as Record<string, unknown>)
            : {};
        const scheduling = { ...resolveSchedulingSettings(branch.settings), ...body };
        const next = branchSettings.safeParse({ ...existing, scheduling });
        if (!next.success) throw new ConflictException({ error: "invalid_branch_settings" });
        await tx.branch.update({
          where: { id: branchId },
          data: { settings: next.data as Prisma.InputJsonValue },
        });
        return scheduling;
      },
      { actorId: p.userId },
    );
    await this.audit.record(p, {
      action: "branch.scheduling_settings.update",
      resource: "Branch",
      resourceId: branchId,
      branchId,
      outcome: "success",
    });
    return { branchId, ...result };
  }
}

const branchIdQuery = z.object({ branchId: z.uuid() });

@Controller()
export class WorkingHoursController {
  constructor(private readonly hours: WorkingHoursService) {}

  @Can("appointment:read")
  @Get("working-hours")
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listWorkingHoursQuery)) q: ListWorkingHoursQuery,
  ) {
    return this.hours.list(p, q);
  }

  @Can("schedule:manage")
  @Put("working-hours")
  set(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(setWorkingHoursRequest)) body: SetWorkingHoursRequest,
  ) {
    return this.hours.set(p, body);
  }

  @Can("appointment:read")
  @Get("scheduling/settings")
  settings(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(branchIdQuery)) q: { branchId: string },
  ) {
    return this.hours.settings(p, q.branchId);
  }

  @Can("schedule:manage")
  @Patch("scheduling/settings")
  updateSettings(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(branchIdQuery)) q: { branchId: string },
    @Body(new ZodPipe(updateSchedulingSettingsRequest)) body: UpdateSchedulingSettingsRequest,
  ) {
    return this.hours.updateSettings(p, q.branchId, body);
  }
}
