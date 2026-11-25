import { type Tx, withTenant } from "@dentalos/db";
import type { PrismaClient } from "@dentalos/db";
import { hashClientValue } from "@dentalos/validation";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import type { PatientPrincipal } from "../auth/patient-principal";
import { type PortalSecrets, requirePortalSecrets } from "../auth/portal-token";
import type { Principal } from "../auth/roles";
import { M4_GUARD_HTTP, isUniqueViolation, m4GuardError } from "../common/db-errors";
import { ZodPipe } from "../common/zod.pipe";
import { logger } from "../observability/logger";

/** Shared helpers of the patient-facing portal API (P1). Pure mappers and small transaction helpers; no providers. */

/** Validates a UUID path parameter: `@Param("id", UUID) id: string`. */
export const UUID = new ZodPipe(z.uuid());

export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const dateOnlyOrNull = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 10) : null;

export const notFound = (error = "not_found") => new NotFoundException({ error });
export const conflict = (error: string, extra: Record<string, unknown> = {}) =>
  new ConflictException({ error, ...extra });
export const badRequest = (error: string, extra: Record<string, unknown> = {}) =>
  new BadRequestException({ error, ...extra });

/** Portal secrets are not configured: every login route answers 503 and the staff API is unaffected. */
export function secretsOr503(secrets: PortalSecrets | null): PortalSecrets {
  if (!secrets) throw new ServiceUnavailableException({ error: "portal_unavailable" });
  return requirePortalSecrets(secrets);
}

/**
 * The staff-shaped identity some shared (staff) helpers need for attribution only (`userId`, `tenantId`). It has no
 * role, so `can()` is false for every permission: it can never act as staff.
 */
export const attribution = (me: Pick<PatientPrincipal, "tenantId" | "actorId">): Principal => ({
  userId: me.actorId,
  tenantId: me.tenantId,
  roles: [],
  orgWide: false,
  branchScope: [],
});

/** Runs a tenant transaction attributed to the patient actor (`app.actor_id`). */
export function portalTx<T>(
  prisma: PrismaClient,
  me: Pick<PatientPrincipal, "tenantId" | "actorId">,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withTenant(prisma, me.tenantId, fn, { actorId: me.actorId }).catch(mapPortalDbError);
}

/** DB trigger codes of migration 0009 -> `{ error: <code> }` with the status of `M4_GUARD_HTTP` (409 default). */
export function mapPortalDbError(e: unknown): never {
  if (e instanceof HttpException) throw e;
  const code = m4GuardError(e);
  if (code) {
    const status = M4_GUARD_HTTP[code] ?? 409;
    throw new HttpException({ error: code }, status);
  }
  throw e;
}

export { isUniqueViolation };

/** Client fingerprints stored as keyed hashes only (never the raw address or user agent). */
export async function clientHashes(
  req: { ip?: string; headers: Record<string, string | string[] | undefined> },
  pepper: string,
) {
  const ua = req.headers["user-agent"];
  return {
    ipHash: req.ip ? await hashClientValue(req.ip, pepper) : null,
    uaHash: typeof ua === "string" && ua ? await hashClientValue(ua, pepper) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Keyset cursors (timestamp desc/asc + id)
// ---------------------------------------------------------------------------------------------

export const encodeCursor = (at: Date, id: string) =>
  Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");

export function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [ts, id, ...rest] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = new Date(ts ?? "");
  if (rest.length > 0 || !z.uuid().safeParse(id).success || Number.isNaN(at.getTime()))
    throw badRequest("invalid_cursor");
  return { at, id: id as string };
}

/** `limit + 1` rows fetched: returns the page and the cursor of its last row. */
export function pageOf<T extends { id: string }>(
  rows: T[],
  limit: number,
  at: (r: T) => Date,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(at(last), last.id) : null,
  };
}

/** Age in whole years on `now` (for the `minor` flag). */
export function isMinor(dob: Date | null | undefined, now = new Date()): boolean {
  if (!dob) return false;
  const y = now.getUTCFullYear() - dob.getUTCFullYear();
  const had =
    now.getUTCMonth() > dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() >= dob.getUTCDate());
  return (had ? y : y - 1) < 18;
}

export const displayName = (p: {
  firstName: string;
  lastName: string | null;
  preferredName?: string | null;
}) => [p.preferredName || p.firstName, p.lastName].filter(Boolean).join(" ");

/** Fire-and-log: a queued follow-up (notification, scrub job) must never fail the request that already committed. */
export function fireAndLog(label: string, work: Promise<unknown>): void {
  work.catch((err) => logger.error({ err: String(err) }, `portal: ${label}`));
}
