import { PrismaClient, withTenant } from "@dentalos/db";
import {
  type ListSchedulingDentistsQuery,
  type SchedulingDentistsResponse,
  listSchedulingDentistsQuery,
} from "@dentalos/validation";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, assertCan } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { dateFromDay, findBranchOr404, todayIn } from "./scheduling-common";

/**
 * Dentists a scheduling screen can offer at one branch: current members (not removed) with the
 * DENTIST role and a DentistBranchAssignment at the branch in force today (branch-local) or starting
 * later — the same "current" as GET /dentist-assignments?status=current. Readable with branch-scoped
 * `appointment:read`, so RECEPTIONIST and DENTIST (no `staff:read`) can pick a dentist when booking.
 * Answers ids and display names only (no e-mail, roles or scope).
 */
@Controller("scheduling")
export class SchedulingDentistsController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  @Can("appointment:read")
  @Get("dentists")
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listSchedulingDentistsQuery)) q: ListSchedulingDentistsQuery,
  ): Promise<SchedulingDentistsResponse> {
    assertCan(p, "appointment:read", { branchId: q.branchId });
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      const branch = await findBranchOr404(tx, q.branchId);
      const today = dateFromDay(todayIn(branch.timezone));
      return tx.dentistBranchAssignment.findMany({
        where: {
          tenantId: p.tenantId,
          branchId: q.branchId,
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: today } }],
          member: { removedAt: null, roles: { has: "DENTIST" } },
        },
        select: { userId: true, member: { select: { displayName: true } } },
      });
    });
    const byUser = new Map<string, string | null>();
    for (const r of rows) byUser.set(r.userId, r.member.displayName);
    const items = [...byUser].map(([userId, displayName]) => ({ userId, displayName }));
    items.sort(
      (a, b) =>
        (a.displayName ?? "￿").localeCompare(b.displayName ?? "￿") ||
        a.userId.localeCompare(b.userId),
    );
    return { items };
  }
}
