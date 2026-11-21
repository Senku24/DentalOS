import { createHash } from "node:crypto";
import {
  type CommissionEntry,
  type CommissionRule,
  type CommissionSettlement,
  type PrismaClient,
  type Tx,
  withTenant,
} from "@dentalos/db";
import {
  COMMISSION_ERROR_CODES,
  type CommissionEntryResponse,
  type CommissionRuleResponse,
  type SettlementResponse,
  uuid,
} from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import type { Principal } from "../auth/roles";
import { can } from "../auth/roles";
import {
  checkViolation,
  commissionOverlap,
  foreignKeyViolation,
  isRetryableTxError,
  isUniqueViolation,
  m3GuardError,
  notAMember,
  privilegeDenied,
} from "../common/db-errors";

/**
 * Shared helpers of the commissions module (ADR 0004 §7). Self-contained on purpose: no imports from the
 * other M3 modules (billing / inventory / notifications).
 */

/** Error codes of this module: the shared list plus the ones that only exist at the API layer. */
export const COMMISSION_API_ERROR_CODES = [
  ...COMMISSION_ERROR_CODES,
  "commission_rule_not_found",
  "commission_rule_closed",
  "settlement_not_found",
  "allocation_not_found",
  "idempotency_conflict",
  "link_mismatch",
  "branch_not_found",
  "not_a_member",
  "service_category_not_found",
  "not_permitted",
] as const;

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** DATE column -> "YYYY-MM-DD" (Prisma returns UTC midnight). */
export const dateStr = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
/** "YYYY-MM-DD" -> Date for a DATE column. */
export const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The calendar date of `at` in an IANA zone as "YYYY-MM-DD" (UTC when the zone is unknown). */
export function localDate(timeZone: string | null | undefined, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * The earliest "today" among the tenant's branches (the most lagging time zone): a rule is never back-dated, but
 * "today" in any branch's zone is accepted so a clinic can start a rule on its own local date.
 */
export async function earliestBranchToday(tx: Tx, now = new Date()): Promise<string> {
  const branches = await tx.branch.findMany({ select: { timezone: true } });
  const days = branches.map((b) => localDate(b.timezone, now));
  days.push(now.toISOString().slice(0, 10));
  return days.reduce((a, b) => (a < b ? a : b));
}

// ---------------------------------------------------------------------------------------------
// Errors + transactions
// ---------------------------------------------------------------------------------------------

export const badRequest = (path: string, message: string) =>
  new BadRequestException({ error: "validation_failed", issues: [{ path, message }] });

/** True when a unique violation came from the RequestDedupe key (a concurrent replay): re-run, the pre-read finds it. */
export function isDedupeRace(e: unknown): boolean {
  if (!isUniqueViolation(e)) return false;
  const err = e as { message?: unknown; meta?: { modelName?: unknown; target?: unknown } };
  const target = Array.isArray(err.meta?.target)
    ? (err.meta?.target as unknown[]).join(",")
    : String(err.meta?.target ?? "");
  return (
    err.meta?.modelName === "RequestDedupe" ||
    String(err.message ?? "").includes("RequestDedupe") ||
    (target.includes("idempotencyKey") && target.includes("scope"))
  );
}

/** Maps DB-enforced failures to stable API errors; anything unknown propagates (500). */
export function mapCommissionDbError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  const g = m3GuardError(e);
  if (g) {
    if (
      g === "commission_link_mismatch" ||
      g === "commission_rule_immutable" ||
      g === "settlement_state" ||
      g === "settlement_total_mismatch" ||
      g === "settlement_item_mismatch"
    )
      throw new ConflictException({ error: g });
  }
  const overlap = commissionOverlap(e);
  if (overlap === "rule") throw new ConflictException({ error: "commission_rule_overlap" });
  if (overlap === "settlement") throw new ConflictException({ error: "settlement_period_overlap" });
  const member = notAMember(e);
  if (member) throw new BadRequestException({ error: "not_a_member", field: member });
  const check = checkViolation(e);
  if (check)
    throw new BadRequestException({
      error: "validation_failed",
      issues: [{ path: "", message: `violates ${check}` }],
    });
  const fk = foreignKeyViolation(e);
  if (fk) throw new ConflictException({ error: "link_mismatch", constraint: fk });
  if (privilegeDenied(e)) throw e; // programming error (append-only table): 500, never masked
  if (isUniqueViolation(e)) throw new ConflictException({ error: "concurrent_edit" });
  throw e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One unit of work in the tenant context. Retries the WHOLE transaction on a serialization failure / deadlock and
 * on a concurrent RequestDedupe replay (a few attempts with jitter), then maps database errors.
 */
export async function runTx<T>(
  prisma: PrismaClient,
  p: Pick<Principal, "tenantId" | "userId">,
  fn: (tx: Tx) => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await withTenant(prisma, p.tenantId, fn, { actorId: p.userId });
    } catch (e) {
      if (i < attempts - 1 && (isRetryableTxError(e) || isDedupeRace(e))) {
        await sleep(15 + Math.random() * 45 * (i + 1));
        continue;
      }
      mapCommissionDbError(e);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Idempotent append-only writes (RequestDedupe)
// ---------------------------------------------------------------------------------------------

/** SHA-256 of the canonical (key-sorted) body without its `idempotencyKey`. */
export function hashBody(body: object): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([k, x]) => k !== "idempotencyKey" && x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canon(body)))
    .digest("hex");
}

/**
 * Inserts the RequestDedupe row FIRST (ADR 0004 §6). Returns the stored `refId` when this key was already used with the
 * same body (a replay: write nothing, answer with that row); throws 409 `idempotency_conflict` when the body differs.
 * A concurrent first use loses the unique race on the insert; `runTx` re-runs and lands here as a replay.
 */
export async function claimRequest(
  tx: Tx,
  p: Pick<Principal, "tenantId" | "userId">,
  scope: string,
  key: string,
  body: object,
  refType: string,
  refId: string,
): Promise<string | null> {
  const requestHash = hashBody(body);
  const prior = await tx.requestDedupe.findUnique({
    where: { tenantId_scope_idempotencyKey: { tenantId: p.tenantId, scope, idempotencyKey: key } },
  });
  if (prior) {
    if (prior.requestHash && prior.requestHash !== requestHash)
      throw new ConflictException({ error: "idempotency_conflict" });
    if (prior.refId) return prior.refId;
  }
  await tx.requestDedupe.create({
    data: {
      tenantId: p.tenantId,
      scope,
      idempotencyKey: key,
      requestHash,
      refType,
      refId,
      createdBy: p.userId,
    },
  });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------------

export const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  if (rest.length > 0 || !uuid.safeParse(id).success || Number.isNaN(createdAt.getTime()))
    throw badRequest("cursor", "Invalid cursor");
  return { createdAt, id: id as string };
}

/** Prisma `where` fragment: rows strictly after the cursor in (createdAt desc, id desc) order. */
export function afterCursor(cursor: string | undefined) {
  if (!cursor) return {};
  const c = decodeCursor(cursor);
  return {
    OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
  };
}

export function pageOf<T extends { createdAt: Date; id: string }, R>(
  rows: T[],
  limit: number,
  map: (r: T) => R,
): { items: R[]; nextCursor: string | null } {
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    items: slice.map(map),
    nextCursor: more && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Scope: compensation:read is "self" — a dentist sees only their own ledger; org-wide readers see everyone
// ---------------------------------------------------------------------------------------------

/** Org-wide compensation access (accountant / owner): sees every dentist. */
export const canManageCompensation = (p: Principal) => can(p, "compensation:manage");

/** May read any dentist's compensation data (org-wide principal holding compensation:read or :manage). */
export const canReadAllCompensation = (p: Principal) =>
  canManageCompensation(p) || (p.orgWide && can(p, "compensation:read"));

/** May read at least their own compensation data. */
export const canReadOwnCompensation = (p: Principal) =>
  can(p, "compensation:read", { ownerUserId: p.userId }) || canManageCompensation(p);

// ---------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------

export function toRuleResponse(r: CommissionRule): CommissionRuleResponse {
  return {
    id: r.id,
    dentistUserId: r.dentistUserId,
    type: r.type,
    percentBp: r.percentBp,
    fixedPaise: r.fixedPaise,
    serviceCategoryId: r.serviceCategoryId,
    effectiveFrom: dateStr(r.effectiveFrom) as string,
    effectiveTo: dateStr(r.effectiveTo),
    note: r.note,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    endedBy: r.endedBy,
  };
}

export type EntryRow = CommissionEntry & { settlementItem?: { id: string } | null };

export function toEntryResponse(e: EntryRow): CommissionEntryResponse {
  return {
    id: e.id,
    branchId: e.branchId,
    dentistUserId: e.dentistUserId,
    kind: e.kind,
    amountPaise: e.amountPaise,
    baseAmountPaise: e.baseAmountPaise,
    ruleId: e.ruleId,
    invoiceId: e.invoiceId,
    invoiceLineId: e.invoiceLineId,
    paymentAllocationId: e.paymentAllocationId,
    encounterId: e.encounterId,
    settlementId: e.settlementId,
    settled: e.kind === "SETTLEMENT" || (e.settlementItem ?? null) !== null,
    reason: e.reason,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
  };
}

export function toSettlementResponse(
  s: CommissionSettlement,
  itemCount?: number,
): SettlementResponse {
  return {
    id: s.id,
    dentistUserId: s.dentistUserId,
    periodStart: dateStr(s.periodStart) as string,
    periodEnd: dateStr(s.periodEnd) as string,
    status: s.status,
    totalPaise: s.totalPaise,
    ...(itemCount === undefined ? {} : { itemCount }),
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    approvedBy: s.approvedBy,
    approvedAt: iso(s.approvedAt),
    paidBy: s.paidBy,
    paidAt: iso(s.paidAt),
    paymentReference: s.paymentReference,
    notes: s.notes,
  };
}

export const notFound = (error: (typeof COMMISSION_API_ERROR_CODES)[number]) =>
  new NotFoundException({ error });
