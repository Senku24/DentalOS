import { Prisma, PrismaClient, type Tx } from "@dentalos/db";
import type { RevenueReportQuery } from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, branchFilter } from "../auth/roles";
import { assertCan } from "../common/principal";
import { badRequest, dayAfter, dayStartInZone, runTx } from "./billing-common";

const ZONE = "Asia/Kolkata";
const MAX_RANGE_DAYS = 800;

export interface Row {
  billedPaise: number;
  discountPaise: number;
  taxPaise: number;
  collectedPaise: number;
  refundedPaise: number;
  netCollectedPaise: number;
  outstandingPaise: number;
}
const zero = (): Row => ({
  billedPaise: 0,
  discountPaise: 0,
  taxPaise: 0,
  collectedPaise: 0,
  refundedPaise: 0,
  netCollectedPaise: 0,
  outstandingPaise: 0,
});
type Kind = RevenueReportQuery["groupBy"] | "all";

/** Constant SQL fragments only (never caller input): the key expression of each table per grouping. */
const KEYS: Record<
  Kind,
  { invoice: string | null; payment: string | null; refund: string | null }
> = {
  branch: {
    invoice: `i."branchId"::text`,
    payment: `p."branchId"::text`,
    refund: `r."branchId"::text`,
  },
  day: {
    invoice: `to_char(i."issuedAt" AT TIME ZONE '${ZONE}', 'YYYY-MM-DD')`,
    payment: `to_char(p."receivedAt" AT TIME ZONE '${ZONE}', 'YYYY-MM-DD')`,
    refund: `to_char(r."processedAt" AT TIME ZONE '${ZONE}', 'YYYY-MM-DD')`,
  },
  method: { invoice: null, payment: `p."method"::text`, refund: `r."method"::text` },
  dentist: { invoice: null, payment: null, refund: null },
  all: { invoice: `'ALL'`, payment: `'ALL'`, refund: `'ALL'` },
};

const num = (v: unknown) => Number(v ?? 0);

/** Finance reports (ADR 0004 §4.7): revenue is attributed to the invoice's branch + line dentist, cash to the payment's branch. */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private branchCond(col: string, ids: string[] | undefined): Prisma.Sql {
    if (ids === undefined) return Prisma.sql`TRUE`;
    if (ids.length === 0) return Prisma.sql`FALSE`;
    return Prisma.sql`${Prisma.raw(col)} IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})`;
  }

  private async group(
    tx: Tx,
    kind: Kind,
    from: Date,
    to: Date,
    ids: string[] | undefined,
  ): Promise<Map<string, Row>> {
    const rows = new Map<string, Row>();
    const get = (k: string) => {
      const found = rows.get(k);
      if (found) return found;
      const fresh = zero();
      rows.set(k, fresh);
      return fresh;
    };
    const keys = KEYS[kind];

    if (keys.invoice) {
      const k = Prisma.raw(keys.invoice);
      const res = await tx.$queryRaw<
        { k: string; billed: bigint; discount: bigint; tax: bigint; outstanding: bigint }[]
      >(Prisma.sql`
        SELECT ${k} AS k,
               coalesce(sum(i."totalPaise" + i."adjustmentPaise"), 0)::bigint AS billed,
               coalesce(sum(i."discountPaise"), 0)::bigint AS discount,
               coalesce(sum(i."taxPaise"), 0)::bigint AS tax,
               coalesce(sum(CASE WHEN i."status" IN ('ISSUED','PARTIALLY_PAID') THEN i."balancePaise" ELSE 0 END), 0)::bigint AS outstanding
          FROM "Invoice" i
         WHERE i."status" IN ('ISSUED','PARTIALLY_PAID','PAID')
           AND i."issuedAt" >= ${from} AND i."issuedAt" < ${to}
           AND ${this.branchCond(`i."branchId"`, ids)}
         GROUP BY 1`);
      for (const r of res) {
        const row = get(r.k);
        row.billedPaise = num(r.billed);
        row.discountPaise = num(r.discount);
        row.taxPaise = num(r.tax);
        row.outstandingPaise = num(r.outstanding);
      }
    }
    if (keys.payment) {
      const k = Prisma.raw(keys.payment);
      const res = await tx.$queryRaw<{ k: string; amount: bigint }[]>(Prisma.sql`
        SELECT ${k} AS k, coalesce(sum(p."amountPaise"), 0)::bigint AS amount
          FROM "Payment" p
         WHERE p."status" = 'RECORDED' AND p."receivedAt" >= ${from} AND p."receivedAt" < ${to}
           AND ${this.branchCond(`p."branchId"`, ids)}
         GROUP BY 1`);
      for (const r of res) get(r.k).collectedPaise = num(r.amount);
    }
    if (keys.refund) {
      const k = Prisma.raw(keys.refund);
      const res = await tx.$queryRaw<{ k: string; amount: bigint }[]>(Prisma.sql`
        SELECT ${k} AS k, coalesce(sum(r."amountPaise"), 0)::bigint AS amount
          FROM "Refund" r
         WHERE r."status" = 'PROCESSED' AND r."processedAt" >= ${from} AND r."processedAt" < ${to}
           AND ${this.branchCond(`r."branchId"`, ids)}
         GROUP BY 1`);
      for (const r of res) get(r.k).refundedPaise = num(r.amount);
    }
    if (kind === "dentist") {
      // Lines carry the dentist; invoice-level and cash amounts are spread pro rata over the invoice's lines.
      const billed = await tx.$queryRaw<
        { k: string; billed: bigint; discount: bigint; tax: bigint; outstanding: bigint }[]
      >(Prisma.sql`
        SELECT coalesce(l."dentistUserId", 'UNATTRIBUTED') AS k,
               coalesce(sum(l."totalPaise"), 0)::bigint AS billed,
               coalesce(sum(l."discountPaise" + l."allocatedDiscountPaise"), 0)::bigint AS discount,
               coalesce(sum(l."cgstPaise" + l."sgstPaise" + l."igstPaise"), 0)::bigint AS tax,
               round(coalesce(sum(CASE WHEN i."status" IN ('ISSUED','PARTIALLY_PAID') AND ls."s" > 0
                                       THEN i."balancePaise"::numeric * l."totalPaise" / ls."s" ELSE 0 END), 0))::bigint AS outstanding
          FROM "InvoiceLine" l
          JOIN "Invoice" i ON i."id" = l."invoiceId"
          JOIN (SELECT "invoiceId", sum("totalPaise") AS s FROM "InvoiceLine" GROUP BY 1) ls ON ls."invoiceId" = i."id"
         WHERE i."status" IN ('ISSUED','PARTIALLY_PAID','PAID')
           AND i."issuedAt" >= ${from} AND i."issuedAt" < ${to}
           AND ${this.branchCond(`i."branchId"`, ids)}
         GROUP BY 1`);
      for (const r of billed) {
        const row = get(r.k);
        row.billedPaise = num(r.billed);
        row.discountPaise = num(r.discount);
        row.taxPaise = num(r.tax);
        row.outstandingPaise = num(r.outstanding);
      }
      const cash = await tx.$queryRaw<
        { k: string; collected: bigint; refunded: bigint }[]
      >(Prisma.sql`
        SELECT coalesce(l."dentistUserId", 'UNATTRIBUTED') AS k,
               round(coalesce(sum(CASE WHEN a."amountPaise" > 0 THEN a."amountPaise"::numeric * l."totalPaise" / ls."s" ELSE 0 END), 0))::bigint AS collected,
               round(coalesce(sum(CASE WHEN a."amountPaise" < 0 THEN -a."amountPaise"::numeric * l."totalPaise" / ls."s" ELSE 0 END), 0))::bigint AS refunded
          FROM "PaymentAllocation" a
          JOIN "Invoice" i ON i."id" = a."invoiceId"
          JOIN "InvoiceLine" l ON l."invoiceId" = i."id"
          JOIN (SELECT "invoiceId", sum("totalPaise") AS s FROM "InvoiceLine" GROUP BY 1) ls ON ls."invoiceId" = i."id"
         WHERE ls."s" > 0 AND a."createdAt" >= ${from} AND a."createdAt" < ${to}
           AND ${this.branchCond(`i."branchId"`, ids)}
         GROUP BY 1`);
      for (const r of cash) {
        const row = get(r.k);
        row.collectedPaise = num(r.collected);
        row.refundedPaise = num(r.refunded);
      }
    }
    for (const r of rows.values()) r.netCollectedPaise = r.collectedPaise - r.refundedPaise;
    return rows;
  }

  async revenue(p: Principal, q: RevenueReportQuery) {
    if (q.to < q.from) throw badRequest("invalid_range");
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > MAX_RANGE_DAYS)
      throw badRequest("range_too_large");
    if (q.branchId) assertCan(p, "finance:report", { branchId: q.branchId });
    const ids = q.branchId ? [q.branchId] : branchFilter(p);
    const from = dayStartInZone(q.from, ZONE);
    const to = dayStartInZone(dayAfter(q.to), ZONE);

    const res = await runTx(this.prisma, p, async (tx) => {
      const grouped = await this.group(tx, q.groupBy, from, to, ids);
      const total = (await this.group(tx, "all", from, to, ids)).get("ALL") ?? zero();
      const labels = new Map<string, string>();
      if (q.groupBy === "branch") {
        for (const b of await tx.branch.findMany({ where: { id: { in: [...grouped.keys()] } } }))
          labels.set(b.id, b.name);
      } else if (q.groupBy === "dentist") {
        const subs = [...grouped.keys()].filter((k) => k !== "UNATTRIBUTED");
        for (const m of await tx.membership.findMany({ where: { userId: { in: subs } } }))
          if (m.displayName) labels.set(m.userId, m.displayName);
      }
      const rows = [...grouped.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, r]) => ({ key, label: labels.get(key) ?? null, ...r }));
      return { from: q.from, to: q.to, groupBy: q.groupBy, rows, totals: total };
    });
    await this.audit.record(p, {
      action: "report.revenue",
      resource: "report",
      branchId: q.branchId,
      outcome: "success",
    });
    return res;
  }
}
