import type { Prisma, PrismaClient, Tx } from "@dentalos/db";
import type {
  CloseCommissionRuleRequest,
  CreateCommissionRuleRequest,
  ListCommissionRulesQuery,
  SupersedeCommissionRuleRequest,
} from "@dentalos/validation";
import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { assertCan } from "../common/principal";
import {
  afterCursor,
  badRequest,
  canReadAllCompensation,
  canReadOwnCompensation,
  earliestBranchToday,
  notFound,
  pageOf,
  runTx,
  toDate,
  toRuleResponse,
} from "./commission-common";

/**
 * Commission rules (ADR 0004 §7.1): effective-dated, never edited — a change is "close the open rule + insert the
 * new one" (supersede) in one transaction; the DB refuses any other UPDATE (column grant + commission_rule_guard),
 * overlapping periods per scope (exclusion) and a second open rule per scope (partial unique index).
 */
@Injectable()
export class RulesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private record(p: Principal, action: string, id: string) {
    return this.audit.record(p, {
      action,
      resource: "commission_rule",
      resourceId: id,
      outcome: "success",
    });
  }

  /** Org-wide readers see every rule; a dentist sees the rules that apply to them (their own + the defaults). */
  async list(p: Principal, q: ListCommissionRulesQuery) {
    if (!canReadOwnCompensation(p)) throw new ForbiddenException();
    const all = canReadAllCompensation(p);
    const where: Prisma.CommissionRuleWhereInput[] = [afterCursor(q.cursor)];
    if (!all) where.push({ OR: [{ dentistUserId: p.userId }, { dentistUserId: null }] });
    if (q.dentistUserId !== undefined) {
      if (!all && q.dentistUserId !== p.userId) throw new ForbiddenException();
      where.push({ dentistUserId: q.dentistUserId });
    }
    if (q.serviceCategoryId) where.push({ serviceCategoryId: q.serviceCategoryId });
    if (q.defaultsOnly) where.push({ dentistUserId: null });
    if (q.open) where.push({ effectiveTo: null });
    if (q.asOf) {
      const on = toDate(q.asOf);
      where.push({
        effectiveFrom: { lte: on },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: on } }],
      });
    }
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.commissionRule.findMany({
        where: { tenantId: p.tenantId, AND: where },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    return pageOf(rows, q.limit, toRuleResponse);
  }

  async get(p: Principal, id: string) {
    if (!canReadOwnCompensation(p)) throw new ForbiddenException();
    const row = await runTx(this.prisma, p, (tx) =>
      tx.commissionRule.findFirst({ where: { id, tenantId: p.tenantId } }),
    );
    if (!row) throw notFound("commission_rule_not_found");
    if (!canReadAllCompensation(p) && row.dentistUserId !== null && row.dentistUserId !== p.userId)
      throw notFound("commission_rule_not_found");
    return toRuleResponse(row);
  }

  async create(p: Principal, body: CreateCommissionRuleRequest) {
    assertCan(p, "compensation:manage");
    const rule = await runTx(this.prisma, p, async (tx) => {
      await this.assertNotBackdated(tx, body.effectiveFrom);
      if (body.dentistUserId) {
        const m = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: p.tenantId, userId: body.dentistUserId } },
          select: { removedAt: true, roles: true },
        });
        if (!m || m.removedAt !== null || m.roles.length === 0)
          throw badRequest("dentistUserId", "Not a member of this organisation");
      }
      if (body.serviceCategoryId) {
        const c = await tx.serviceCategory.findFirst({
          where: { id: body.serviceCategoryId, tenantId: p.tenantId },
          select: { id: true },
        });
        if (!c) throw badRequest("serviceCategoryId", "Service category not found");
      }
      // A new rule is open-ended from `effectiveFrom`: nothing of the same scope may still be in force then or later.
      const clash = await tx.commissionRule.findFirst({
        where: {
          tenantId: p.tenantId,
          dentistUserId: body.dentistUserId ?? null,
          serviceCategoryId: body.serviceCategoryId ?? null,
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: toDate(body.effectiveFrom) } }],
        },
        select: { id: true },
      });
      if (clash)
        throw new ConflictException({
          error: "commission_rule_overlap",
          conflictingRuleId: clash.id,
          hint: "supersede or close the rule in force first",
        });
      return tx.commissionRule.create({
        data: {
          tenantId: p.tenantId,
          dentistUserId: body.dentistUserId ?? null,
          type: body.type,
          percentBp: body.percentBp ?? null,
          fixedPaise: body.fixedPaise ?? null,
          serviceCategoryId: body.serviceCategoryId ?? null,
          effectiveFrom: toDate(body.effectiveFrom),
          note: body.note || null,
          createdBy: p.userId,
        },
      });
    });
    await this.record(p, "commission.rule.create", rule.id);
    return toRuleResponse(rule);
  }

  /** Closes the open rule the day before `effectiveFrom` (exclusive end = `effectiveFrom`) and opens the new one. */
  async supersede(p: Principal, id: string, body: SupersedeCommissionRuleRequest) {
    assertCan(p, "compensation:manage");
    const rule = await runTx(this.prisma, p, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CommissionRule" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const old = await tx.commissionRule.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!old) throw notFound("commission_rule_not_found");
      if (old.effectiveTo !== null)
        throw new ConflictException({ error: "commission_rule_closed" });
      await this.assertNotBackdated(tx, body.effectiveFrom);
      const from = toDate(body.effectiveFrom);
      if (from <= old.effectiveFrom)
        throw badRequest("effectiveFrom", "Must be after the start of the rule being replaced");
      await tx.commissionRule.update({
        where: { id: old.id },
        data: { effectiveTo: from, endedBy: p.userId },
      });
      return tx.commissionRule.create({
        data: {
          tenantId: p.tenantId,
          dentistUserId: old.dentistUserId,
          type: body.type,
          percentBp: body.percentBp ?? null,
          fixedPaise: body.fixedPaise ?? null,
          serviceCategoryId: old.serviceCategoryId,
          effectiveFrom: from,
          note: body.note || null,
          createdBy: p.userId,
        },
      });
    });
    await this.record(p, "commission.rule.supersede", rule.id);
    return toRuleResponse(rule);
  }

  /** Ends an open rule at `effectiveTo` (exclusive): the scope falls back to broader rules. Never back-dated. */
  async close(p: Principal, id: string, body: CloseCommissionRuleRequest) {
    assertCan(p, "compensation:manage");
    const rule = await runTx(this.prisma, p, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CommissionRule" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const old = await tx.commissionRule.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!old) throw notFound("commission_rule_not_found");
      if (old.effectiveTo !== null)
        throw new ConflictException({ error: "commission_rule_closed" });
      await this.assertNotBackdated(tx, body.effectiveTo, "effectiveTo");
      const to = toDate(body.effectiveTo);
      if (to <= old.effectiveFrom)
        throw badRequest("effectiveTo", "Must be after the start of the rule");
      return tx.commissionRule.update({
        where: { id: old.id },
        data: { effectiveTo: to, endedBy: p.userId },
      });
    });
    await this.record(p, "commission.rule.close", rule.id);
    return toRuleResponse(rule);
  }

  private async assertNotBackdated(tx: Tx, day: string, path = "effectiveFrom") {
    const today = await earliestBranchToday(tx);
    if (day < today) throw badRequest(path, "Rules are never back-dated");
  }
}
