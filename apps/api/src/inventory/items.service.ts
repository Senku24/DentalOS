import type { Prisma, PrismaClient } from "@dentalos/db";
import type {
  CreateInventoryItemRequest,
  CreateSupplierRequest,
  ListInventoryItemsQuery,
  ListSuppliersQuery,
  UpdateInventoryItemRequest,
  UpdateSupplierRequest,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { isUniqueViolation } from "../common/db-errors";
import { assertCan } from "../common/principal";
import {
  afterCursor,
  conflict,
  notFound,
  numOr0,
  pageOf,
  runTx,
  toItemResponse,
  toSupplierResponse,
} from "./inventory-common";

/** Items (tenant-wide catalogue; stock lives per branch). Deactivated, never deleted. SKU is upper-case and unique. */
@Injectable()
export class ItemsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private record(p: Principal, action: string, resource: string, id: string) {
    return this.audit.record(p, { action, resource, resourceId: id, outcome: "success" });
  }

  async create(p: Principal, body: CreateInventoryItemRequest) {
    assertCan(p, "inventory:write");
    const item = await runTx(this.prisma, p, async (tx) => {
      const dup = await tx.inventoryItem.findFirst({
        where: { tenantId: p.tenantId, sku: body.sku },
        select: { id: true },
      });
      if (dup) throw conflict("sku_taken");
      return tx.inventoryItem.create({
        data: {
          tenantId: p.tenantId,
          sku: body.sku,
          name: body.name,
          category: body.category || null,
          unit: body.unit,
          reorderLevel: body.reorderLevel,
          tracksBatches: body.tracksBatches,
          allowOverdraw: body.allowOverdraw,
          createdBy: p.userId,
        },
      });
    }).catch((e) => {
      if (isUniqueViolation(e)) throw conflict("sku_taken");
      throw e;
    });
    await this.record(p, "inventory.item.create", "inventory_item", item.id);
    return toItemResponse(item);
  }

  async list(p: Principal, q: ListInventoryItemsQuery) {
    if (q.branchId) assertCan(p, "inventory:read", { branchId: q.branchId });
    const and: Prisma.InventoryItemWhereInput[] = [afterCursor(q.cursor)];
    if (q.q)
      and.push({
        OR: [
          { name: { contains: q.q, mode: "insensitive" } },
          { sku: { contains: q.q.toUpperCase() } },
        ],
      });
    if (q.category) and.push({ category: q.category });
    if (q.active !== undefined) and.push({ active: q.active });
    const { rows, balances } = await runTx(this.prisma, p, async (tx) => {
      const rows = await tx.inventoryItem.findMany({
        where: { tenantId: p.tenantId, AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const balances = q.branchId
        ? await tx.stockBalance.findMany({
            where: {
              tenantId: p.tenantId,
              branchId: q.branchId,
              itemId: { in: rows.map((r) => r.id) },
            },
          })
        : [];
      return { rows, balances };
    });
    const byItem = new Map(balances.map((b) => [b.itemId, b]));
    return pageOf(rows, q.limit, (i) =>
      toItemResponse(
        i,
        q.branchId
          ? {
              quantity: numOr0(byItem.get(i.id)?.quantity),
              avgUnitCostPaise: numOr0(byItem.get(i.id)?.avgUnitCostPaise),
            }
          : undefined,
      ),
    );
  }

  async get(p: Principal, id: string) {
    const item = await runTx(this.prisma, p, (tx) =>
      tx.inventoryItem.findFirst({ where: { id, tenantId: p.tenantId } }),
    );
    if (!item) throw notFound("item_not_found");
    return toItemResponse(item);
  }

  async update(p: Principal, id: string, body: UpdateInventoryItemRequest) {
    assertCan(p, "inventory:write");
    const item = await runTx(this.prisma, p, async (tx) => {
      const cur = await tx.inventoryItem.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!cur) throw notFound("item_not_found");
      return tx.inventoryItem.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.category !== undefined ? { category: body.category || null } : {}),
          ...(body.reorderLevel !== undefined ? { reorderLevel: body.reorderLevel } : {}),
          ...(body.tracksBatches !== undefined ? { tracksBatches: body.tracksBatches } : {}),
          ...(body.allowOverdraw !== undefined ? { allowOverdraw: body.allowOverdraw } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });
    });
    await this.record(p, "inventory.item.update", "inventory_item", id);
    return toItemResponse(item);
  }

  // -------------------------------------------------------------------------------------------
  // Suppliers
  // -------------------------------------------------------------------------------------------

  async createSupplier(p: Principal, body: CreateSupplierRequest) {
    assertCan(p, "inventory:write");
    const s = await runTx(this.prisma, p, async (tx) => {
      const dup = await tx.supplier.findFirst({
        where: { tenantId: p.tenantId, name: body.name },
        select: { id: true },
      });
      if (dup) throw conflict("supplier_name_taken");
      return tx.supplier.create({
        data: {
          tenantId: p.tenantId,
          name: body.name,
          contactName: body.contactName || null,
          phone: body.phone ?? null,
          email: body.email ?? null,
          gstin: body.gstin ?? null,
          address: body.address || null,
          notes: body.notes || null,
          createdBy: p.userId,
        },
      });
    }).catch((e) => {
      if (isUniqueViolation(e)) throw conflict("supplier_name_taken");
      throw e;
    });
    await this.record(p, "inventory.supplier.create", "supplier", s.id);
    return toSupplierResponse(s);
  }

  async listSuppliers(p: Principal, q: ListSuppliersQuery) {
    const and: Prisma.SupplierWhereInput[] = [afterCursor(q.cursor)];
    if (q.q) and.push({ name: { contains: q.q, mode: "insensitive" } });
    if (q.active !== undefined) and.push({ active: q.active });
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.supplier.findMany({
        where: { tenantId: p.tenantId, AND: and },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      }),
    );
    return pageOf(rows, q.limit, toSupplierResponse);
  }

  async getSupplier(p: Principal, id: string) {
    const s = await runTx(this.prisma, p, (tx) =>
      tx.supplier.findFirst({ where: { id, tenantId: p.tenantId } }),
    );
    if (!s) throw notFound("supplier_not_found");
    return toSupplierResponse(s);
  }

  async updateSupplier(p: Principal, id: string, body: UpdateSupplierRequest) {
    assertCan(p, "inventory:write");
    const s = await runTx(this.prisma, p, async (tx) => {
      const cur = await tx.supplier.findFirst({ where: { id, tenantId: p.tenantId } });
      if (!cur) throw notFound("supplier_not_found");
      if (body.name !== undefined && body.name !== cur.name) {
        const dup = await tx.supplier.findFirst({
          where: { tenantId: p.tenantId, name: body.name, NOT: { id } },
          select: { id: true },
        });
        if (dup) throw conflict("supplier_name_taken");
      }
      return tx.supplier.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.contactName !== undefined ? { contactName: body.contactName || null } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.gstin !== undefined ? { gstin: body.gstin } : {}),
          ...(body.address !== undefined ? { address: body.address || null } : {}),
          ...(body.notes !== undefined ? { notes: body.notes || null } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });
    });
    await this.record(p, "inventory.supplier.update", "supplier", id);
    return toSupplierResponse(s);
  }
}
