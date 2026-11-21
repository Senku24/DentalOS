import { Prisma, type PrismaClient } from "@dentalos/db";
import {
  type StockBalanceResponse,
  type StockBalancesQuery,
  type StockBatchResponse,
  type StockValuationResponse,
  isExpired,
  isLowStock,
  roundQuantity,
  stockValuePaise,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, branchFilter } from "../auth/roles";
import { assertCan } from "../common/principal";
import { DAY_MS, badRequest, runTx, todayUtc } from "./inventory-common";
import type { ExpiringBatchResponse, ExpiringBatchesQuery } from "./inventory.dto";

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

interface BalanceRow {
  branchId: string;
  itemId: string;
  sku: string;
  name: string;
  unit: StockBalanceResponse["unit"];
  quantity: number;
  avg: number;
  reorder: number;
  updatedAt: Date;
}

/** Read models over the stock ledger / balances: balances, low stock, FEFO batches, expiring batches, valuation. */
@Injectable()
export class InventoryReportsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** `AND b."branchId" = …` for an explicit branch (permission-checked) or the caller's branch scope. */
  private branchCond(p: Principal, branchId: string | undefined, col: Prisma.Sql): Prisma.Sql {
    if (branchId) {
      assertCan(p, "inventory:read", { branchId });
      return Prisma.sql`AND ${col} = ${branchId}::uuid`;
    }
    const scope = branchFilter(p);
    return scope === undefined ? Prisma.empty : Prisma.sql`AND ${col} = ANY(${scope}::uuid[])`;
  }

  private toBalance(r: BalanceRow): StockBalanceResponse {
    const quantity = roundQuantity(Number(r.quantity));
    const avg = Number(r.avg);
    const reorder = Number(r.reorder);
    return {
      branchId: r.branchId,
      itemId: r.itemId,
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      quantity,
      avgUnitCostPaise: avg,
      valuePaise: stockValuePaise(quantity, avg),
      reorderLevel: reorder,
      low: isLowStock(quantity, reorder),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private async balanceRows(
    p: Principal,
    q: StockBalancesQuery,
    includeUnstocked: boolean,
  ): Promise<{ items: StockBalanceResponse[]; nextCursor: string | null }> {
    let after = Prisma.empty;
    if (q.cursor) {
      const [sku, branchId, ...rest] = Buffer.from(q.cursor, "base64url").toString().split("|");
      if (rest.length > 0 || !sku || !branchId || !/^[0-9a-f-]{36}$/i.test(branchId))
        throw badRequest("cursor", "Invalid cursor");
      after = Prisma.sql`AND (i."sku", br."id") > (${sku}, ${branchId}::uuid)`;
    }
    const cond = this.branchCond(p, q.branchId, Prisma.sql`br."id"`);
    const item = q.itemId ? Prisma.sql`AND i."id" = ${q.itemId}::uuid` : Prisma.empty;
    const search = q.q
      ? Prisma.sql`AND (i."name" ILIKE ${like(q.q)} OR i."sku" ILIKE ${like(q.q)})`
      : Prisma.empty;
    const low =
      includeUnstocked || q.lowStockOnly
        ? Prisma.sql`AND i."reorderLevel" > 0 AND COALESCE(b."quantity", 0) <= i."reorderLevel"`
        : Prisma.empty;
    const stocked = includeUnstocked ? Prisma.empty : Prisma.sql`AND b."id" IS NOT NULL`;
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.$queryRaw<BalanceRow[]>(Prisma.sql`
        SELECT br."id" AS "branchId", i."id" AS "itemId", i."sku", i."name", i."unit"::text AS "unit",
               COALESCE(b."quantity", 0)::float8 AS "quantity",
               COALESCE(b."avgUnitCostPaise", 0)::float8 AS "avg",
               i."reorderLevel"::float8 AS "reorder",
               COALESCE(b."updatedAt", i."createdAt") AS "updatedAt"
        FROM "InventoryItem" i
        CROSS JOIN "Branch" br
        LEFT JOIN "StockBalance" b
          ON b."tenantId" = i."tenantId" AND b."itemId" = i."id" AND b."branchId" = br."id"
        WHERE i."tenantId" = ${p.tenantId}::uuid AND br."tenantId" = ${p.tenantId}::uuid
          ${includeUnstocked ? Prisma.sql`AND i."active" AND br."active"` : Prisma.empty}
          ${stocked} ${cond} ${item} ${search} ${low} ${after}
        ORDER BY i."sku", br."id"
        LIMIT ${q.limit + 1}`),
    );
    const more = rows.length > q.limit;
    const slice = more ? rows.slice(0, q.limit) : rows;
    const last = slice[slice.length - 1];
    return {
      items: slice.map((r) => this.toBalance(r)),
      nextCursor:
        more && last ? Buffer.from(`${last.sku}|${last.branchId}`).toString("base64url") : null,
    };
  }

  /** Balances per branch x item (rows exist once an item has moved at the branch). */
  balances(p: Principal, q: StockBalancesQuery) {
    return this.balanceRows(p, q, false);
  }

  /** Active items with a reorder level whose branch balance (zero when never stocked) is at or below it. */
  lowStock(p: Principal, q: StockBalancesQuery) {
    return this.balanceRows(p, q, true);
  }

  private async batchRows(
    p: Principal,
    cond: Prisma.Sql,
    itemCond: Prisma.Sql,
    having: Prisma.Sql,
    limit: number,
  ) {
    return runTx(this.prisma, p, (tx) =>
      tx.$queryRaw<
        {
          branchId: string;
          itemId: string;
          sku: string;
          name: string;
          unit: string;
          batchNo: string;
          expiryDate: Date | null;
          quantity: number;
        }[]
      >(Prisma.sql`
        SELECT m."branchId", m."itemId", i."sku", i."name", i."unit"::text AS "unit", m."batchNo",
               MAX(m."expiryDate") AS "expiryDate", SUM(m."quantity")::float8 AS "quantity"
        FROM "StockMovement" m
        JOIN "InventoryItem" i ON i."tenantId" = m."tenantId" AND i."id" = m."itemId"
        WHERE m."tenantId" = ${p.tenantId}::uuid AND m."batchNo" IS NOT NULL ${cond} ${itemCond}
        GROUP BY m."branchId", m."itemId", i."sku", i."name", i."unit", m."batchNo"
        HAVING SUM(m."quantity") > 0 ${having}
        ORDER BY MAX(m."expiryDate") NULLS LAST, i."sku", m."batchNo", m."branchId"
        LIMIT ${limit}`),
    );
  }

  /** Batches with stock for one item at one branch, first-expiry-first-out order (batches without expiry last). */
  async batches(
    p: Principal,
    q: { branchId: string; itemId: string },
  ): Promise<StockBatchResponse[]> {
    assertCan(p, "inventory:read", { branchId: q.branchId });
    const rows = await this.batchRows(
      p,
      Prisma.sql`AND m."branchId" = ${q.branchId}::uuid`,
      Prisma.sql`AND m."itemId" = ${q.itemId}::uuid`,
      Prisma.empty,
      1000,
    );
    return rows.map((r) => ({
      batchNo: r.batchNo,
      expiryDate: r.expiryDate ? r.expiryDate.toISOString().slice(0, 10) : null,
      quantity: roundQuantity(Number(r.quantity)),
    }));
  }

  /** Batches (all items) expiring within N days, already-expired ones first. */
  async expiring(
    p: Principal,
    q: ExpiringBatchesQuery,
  ): Promise<{ items: ExpiringBatchResponse[] }> {
    const today = todayUtc();
    const until = new Date(Date.parse(`${today}T00:00:00Z`) + q.withinDays * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const rows = await this.batchRows(
      p,
      this.branchCond(p, q.branchId, Prisma.sql`m."branchId"`),
      Prisma.empty,
      Prisma.sql`AND MAX(m."expiryDate") IS NOT NULL AND MAX(m."expiryDate") <= ${until}::date`,
      q.limit,
    );
    return {
      items: rows.map((r) => {
        const expiry = (r.expiryDate as Date).toISOString().slice(0, 10);
        return {
          branchId: r.branchId,
          itemId: r.itemId,
          sku: r.sku,
          name: r.name,
          unit: r.unit,
          batchNo: r.batchNo,
          expiryDate: expiry,
          quantity: roundQuantity(Number(r.quantity)),
          daysToExpiry: Math.round(
            (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
          ),
          expired: isExpired(expiry, today),
        };
      }),
    };
  }

  /** Weighted-average valuation per branch (positive balances only: an overdrawn item has no value). */
  async valuation(
    p: Principal,
    q: { branchId?: string | undefined },
  ): Promise<StockValuationResponse> {
    const cond = this.branchCond(p, q.branchId, Prisma.sql`b."branchId"`);
    const rows = await runTx(this.prisma, p, (tx) =>
      tx.$queryRaw<{ branchId: string; valuePaise: bigint; itemCount: number }[]>(Prisma.sql`
        SELECT b."branchId",
               COALESCE(SUM(ROUND(b."quantity" * b."avgUnitCostPaise")) FILTER (WHERE b."quantity" > 0), 0)::bigint AS "valuePaise",
               (COUNT(*) FILTER (WHERE b."quantity" > 0))::int AS "itemCount"
        FROM "StockBalance" b
        WHERE b."tenantId" = ${p.tenantId}::uuid ${cond}
        GROUP BY b."branchId" ORDER BY b."branchId"`),
    );
    const out = rows.map((r) => ({
      branchId: r.branchId,
      valuePaise: Number(r.valuePaise),
      itemCount: Number(r.itemCount),
    }));
    return { rows: out, totalPaise: out.reduce((a, r) => a + r.valuePaise, 0) };
  }
}
