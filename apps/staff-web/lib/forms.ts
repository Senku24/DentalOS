import type { z } from "@dentalos/validation";

/**
 * Form ↔ zod wiring shared by every staff form. Forms hold raw input (strings, booleans, arrays);
 * `validate` cleans empty strings to undefined and runs the SAME schema the API uses, returning
 * either the parsed request body or a field → message map for <TextField error>.
 */

export type FieldErrors = Record<string, string>;

/** "" and whitespace-only strings become undefined so optional schema fields stay absent. */
export function cleanEmpty<T>(value: T): T {
  if (typeof value === "string") return (value.trim() === "" ? undefined : value) as T;
  if (Array.isArray(value)) return value.map(cleanEmpty) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = cleanEmpty(v);
      if (c !== undefined) out[k] = c;
    }
    return out as T;
  }
  return value;
}

/** Plain-language messages for zod's generic ones. */
export function friendlyMessage(issue: z.core.$ZodIssue): string {
  const m = issue.message;
  if (issue.code === "invalid_type" && /received undefined/.test(m)) return "Required";
  if (issue.code === "too_small" && issue.origin === "string" && Number(issue.minimum) <= 1)
    return "Required";
  if (issue.code === "too_small" && issue.origin === "string")
    return `Must be at least ${issue.minimum} characters`;
  if (issue.code === "too_big" && issue.origin === "string")
    return `Must be at most ${issue.maximum} characters`;
  if (issue.code === "too_small" && issue.origin === "array")
    return Number(issue.minimum) <= 1 ? "Select at least one" : `Select at least ${issue.minimum}`;
  if (issue.code === "invalid_format" && issue.format === "email") return "Enter a valid email";
  if (issue.code === "invalid_format" && issue.format === "uuid") return "Select an option";
  if (issue.code === "invalid_format" && issue.format === "date") return "Enter a valid date";
  if (issue.code === "invalid_value") return "Select an option";
  return m;
}

/** First message per dotted path ("branchScope", "workingHours.mon.0"). Root issues go under "_form". */
export function fieldErrorsFrom(issues: readonly z.core.$ZodIssue[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = i.path.length ? i.path.map(String).join(".") : "_form";
    if (!(key in out)) out[key] = friendlyMessage(i);
  }
  return out;
}

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

export function validate<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): ValidationResult<z.output<S>> {
  const r = schema.safeParse(cleanEmpty(raw));
  return r.success
    ? { ok: true, data: r.data }
    : { ok: false, errors: fieldErrorsFrom(r.error.issues) };
}

/** Rupee input ("1,250.50", "₹ 999") → integer paise without float drift. null when not a number. */
export function rupeesToPaise(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, "");
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const rupees = Number(m[1]);
  const paise = Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(rupees)) return null;
  return rupees * 100 + paise;
}

export function paiseToRupeeInput(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return p === 0 ? String(r) : `${r}.${String(p).padStart(2, "0")}`;
}

/**
 * PATCH bodies carry only what changed: the API applies exactly the keys it receives (no defaults).
 * Compares parsed form output with the current record; null and undefined count as equal, and
 * objects/arrays compare by JSON value.
 */
export function changedFields<T extends Record<string, unknown>>(
  next: T,
  current: Record<string, unknown>,
): Partial<T> {
  const out: Partial<T> = {};
  const same = (a: unknown, b: unknown) =>
    (a ?? null) === (b ?? null) ||
    (typeof a === "object" && a !== null && JSON.stringify(a) === JSON.stringify(b));
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    if (!same(v, current[k])) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
