import { Prisma, type Tx } from "@dentalos/db";
import {
  ANALYTICS_CACHE_MAX_ENTRIES,
  type AnalyticsPeriod,
  type AnalyticsPeriodPreset,
  type AnalyticsPeriodResponse,
  DEFAULT_ANALYTICS_TIME_ZONE,
  analyticsCacheKey,
  resolvePeriod,
} from "@dentalos/validation";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { type Principal, can } from "../auth/roles";

// ---------------------------------------------------------------------------------------------
// Errors (stable machine codes; ADR 0005 §4)
// ---------------------------------------------------------------------------------------------

export const ANALYTICS_ERRORS = [
  "invalid_period", // 400
  "too_many_buckets", // 400
  "invalid_cursor", // 400
  "branch_required", // 400 (a single-branch catalogue query without a branch)
  "branch_not_found", // 404
  "unknown_query", // 400
  "invalid_query_params", // 400
  "analytics_finance_forbidden", // 403 (catalogue query on money figures without finance:report)
] as const;

export const badRequest = (error: string, extra: Record<string, unknown> = {}) =>
  new BadRequestException({ error, ...extra });
export const notFound = (error: string) => new NotFoundException({ error });
export const forbidden = (error?: string) => new ForbiddenException(error ? { error } : undefined);

// ---------------------------------------------------------------------------------------------
// Periods and time zones
// ---------------------------------------------------------------------------------------------

export const validZone = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** `Tenant.settings.defaultTimeZone` (default Asia/Kolkata) for org-wide views (ADR 0005 §4.3). */
export async function tenantZone(tx: Tx): Promise<string> {
  const t = await tx.tenant.findFirst({ select: { settings: true } });
  const z = (t?.settings as { defaultTimeZone?: unknown } | null | undefined)?.defaultTimeZone;
  return validZone(z) ? z : DEFAULT_ANALYTICS_TIME_ZONE;
}

export function periodFor(
  input: { period?: AnalyticsPeriodPreset; from?: string; to?: string },
  tz: string,
  now: Date = new Date(),
): AnalyticsPeriod {
  try {
    return resolvePeriod({ preset: input.period, from: input.from, to: input.to }, tz, now);
  } catch (e) {
    if (e instanceof RangeError) throw badRequest("invalid_period", { message: e.message });
    throw e;
  }
}

export const periodResponse = (p: AnalyticsPeriod): AnalyticsPeriodResponse => ({
  preset: p.preset,
  from: p.from,
  to: p.to,
  days: p.days,
  timeZone: p.timeZone,
});

/** A "YYYY-MM-DD" local date as the UTC-midnight Date Prisma uses for `@db.Date` columns. */
export const dateOnlyToDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
export const dateToDateOnly = (d: Date) => d.toISOString().slice(0, 10);

export const num = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------------------------------------
// Scope / visibility
// ---------------------------------------------------------------------------------------------

/** Money figures need `finance:report` at EVERY branch of the set (an empty set shows nothing). */
export const financeVisibleFor = (p: Principal, branchIds: readonly string[]): boolean =>
  branchIds.length > 0 && branchIds.every((b) => can(p, "finance:report", { branchId: b }));

/** `"col" IN (uuid, ...)`; constant column text only, ids are always bound parameters. */
export function branchIn(col: string, ids: readonly string[]): Prisma.Sql {
  if (ids.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`${Prisma.raw(col)} IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})`;
}

/** Display name for staff lists: "Asha V." (first name + last initial), never the whole record. */
export function shortName(first: string, last?: string | null): string {
  const l = last?.trim();
  return l ? `${first.trim()} ${l.charAt(0).toUpperCase()}.` : first.trim();
}

export const intersect = (a: readonly string[], b: readonly string[]): string[] => {
  const s = new Set(b);
  return a.filter((x) => s.has(x));
};

// ---------------------------------------------------------------------------------------------
// In-memory TTL cache (ADR 0005 §4.7): per API instance; invalidation by TTL only
// ---------------------------------------------------------------------------------------------

interface Entry {
  expires: number;
  value: unknown;
}

export class TtlCache {
  private readonly tenants = new Map<string, Map<string, Entry>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly maxPerTenant: number = ANALYTICS_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(tenantId: string, key: string): T | undefined {
    const bucket = this.tenants.get(tenantId);
    const e = bucket?.get(key);
    if (!bucket || !e) return undefined;
    if (e.expires <= this.now()) {
      bucket.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  set(tenantId: string, key: string, value: unknown, ttlMs: number): void {
    let bucket = this.tenants.get(tenantId);
    if (!bucket) {
      bucket = new Map();
      this.tenants.set(tenantId, bucket);
    }
    bucket.delete(key); // re-insert so the oldest-first eviction order reflects the refresh
    if (bucket.size >= this.maxPerTenant) {
      const t = this.now();
      for (const [k, e] of bucket) if (e.expires <= t) bucket.delete(k);
      while (bucket.size >= this.maxPerTenant) {
        const oldest = bucket.keys().next().value;
        if (oldest === undefined) break;
        bucket.delete(oldest);
      }
    }
    bucket.set(key, { expires: this.now() + ttlMs, value });
  }

  /**
   * Cache-aside with request coalescing: concurrent identical misses share one computation (no stampede). A failed
   * computation is never cached. `T` must carry `cached` so a hit can be labelled.
   */
  async wrap<T extends { cached: boolean }>(
    tenantId: string,
    key: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const hit = this.get<T>(tenantId, key);
    if (hit) return { ...hit, cached: true };
    const flightKey = `${tenantId}\u0000${key}`;
    const running = this.inflight.get(flightKey) as Promise<T> | undefined;
    if (running) return { ...(await running), cached: false };
    const p = (async () => {
      const value = await compute();
      this.set(tenantId, key, value, ttlSeconds * 1000);
      return value;
    })();
    this.inflight.set(flightKey, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(flightKey);
    }
  }
}

/** The key helper from the contract, fed by the principal. */
export function cacheKey(
  p: Principal,
  queryId: string,
  financeVisible: boolean,
  params: Record<string, unknown>,
): string {
  return analyticsCacheKey({
    tenantId: p.tenantId,
    queryId,
    orgWide: p.orgWide,
    branchScope: p.branchScope,
    financeVisible,
    params,
  });
}

/** Offset cursors for the (tiny, fully sorted) dentist table. */
export const encodeOffset = (n: number) => Buffer.from(`o:${n}`).toString("base64url");
export function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, "base64url").toString());
  if (!m) throw badRequest("invalid_cursor");
  return Number(m[1]);
}
