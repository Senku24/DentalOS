import { z } from "zod";

/**
 * Shared primitives and normalisers. Frontend-safe: no Prisma or Node imports.
 * Enum value lists mirror `packages/db/prisma/schema.prisma` (kept in sync by apps/api enum test).
 */

export const uuid = z.uuid();
/** Calendar date "YYYY-MM-DD" (Postgres DATE). */
export const dateOnly = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: true });
/** Integer paise (₹1 = 100 paise). Upper bound ₹1 crore guards against unit mix-ups (rupees vs paise). */
export const paise = z.number().int().min(0).max(1_000_000_000);
export const trimmed = (max = 200) => z.string().trim().min(1).max(max);
export const optionalText = (max = 2000) => z.string().trim().max(max).optional();

/** IdP subject of a staff member (Membership.userId). Not a uuid: Cognito/dev subjects are opaque strings. */
export const staffUserId = z.string().trim().min(1).max(200);

export const STAFF_ROLES = ["OWNER", "MANAGER", "DENTIST", "RECEPTIONIST", "ACCOUNTANT"] as const;
export const staffRole = z.enum(STAFF_ROLES);

/** Keyset pagination: pass back `nextCursor` from the previous page. */
export const pageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// ---------------------------------------------------------------------------------------------
// Normalisers — the single implementation for Patient.nameNormalized / phoneNormalized /
// emailNormalized and duplicate matching. Always write these columns through these functions.
// ---------------------------------------------------------------------------------------------

/** Lower-case, strip diacritics/punctuation, collapse whitespace: "  Dr. Ánanya  O'Neil " -> "ananya oneil". */
export function normalizeName(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(" ")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

/**
 * Best-effort E.164 for Indian numbers (default country +91). Returns null when unparseable.
 *  "98765 43210" | "098765-43210" | "+91 98765 43210" | "919876543210" -> "+919876543210"
 *  "+44 20 7946 0958" -> "+442079460958" (other countries kept if already in + form)
 * Indian mobiles start 6-9; landlines with STD code (e.g. 080...) are accepted as 10 digits after the 0.
 */
export function normalizePhoneIN(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) {
    if (digits.startsWith("91")) return digits.length === 12 ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10 && /^[1-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 14 && digits.startsWith("0091")) return `+${digits.slice(2)}`;
  return null;
}

/** Accepts common Indian formats and outputs E.164 ("+919876543210"). */
export const phone = z
  .string()
  .trim()
  .max(32)
  .transform((v, ctx) => {
    const n = normalizePhoneIN(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Invalid phone number" });
      return z.NEVER;
    }
    return n;
  });

export const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((v) => v.toLowerCase());

/** IANA time zone validated by the runtime's Intl database. */
export const timeZone = z
  .string()
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

/** ISO 3166-1 alpha-2, upper-case ("IN"). */
export const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/);

/**
 * PATCH pitfall (zod 4): `.partial()` keeps inner `.default()`s, so an absent key still parses to its
 * default and a PATCH would silently reset that column. Every update schema built from a create schema
 * must redeclare its defaulted fields as plain `.optional()` (see `updateBranchRequest`). The
 * validation tests assert `parse({})` is `{}` for every update schema.
 */
export const address = z.object({
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9 -]{3,12}$/)
    .optional(),
  country: countryCode.default("IN"),
});
