import { PrismaClient, withTenant } from "@dentalos/db";
import {
  type CreateChairRequest,
  type ListChairsQuery,
  type UpdateChairRequest,
  createChairRequest,
  listChairsQuery,
  updateChairRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Can, PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal, assertCan, withBranchScope } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { UUID, findBranchOr404, rethrowDb, toChair } from "./scheduling-common";

/** Chairs (operatories): branch-owned, deactivated never deleted (DB grants). */
@Injectable()
export class ChairsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal, q: ListChairsQuery) {
    if (q.branchId) assertCan(p, "appointment:read", { branchId: q.branchId });
    const where = {
      ...(q.branchId ? { branchId: q.branchId } : {}),
      ...(q.active !== undefined ? { active: q.active } : {}),
    };
    const rows = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.chair.findMany({
        where: withBranchScope(p, where),
        orderBy: [{ branchId: "asc" }, { code: "asc" }],
      }),
    );
    return { items: rows.map(toChair) };
  }

  async get(p: Principal, id: string) {
    const c = await withTenant(this.prisma, p.tenantId, (tx) =>
      tx.chair.findUnique({ where: { id } }),
    );
    if (!c) throw new NotFoundException({ error: "chair_not_found" });
    assertCan(p, "appointment:read", { branchId: c.branchId });
    return toChair(c);
  }

  async create(p: Principal, body: CreateChairRequest) {
    assertCan(p, "schedule:manage", { branchId: body.branchId });
    const c = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        await findBranchOr404(tx, body.branchId);
        return tx.chair.create({
          data: { tenantId: p.tenantId, branchId: body.branchId, code: body.code, name: body.name },
        });
      },
      { actorId: p.userId },
    ).catch((e) => rethrowDb(e, { conflict: "chair_code_taken" }));
    await this.audit.record(p, {
      action: "chair.create",
      resource: "Chair",
      resourceId: c.id,
      branchId: c.branchId,
      outcome: "success",
    });
    return toChair(c);
  }

  async update(p: Principal, id: string, body: UpdateChairRequest) {
    const c = await withTenant(
      this.prisma,
      p.tenantId,
      async (tx) => {
        const cur = await tx.chair.findUnique({ where: { id } });
        if (!cur) throw new NotFoundException({ error: "chair_not_found" });
        assertCan(p, "schedule:manage", { branchId: cur.branchId });
        return tx.chair.update({ where: { id }, data: body });
      },
      { actorId: p.userId },
    ).catch((e) => rethrowDb(e, { conflict: "chair_code_taken" }));
    await this.audit.record(p, {
      action:
        body.active === undefined
          ? "chair.update"
          : body.active
            ? "chair.activate"
            : "chair.deactivate",
      resource: "Chair",
      resourceId: c.id,
      branchId: c.branchId,
      outcome: "success",
    });
    return toChair(c);
  }
}

@Controller("chairs")
export class ChairsController {
  constructor(private readonly chairs: ChairsService) {}

  @Can("appointment:read")
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listChairsQuery)) q: ListChairsQuery) {
    return this.chairs.list(p, q);
  }

  @Can("appointment:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    return this.chairs.get(p, id);
  }

  @Can("schedule:manage")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createChairRequest)) body: CreateChairRequest,
  ) {
    return this.chairs.create(p, body);
  }

  @Can("schedule:manage")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Param("id", UUID) id: string,
    @Body(new ZodPipe(updateChairRequest)) body: UpdateChairRequest,
  ) {
    return this.chairs.update(p, id, body);
  }

  @Can("schedule:manage")
  @Post(":id/activate")
  @HttpCode(200)
  activate(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    return this.chairs.update(p, id, { active: true });
  }

  @Can("schedule:manage")
  @Post(":id/deactivate")
  @HttpCode(200)
  deactivate(@CurrentPrincipal() p: Principal, @Param("id", UUID) id: string) {
    return this.chairs.update(p, id, { active: false });
  }
}
