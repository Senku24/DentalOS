import type {
  CommissionEntryResponse,
  CommissionRuleResponse,
  SettlementDetailResponse,
  SettlementResponse,
} from "@dentalos/validation";
import type { Method, MockHandler } from "./client";
import { mapHttpError } from "./errors";
import { branches, categories, fid } from "./fixtures";
import { mockHandler as m1 } from "./mock";
import { API_PREFIX } from "./routes";

/**
 * Mock mode for the compensation screens: a small in-memory ledger behind the routes of
 * apps/api/src/commissions (rules with supersede / close, ledger, settlement DRAFT -> APPROVED -> PAID with
 * frozen items, statements). Anything else falls through to the shared M1 mock (branches, staff, catalogue).
 */

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw mapHttpError(status, { error, ...extra });
};
const DAY = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset * DAY).toISOString();
const day = (offset: number) => iso(offset).slice(0, 10);
const B = branches.filter((b) => b.active).map((b) => b.id);
const ME = "dev-user";
const D1 = "usr-dent-1";
const D2 = "usr-dent-2";
const D3 = "usr-dent-3";
let seq = 5000;
const nid = (kind: string) => fid(kind, seq++);

const rules: CommissionRuleResponse[] = [
  rule("Default 30% of collected", null, "PERCENT_OF_COLLECTED", 3000, null, null, -120),
  rule("Neha Iyer 40% of collected", D1, "PERCENT_OF_COLLECTED", 4000, null, null, -90),
  rule(
    "Endodontics flat fee",
    null,
    "FIXED_PER_PROCEDURE",
    null,
    150_000,
    categories.find((c) => c.name === "Endodontics")?.id ?? null,
    -60,
  ),
  rule("Arjun Bhatia 25% of billed", D2, "PERCENT_OF_BILLED", 2500, null, null, -45),
];
function rule(
  note: string,
  dentistUserId: string | null,
  type: CommissionRuleResponse["type"],
  percentBp: number | null,
  fixedPaise: number | null,
  serviceCategoryId: string | null,
  from: number,
): CommissionRuleResponse {
  return {
    id: nid("2a"),
    dentistUserId,
    type,
    percentBp,
    fixedPaise,
    serviceCategoryId,
    effectiveFrom: day(from),
    effectiveTo: null,
    note,
    createdBy: "usr-owner-1",
    createdAt: iso(from),
    endedBy: null,
  };
}

const entries: (CommissionEntryResponse & { settlementItemId?: string })[] = [];
function entry(
  dentistUserId: string,
  kind: CommissionEntryResponse["kind"],
  amountPaise: number,
  ago: number,
  reason: string | null = null,
  ruleId: string | null = rules[0]?.id ?? null,
): CommissionEntryResponse {
  const e: CommissionEntryResponse = {
    id: nid("2b"),
    branchId: B[entries.length % Math.max(1, B.length)] as string,
    dentistUserId,
    kind,
    amountPaise,
    baseAmountPaise: kind === "ACCRUAL" ? Math.round(amountPaise / 0.3) : 0,
    ruleId: kind === "ACCRUAL" || kind === "REVERSAL" ? ruleId : null,
    invoiceId: kind === "ACCRUAL" || kind === "REVERSAL" ? fid("30", 100 + entries.length) : null,
    invoiceLineId:
      kind === "ACCRUAL" || kind === "REVERSAL" ? fid("31", 100 + entries.length) : null,
    paymentAllocationId:
      kind === "ACCRUAL" || kind === "REVERSAL" ? fid("32", 100 + entries.length) : null,
    encounterId: null,
    settlementId: null,
    settled: false,
    reason,
    createdBy: ME,
    createdAt: iso(-ago),
  };
  entries.push(e);
  return e;
}
for (const [d, base] of [
  [D1, 60_000],
  [D2, 42_000],
  [D3, 30_000],
] as const)
  for (let i = 0; i < 6; i++) entry(d, "ACCRUAL", base + i * 3_500, 55 - i * 8);
entry(D1, "REVERSAL", -18_000, 12, null);
entry(D2, "ADJUSTMENT", 5_000, 20, "Goodwill correction for the March camp");

const settlements: (SettlementResponse & { entryIds: string[] })[] = [];
const dedupe = new Map<string, { sig: string; out: unknown }>();

const toSettlement = (s: (typeof settlements)[number]): SettlementResponse => {
  const { entryIds, ...rest } = s;
  return { ...rest, itemCount: entryIds.length };
};
const find = (id: string) =>
  settlements.find((s) => s.id === id) ?? fail(404, "settlement_not_found");

type Q = Record<string, string>;
const pageOf = <T>(rows: T[], q: Q) => {
  const limit = Math.min(Number(q.limit) || 25, 100);
  const off = Number(q.cursor) || 0;
  return {
    items: rows.slice(off, off + limit),
    nextCursor: off + limit < rows.length ? String(off + limit) : null,
  };
};
const self = (q: Q) => q.dentistUserId ?? D1;
const sum = (rows: { amountPaise: number }[]) => rows.reduce((a, r) => a + r.amountPaise, 0);
const backdated = (path: string, d: string) => {
  if (d < day(0))
    fail(400, "validation_failed", { issues: [{ path, message: "Rules are never back-dated" }] });
};

type Route = [Method, RegExp, (m: string[], q: Q, b: Record<string, unknown>) => unknown];
const U = "([0-9a-f-]{36})";
const routes: Route[] = [
  [
    "GET",
    /^\/commission-rules$/,
    (_m, q) =>
      pageOf(
        [...rules]
          .reverse()
          .filter(
            (r) =>
              (!q.dentistUserId || r.dentistUserId === q.dentistUserId) &&
              (!q.serviceCategoryId || r.serviceCategoryId === q.serviceCategoryId) &&
              (q.defaultsOnly !== "true" || r.dentistUserId === null) &&
              (q.open !== "true" || r.effectiveTo === null) &&
              (!q.asOf ||
                (r.effectiveFrom <= q.asOf && (!r.effectiveTo || q.asOf < r.effectiveTo))),
          ),
        q,
      ),
  ],
  [
    "POST",
    /^\/commission-rules$/,
    (_m, _q, b) => {
      backdated("effectiveFrom", String(b.effectiveFrom));
      const clash = rules.find(
        (r) =>
          r.dentistUserId === ((b.dentistUserId as string) ?? null) &&
          r.serviceCategoryId === ((b.serviceCategoryId as string) ?? null) &&
          (r.effectiveTo === null || r.effectiveTo > String(b.effectiveFrom)),
      );
      if (clash)
        fail(409, "commission_rule_overlap", {
          conflictingRuleId: clash.id,
          hint: "supersede or close the rule in force first",
        });
      const r: CommissionRuleResponse = {
        id: nid("2a"),
        dentistUserId: (b.dentistUserId as string) ?? null,
        type: (b.type as CommissionRuleResponse["type"]) ?? "PERCENT_OF_COLLECTED",
        percentBp: (b.percentBp as number) ?? null,
        fixedPaise: (b.fixedPaise as number) ?? null,
        serviceCategoryId: (b.serviceCategoryId as string) ?? null,
        effectiveFrom: String(b.effectiveFrom),
        effectiveTo: null,
        note: (b.note as string) ?? null,
        createdBy: ME,
        createdAt: new Date().toISOString(),
        endedBy: null,
      };
      rules.push(r);
      return r;
    },
  ],
  [
    "GET",
    new RegExp(`^/commission-rules/${U}$`),
    ([id]) => rules.find((r) => r.id === id) ?? fail(404, "commission_rule_not_found"),
  ],
  [
    "POST",
    new RegExp(`^/commission-rules/${U}/supersede$`),
    ([id], _q, b) => {
      const old = rules.find((r) => r.id === id) ?? fail(404, "commission_rule_not_found");
      if (old.effectiveTo) fail(409, "commission_rule_closed");
      backdated("effectiveFrom", String(b.effectiveFrom));
      if (String(b.effectiveFrom) <= old.effectiveFrom)
        fail(400, "validation_failed", {
          issues: [
            {
              path: "effectiveFrom",
              message: "Must be after the start of the rule being replaced",
            },
          ],
        });
      old.effectiveTo = String(b.effectiveFrom);
      old.endedBy = ME;
      const r: CommissionRuleResponse = {
        ...old,
        id: nid("2a"),
        type: (b.type as CommissionRuleResponse["type"]) ?? "PERCENT_OF_COLLECTED",
        percentBp: (b.percentBp as number) ?? null,
        fixedPaise: (b.fixedPaise as number) ?? null,
        effectiveFrom: String(b.effectiveFrom),
        effectiveTo: null,
        note: (b.note as string) ?? null,
        createdBy: ME,
        createdAt: new Date().toISOString(),
        endedBy: null,
      };
      rules.push(r);
      return r;
    },
  ],
  [
    "POST",
    new RegExp(`^/commission-rules/${U}/close$`),
    ([id], _q, b) => {
      const old = rules.find((r) => r.id === id) ?? fail(404, "commission_rule_not_found");
      if (old.effectiveTo) fail(409, "commission_rule_closed");
      backdated("effectiveTo", String(b.effectiveTo));
      if (String(b.effectiveTo) <= old.effectiveFrom)
        fail(400, "validation_failed", {
          issues: [{ path: "effectiveTo", message: "Must be after the start of the rule" }],
        });
      old.effectiveTo = String(b.effectiveTo);
      old.endedBy = ME;
      return old;
    },
  ],
  [
    "GET",
    /^\/commission-entries$/,
    (_m, q) =>
      pageOf(
        [...entries]
          .reverse()
          .filter(
            (e) =>
              (!q.dentistUserId || e.dentistUserId === q.dentistUserId) &&
              (!q.branchId || e.branchId === q.branchId) &&
              (!q.invoiceId || e.invoiceId === q.invoiceId) &&
              (!q.kind || e.kind === q.kind) &&
              (q.settled === undefined || String(e.settled) === q.settled) &&
              (!q.from || e.createdAt.slice(0, 10) >= q.from) &&
              (!q.to || e.createdAt.slice(0, 10) <= q.to),
          ),
        q,
      ),
  ],
  [
    "POST",
    /^\/commission-entries\/adjustments$/,
    (_m, _q, b) => {
      const key = `adj|${String(b.idempotencyKey)}`;
      const sig = JSON.stringify(b);
      const prev = dedupe.get(key);
      if (prev) {
        if (prev.sig !== sig) fail(409, "idempotency_conflict");
        return prev.out;
      }
      const e = entry(
        String(b.dentistUserId),
        "ADJUSTMENT",
        Number(b.amountPaise),
        0,
        String(b.reason),
      );
      e.branchId = String(b.branchId);
      dedupe.set(key, { sig, out: e });
      return e;
    },
  ],
  [
    "GET",
    /^\/commission-settlements$/,
    (_m, q) =>
      pageOf(
        [...settlements]
          .reverse()
          .filter(
            (s) =>
              (!q.dentistUserId || s.dentistUserId === q.dentistUserId) &&
              (!q.status || s.status === q.status) &&
              (!q.from || s.periodStart >= q.from) &&
              (!q.to || s.periodEnd <= q.to),
          )
          .map(toSettlement),
        q,
      ),
  ],
  [
    "POST",
    /^\/commission-settlements$/,
    (_m, _q, b) => {
      const key = `set|${String(b.idempotencyKey)}`;
      const sig = JSON.stringify(b);
      const prev = dedupe.get(key);
      if (prev) {
        if (prev.sig !== sig) fail(409, "idempotency_conflict");
        return prev.out;
      }
      if (String(b.periodEnd) <= String(b.periodStart))
        fail(400, "validation_failed", {
          issues: [{ path: "periodEnd", message: "Must be after periodStart" }],
        });
      if (
        settlements.some(
          (s) =>
            s.dentistUserId === b.dentistUserId &&
            s.periodStart < String(b.periodEnd) &&
            String(b.periodStart) < s.periodEnd,
        )
      )
        fail(409, "settlement_period_overlap");
      const open = entries.filter(
        (e) =>
          e.dentistUserId === b.dentistUserId &&
          e.kind !== "SETTLEMENT" &&
          !e.settled &&
          e.createdAt.slice(0, 10) < String(b.periodEnd),
      );
      const total = sum(open);
      if (open.length === 0 || total <= 0)
        fail(409, "settlement_nothing_to_settle", {
          unsettledEntries: open.length,
          totalPaise: total,
        });
      const s = {
        id: nid("2c"),
        dentistUserId: String(b.dentistUserId),
        periodStart: String(b.periodStart),
        periodEnd: String(b.periodEnd),
        status: "DRAFT" as const,
        totalPaise: total,
        createdBy: ME,
        createdAt: new Date().toISOString(),
        approvedBy: null,
        approvedAt: null,
        paidBy: null,
        paidAt: null,
        paymentReference: null,
        notes: (b.notes as string) ?? null,
        entryIds: open.map((e) => e.id),
      };
      for (const e of open) {
        e.settled = true;
        e.settlementId = s.id;
      }
      settlements.push(s);
      const out = toSettlement(s);
      dedupe.set(key, { sig, out });
      return out;
    },
  ],
  [
    "GET",
    new RegExp(`^/commission-settlements/${U}$`),
    ([id]) => {
      const s = find(id as string);
      const items = s.entryIds.map((eid) => {
        const entryRow = entries.find((e) => e.id === eid) as CommissionEntryResponse;
        return { id: nid("2d"), entryId: eid, amountPaise: entryRow.amountPaise, entry: entryRow };
      });
      const out: SettlementDetailResponse = { ...toSettlement(s), items };
      return out;
    },
  ],
  [
    "DELETE",
    new RegExp(`^/commission-settlements/${U}$`),
    ([id]) => {
      const s = find(id as string);
      if (s.status !== "DRAFT") fail(409, "settlement_state", { status: s.status });
      for (const e of entries)
        if (e.settlementId === s.id && e.kind !== "SETTLEMENT") {
          e.settled = false;
          e.settlementId = null;
        }
      settlements.splice(settlements.indexOf(s), 1);
      return undefined;
    },
  ],
  [
    "POST",
    new RegExp(`^/commission-settlements/${U}/approve$`),
    ([id], _q, b) => {
      const s = find(id as string);
      if (s.status !== "DRAFT") fail(409, "settlement_state", { status: s.status });
      if (s.createdBy === ME) fail(409, "settlement_self_approval");
      s.status = "APPROVED";
      s.approvedBy = ME;
      s.approvedAt = new Date().toISOString();
      if (b.note) s.notes = [s.notes, b.note].filter(Boolean).join("\n");
      return toSettlement(s);
    },
  ],
  [
    "POST",
    new RegExp(`^/commission-settlements/${U}/pay$`),
    ([id], _q, b) => {
      const s = find(id as string);
      if (s.status !== "APPROVED") fail(409, "settlement_state", { status: s.status });
      s.status = "PAID";
      s.paidBy = ME;
      s.paidAt = b.paidOn ? `${String(b.paidOn)}T09:00:00.000Z` : new Date().toISOString();
      s.paymentReference = (b.paymentReference as string) ?? null;
      const pay = entry(s.dentistUserId, "SETTLEMENT", -s.totalPaise, 0, "payout");
      pay.settlementId = s.id;
      pay.settled = true;
      return toSettlement(s);
    },
  ],
  [
    "GET",
    /^\/compensation\/statement$/,
    (_m, q) => {
      const d = self(q);
      const from = q.from ?? "";
      const to = q.to ?? "";
      if (String(q.to) < String(q.from))
        fail(400, "validation_failed", {
          issues: [{ path: "to", message: "Must not be before from" }],
        });
      const inPeriod = entries.filter(
        (e) =>
          e.dentistUserId === d &&
          e.createdAt.slice(0, 10) >= from &&
          e.createdAt.slice(0, 10) <= to &&
          (!q.branchId || e.branchId === q.branchId),
      );
      const by = (k: string) => sum(inPeriod.filter((e) => e.kind === k));
      const all = entries.filter((e) => e.dentistUserId === d && e.createdAt.slice(0, 10) <= to);
      return {
        dentistUserId: d,
        from: q.from,
        to: q.to,
        accruedPaise: by("ACCRUAL"),
        reversedPaise: by("REVERSAL"),
        adjustedPaise: by("ADJUSTMENT"),
        settledPaise: by("SETTLEMENT"),
        netPaise: sum(inPeriod),
        payableBalancePaise: sum(all),
        entries: inPeriod,
      };
    },
  ],
  [
    "POST",
    new RegExp(`^/commissions/accrue/${U}$`),
    ([id]) => {
      const hit = entries.find((e) => e.paymentAllocationId === id);
      if (!hit)
        return {
          allocationId: id,
          status: "not_found",
          entries: [],
          skipped: [{ invoiceLineId: null, reason: "allocation_not_found" }],
        };
      return { allocationId: id, status: "noop", entries: [], skipped: [] };
    },
  ],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const commissionsMockHandler: MockHandler = async (method, fullPath, query, body) => {
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) : fullPath;
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (!match) continue;
    await sleep(120);
    return structuredClone(
      h(match.slice(1).map(decodeURIComponent), query, (body ?? {}) as Record<string, unknown>),
    );
  }
  return m1(method, fullPath, query, body);
};
