import { Prisma } from "@dentalos/db";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { ZodPipe } from "../common/zod.pipe";

/**
 * Shared HTTP helpers for the org, catalog and documents modules (owned by the same worker).
 * Kept free of Nest providers so the feature modules only depend on the @Global AppModule providers.
 */

/** Validates a UUID path parameter: `@Param("id", UUID) id: string`. */
export const UUID = new ZodPipe(z.uuid());

const isKnown = (e: unknown, code: string): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;

/** Unique-constraint violation (incl. partial unique indexes on effective-dated rows). */
export const isUniqueViolation = (e: unknown) => isKnown(e, "P2002");
/** Foreign-key violation (composite tenant FKs: the parent does not exist in this tenant). */
export const isFkViolation = (e: unknown) => isKnown(e, "P2003");

/** Maps well-known Prisma errors to HTTP errors; rethrows everything else unchanged. */
export function mapDbError(e: unknown, messages: { conflict?: string; fk?: string } = {}): never {
  if (isUniqueViolation(e)) throw new ConflictException({ error: messages.conflict ?? "conflict" });
  if (isFkViolation(e))
    throw new BadRequestException({ error: messages.fk ?? "invalid_reference" });
  if (isKnown(e, "P2025")) throw new NotFoundException();
  throw e;
}

export function notFound(): never {
  throw new NotFoundException();
}

/** Keyset page: fetch `limit + 1` rows, return `limit` and the cursor of the last returned row. */
export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

/** Today's calendar date ("YYYY-MM-DD") in an IANA zone — assignment dates are branch-local. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "YYYY-MM-DD" -> Date at UTC midnight (Prisma `@db.Date`). */
export const dateFromDay = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** Prisma `@db.Date` value -> "YYYY-MM-DD". */
export const dayFromDate = (d: Date) => d.toISOString().slice(0, 10);
