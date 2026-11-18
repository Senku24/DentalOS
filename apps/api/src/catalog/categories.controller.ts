import { PrismaClient, type ServiceCategory, withTenant } from "@dentalos/db";
import {
  type CreateServiceCategoryRequest,
  type UpdateServiceCategoryRequest,
  createServiceCategoryRequest,
  updateServiceCategoryRequest,
} from "@dentalos/validation";
import {
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
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { UUID, mapDbError, notFound } from "../org/http";

const toCategory = (c: ServiceCategory) => ({
  id: c.id,
  name: c.name,
  sortOrder: c.sortOrder,
  active: c.active,
});

const listCategoriesQuery = z.object({ active: z.stringbool().optional() });

/** Service categories: tenant-wide read (`catalog:read`), org-wide write (`catalog:manage`). */
@Controller("catalog/categories")
export class CategoriesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Can("catalog:read")
  @Get()
  async list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listCategoriesQuery)) q: z.infer<typeof listCategoriesQuery>,
  ) {
    const rows = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.serviceCategory.findMany({
        where: { tenantId: p.tenantId, active: q.active },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
    );
    return { items: rows.map(toCategory) };
  }

  @Can("catalog:read")
  @Get(":id")
  async get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    const c = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.serviceCategory.findFirst({ where: { tenantId: p.tenantId, id } }),
    );
    return c ? toCategory(c) : notFound();
  }

  @Can("catalog:manage")
  @Post()
  async create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createServiceCategoryRequest)) body: CreateServiceCategoryRequest,
  ) {
    const c = await withTenant(
      this.prisma,
      p.tenantId,
      (tx) => tx.serviceCategory.create({ data: { ...body, tenantId: p.tenantId } }),
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "category_name_taken" }));
    await this.record(p, "service_category.create", c.id);
    return toCategory(c);
  }

  @Can("catalog:manage")
  @Patch(":id")
  async update(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(updateServiceCategoryRequest)) body: UpdateServiceCategoryRequest,
  ) {
    const c = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const r = await tx.serviceCategory.updateMany({
          where: { tenantId: p.tenantId, id },
          data: body,
        });
        if (r.count === 0) return notFound();
        return tx.serviceCategory.findUniqueOrThrow({ where: { id } });
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { conflict: "category_name_taken" }));
    await this.record(p, "service_category.update", id);
    return toCategory(c);
  }

  /** Hard delete only while no service references the category; otherwise deactivate it instead. */
  @Can("catalog:manage")
  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const c = await tx.serviceCategory.findFirst({ where: { tenantId: p.tenantId, id } });
        if (!c) return notFound();
        const used = await tx.service.count({ where: { tenantId: p.tenantId, categoryId: id } });
        if (used > 0) throw new ConflictException({ error: "category_in_use" });
        await tx.serviceCategory.delete({ where: { id } });
      },
      { actorId: p.userId },
    ).catch((e) => mapDbError(e, { fk: "category_in_use" }));
    await this.record(p, "service_category.delete", id);
  }

  private record(p: Principal, action: string, id: string) {
    return this.audit.record(p, {
      action,
      resource: "ServiceCategory",
      resourceId: id,
      outcome: "success",
    });
  }
}
