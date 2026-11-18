import { type Prisma, PrismaClient, type Tx, withTenant } from "@dentalos/db";
import {
  type ClearPriceOverrideRequest,
  type CreateServiceRequest,
  type ListServicesQuery,
  type SetPriceOverrideRequest,
  type UpdateServiceRequest,
  clearPriceOverrideRequest,
  createServiceRequest,
  listServicesQuery,
  setPriceOverrideRequest,
  updateServiceRequest,
} from "@dentalos/validation";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, assertCan, branchWhere } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { UUID, mapDbError, notFound, toPage } from "../org/http";
import { effectivePrice, overridesFor, toOverride, toService } from "./pricing";

const branchQuery = z.object({ branchId: z.uuid() });
const historyQuery = z.object({ branchId: z.uuid().optional() });
/** Small clock-skew allowance for "now" overrides sent with an explicit effectiveFrom. */
const SKEW_MS = 60_000;

async function loadService(tx: Tx, tenantId: string, id: string) {
  const s = await tx.service.findFirst({ where: { tenantId, id } });
  if (!s) return notFound();
  return s;
}

async function assertBranch(tx: Tx, tenantId: string, id: string) {
  const b = await tx.branch.findFirst({ where: { tenantId, id }, select: { id: true } });
  if (!b) return notFound();
}

/**
 * Central service catalogue (`catalog:read` tenant-wide, `catalog:manage` org-wide) plus effective-dated,
 * audited branch price overrides (`price:override` on the target branch, PRD 2.5).
 */
@Controller("catalog")
export class ServicesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** Name search uses the trigram index (ILIKE '%q%'); codes match by prefix. Keyset by (name, id). */
  @Can("catalog:read")
  @Get("services")
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listServicesQuery)) q: ListServicesQuery,
  ) {
    const where: Prisma.ServiceWhereInput = {
      tenantId: p.tenantId,
      categoryId: q.categoryId,
      active: q.active,
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: "insensitive" } },
              { code: { startsWith: q.q.toUpperCase() } },
            ],
          }
        : {}),
    };
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      if (q.branchId) await assertBranch(tx, p.tenantId, q.branchId);
      const rows = await tx.service.findMany({
        where,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: q.limit + 1,
        ...(q.cursor && z.uuid().safeParse(q.cursor).success
          ? { cursor: { id: q.cursor }, skip: 1 }
          : {}),
      });
      const { items, nextCursor } = toPage(rows, q.limit);
      const branchId = q.branchId;
      if (!branchId) return { items: items.map((s) => toService(s)), nextCursor };
      const ov = await overridesFor(
        tx,
        p.tenantId,
        branchId,
        items.map((s) => s.id),
      );
      return {
        items: items.map((s) => toService(s, effectivePrice(s, branchId, ov.get(s.id)).pricePaise)),
        nextCursor,
      };
    });
  }

  /** Branch price list: every active service with its effective price for the branch. */
  @Can("catalog:read")
  @Get("price-list")
  async priceList(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(branchQuery)) q: z.infer<typeof branchQuery>,
  ) {
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      await assertBranch(tx, p.tenantId, q.branchId);
      const services = await tx.service.findMany({
        where: { tenantId: p.tenantId, active: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
      const ov = await overridesFor(tx, p.tenantId, q.branchId, undefined);
      return {
        branchId: q.branchId,
        items: services.map((s) => ({
          ...toService(s),
          ...effectivePrice(s, q.branchId, ov.get(s.id)),
        })),
      };
    });
  }

  @Can("catalog:read")
  @Get("services/:id")
  async get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const s = await withTenant(this.prisma, p.tenantId, (tx) => loadService(tx, p.tenantId, id));
    return toService(s);
  }

  @Can("catalog:manage")
  @Post("services")
  async create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createServiceRequest)) body: CreateServiceRequest,
  ) {
    const s = await withTenant(
      this.prisma,
      p.tenantId,
      (tx) => tx.service.create({ data: { ...body, tenantId: p.tenantId } }),
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "service_code_taken", fk: "unknown_category" }));
    await this.record(p, "service.create", s.id);
    return toService(s);
  }

  @Can("catalog:manage")
  @Patch("services/:id")
  async update(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(updateServiceRequest)) body: UpdateServiceRequest,
  ) {
    const s = await this.write(p, id, body);
    await this.record(p, "service.update", id);
    return toService(s);
  }

  @Can("catalog:manage")
  @Post("services/:id/activate")
  @HttpCode(200)
  async activate(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const s = await this.write(p, id, { active: true });
    await this.record(p, "service.activate", id);
    return toService(s);
  }

  @Can("catalog:manage")
  @Post("services/:id/deactivate")
  @HttpCode(200)
  async deactivate(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const s = await this.write(p, id, { active: false });
    await this.record(p, "service.deactivate", id);
    return toService(s);
  }

  /** Hard delete only for never-used services (no price history); otherwise deactivate. */
  @Can("catalog:manage")
  @Delete("services/:id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await loadService(tx, p.tenantId, id);
        const refs = await tx.branchPriceOverride.count({
          where: { tenantId: p.tenantId, serviceId: id },
        });
        if (refs > 0) throw new ConflictException({ error: "service_in_use" });
        await tx.service.delete({ where: { id } });
      },
      { actorId: p.userId },
    ).catch((e) => {
      // Any other table that references Service (later milestones) also blocks deletion.
      if (e instanceof Error && "code" in e && e.code === "P2003")
        throw new ConflictException({ error: "service_in_use" });
      return mapDbError(e);
    });
    await this.record(p, "service.delete", id);
  }

  // ---- pricing ----------------------------------------------------------------------------------

  @Can("catalog:read")
  @Get("services/:id/price")
  async price(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Query(new ZodPipe(branchQuery)) q: z.infer<typeof branchQuery>,
  ) {
    return withTenant(this.prisma, p.tenantId, async (tx) => {
      const s = await loadService(tx, p.tenantId, id);
      await assertBranch(tx, p.tenantId, q.branchId);
      const ov = await overridesFor(tx, p.tenantId, q.branchId, [id]);
      return effectivePrice(s, q.branchId, ov.get(id));
    });
  }

  /** Full override history (closed rows included), limited to the caller's branches. */
  @Can("catalog:read")
  @Get("services/:id/overrides")
  async history(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Query(new ZodPipe(historyQuery)) q: z.infer<typeof historyQuery>,
  ) {
    const rows = await withTenant(this.prisma, p.tenantId, async (tx) => {
      await loadService(tx, p.tenantId, id);
      return tx.branchPriceOverride.findMany({
        where: {
          tenantId: p.tenantId,
          serviceId: id,
          ...(q.branchId ? { branchId: q.branchId } : {}),
          AND: [branchWhere(p)],
        },
        orderBy: [{ branchId: "asc" }, { effectiveFrom: "desc" }, { createdAt: "desc" }],
        take: 1000,
      });
    });
    return { items: rows.map(toOverride) };
  }

  /**
   * Sets/replaces the branch price: closes the open override at `effectiveFrom` (default now) and inserts
   * the new row. Past dates are rejected (no retroactive repricing); history rows are never edited.
   */
  @Can("price:override")
  @Put("services/:id/overrides")
  async setOverride(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(setPriceOverrideRequest)) body: SetPriceOverrideRequest,
  ) {
    assertCan(p, "price:override", { branchId: body.branchId });
    const now = new Date();
    const from = body.effectiveFrom ? new Date(body.effectiveFrom) : now;
    if (from.getTime() < now.getTime() - SKEW_MS)
      throw new BadRequestException({ error: "effective_date_in_past" });
    const { closed, created } = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await loadService(tx, p.tenantId, id);
        await assertBranch(tx, p.tenantId, body.branchId);
        const open = await tx.branchPriceOverride.findFirst({
          where: {
            tenantId: p.tenantId,
            serviceId: id,
            branchId: body.branchId,
            effectiveTo: null,
          },
        });
        let closed = null;
        if (open) {
          if (from <= open.effectiveFrom)
            throw new ConflictException({ error: "overlaps_scheduled_override" });
          closed = await tx.branchPriceOverride.update({
            where: { id: open.id },
            data: { effectiveTo: from },
          });
        }
        const created = await tx.branchPriceOverride.create({
          data: {
            tenantId: p.tenantId,
            serviceId: id,
            branchId: body.branchId,
            pricePaise: body.pricePaise,
            reason: body.reason,
            setBy: p.userId,
            effectiveFrom: from,
          },
        });
        return { closed, created };
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "concurrent_override" }));
    if (closed) await this.recordOverride(p, "price_override.close", closed.id, closed.branchId);
    await this.recordOverride(p, "price_override.set", created.id, created.branchId);
    return { override: toOverride(created), closed: closed ? toOverride(closed) : null };
  }

  /** Ends the open override; the branch reverts to the central price. */
  @Can("price:override")
  @Post("services/:id/overrides/clear")
  @HttpCode(200)
  async clearOverride(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(clearPriceOverrideRequest)) body: ClearPriceOverrideRequest,
  ) {
    assertCan(p, "price:override", { branchId: body.branchId });
    const closed = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await loadService(tx, p.tenantId, id);
        const open = await tx.branchPriceOverride.findFirst({
          where: {
            tenantId: p.tenantId,
            serviceId: id,
            branchId: body.branchId,
            effectiveTo: null,
          },
        });
        if (!open) return notFound();
        // A not-yet-started (scheduled) override is closed just after its start so it never applies
        // while the row (and the CHECK effectiveTo > effectiveFrom) stays intact.
        const now = Date.now();
        const end = new Date(Math.max(now, open.effectiveFrom.getTime() + 1));
        return tx.branchPriceOverride.update({
          where: { id: open.id },
          data: { effectiveTo: end },
        });
      },
      { actorId: p.userId },
    );
    await this.recordOverride(p, "price_override.clear", closed.id, closed.branchId);
    return toOverride(closed);
  }

  private write(p: Principal, id: string, data: Partial<UpdateServiceRequest>) {
    return withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const r = await tx.service.updateMany({ where: { tenantId: p.tenantId, id }, data });
        if (r.count === 0) return notFound();
        return tx.service.findUniqueOrThrow({ where: { id } });
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "service_code_taken", fk: "unknown_category" }));
  }

  private record(p: Principal, action: string, id: string) {
    return this.audit.record(p, {
      action,
      resource: "Service",
      resourceId: id,
      outcome: "success",
    });
  }

  private recordOverride(p: Principal, action: string, id: string, branchId: string) {
    return this.audit.record(p, {
      action,
      resource: "BranchPriceOverride",
      resourceId: id,
      branchId,
      outcome: "success",
    });
  }
}
