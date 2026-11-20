/**
 * Maps database-enforced M2 rules to stable API error codes. Prisma surfaces exclusion violations
 * and trigger RAISEs as PrismaClientUnknownRequestError (no `.code`), with the Postgres SQLSTATE and
 * message embedded in `message`; raw queries surface P2010 with `meta.code`/`meta.message`. Both
 * shapes are handled by looking at the text, which is what Prisma reliably exposes.
 *
 *   try { ... } catch (e) {
 *     const c = slotConflict(e); if (c) throw new ConflictException({ error: "slot_conflict", resource: c });
 *     const g = clinicalGuardError(e); if (g) throw new ConflictException({ error: g });
 *     const m = notAMember(e); if (m) throw new BadRequestException({ error: "not_a_member", field: m });
 *     throw e;
 *   }
 */

const text = (e: unknown): string => {
  if (!e || typeof e !== "object") return "";
  const meta = (e as { meta?: { code?: unknown; message?: unknown } }).meta;
  return [
    String((e as { message?: unknown }).message ?? ""),
    String(meta?.code ?? ""),
    String(meta?.message ?? ""),
  ].join(" ");
};

/** SQLSTATE 23P01 on the appointment exclusion constraints -> which resource is double-booked. */
export function slotConflict(e: unknown): "dentist" | "chair" | null {
  const t = text(e);
  if (!t.includes("23P01") && !t.includes("exclusion constraint")) return null;
  if (t.includes("Appointment_dentist_no_overlap")) return "dentist";
  if (t.includes("Appointment_chair_no_overlap")) return "chair";
  return null;
}

/** SQLSTATE 23P01 on the WorkingHours exclusion constraints (overlapping sessions). */
export function workingHoursOverlap(e: unknown): boolean {
  return /WorkingHours_(branch|dentist|chair)_no_overlap/.test(text(e));
}

/** Stable codes raised by the 0006 triggers (message prefix), all answered as 409 except the last (400). */
export const CLINICAL_GUARD_CODES = [
  "encounter_signed",
  "encounter_not_signed",
  "tooth_record_immutable",
  "plan_item_history",
  "clinical_row_moved",
] as const;
export type ClinicalGuardCode = (typeof CLINICAL_GUARD_CODES)[number];

export function clinicalGuardError(e: unknown): ClinicalGuardCode | null {
  const t = text(e);
  if (!t.includes("P0001")) return null;
  return CLINICAL_GUARD_CODES.find((c) => t.includes(`${c}:`)) ?? null;
}

/**
 * Trigger tenant_member_guard: a dentist column was set to a user who is not a member of the tenant
 * (or was removed). Answer 400 { error: "not_a_member", field } — validate first for a clearer error.
 */
export function notAMember(e: unknown): string | null {
  const t = text(e);
  if (!t.includes("P0001")) return null;
  return /not_a_member: \w+\.(\w+)/.exec(t)?.[1] ?? null;
}

/** Unique violation (P2002) — e.g. chair code per branch, consent template code, plan version race. */
export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "P2002" || text(e).includes("23505");
}
