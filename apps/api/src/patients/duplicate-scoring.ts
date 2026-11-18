import type { DUPLICATE_REASONS } from "@dentalos/validation";

/**
 * Pure duplicate-patient scoring (PRD 4.2, 12.2). No I/O: the DB layer narrows candidates with
 * pg_trgm and passes Postgres' `similarity()` in; tests and callers without a DB use the local
 * `trigramSimilarity`, which mirrors pg_trgm's algorithm.
 *
 * Inputs must already be normalised with @dentalos/validation `normalizeName` / `normalizePhoneIN` /
 * `normalizeEmail` (the same functions that fill Patient.*Normalized).
 *
 * Rules (points, summed then clamped to 0–100):
 *   PHONE_EXACT   +45  same E.164 phone
 *   EMAIL_EXACT   +35  same lower-cased email
 *   NAME_EXACT    +35  identical normalised full name
 *   NAME_SIMILAR  +20  trigram similarity >= 0.6 (+12 when >= 0.45); not added when NAME_EXACT
 *   DOB_EXACT     +25  same date of birth
 *   DOB mismatch  −25  both DOBs known and different (families often share one phone number)
 * Thresholds: >= 40 is returned by the duplicate check ("possible"); >= 60 is "likely": it is
 * persisted to the review queue and triggers the create-time warning. Merging is never automatic.
 */

export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

export interface IdentityProbe {
  nameNormalized: string;
  phoneNormalized: string | null;
  emailNormalized: string | null;
  /** "YYYY-MM-DD" or null. */
  dob: string | null;
}

export interface DuplicateScore {
  score: number;
  reasons: DuplicateReason[];
}

export const DUPLICATE_WEIGHTS = {
  PHONE_EXACT: 45,
  EMAIL_EXACT: 35,
  NAME_EXACT: 35,
  NAME_SIMILAR_STRONG: 20,
  NAME_SIMILAR: 12,
  DOB_EXACT: 25,
  DOB_MISMATCH: -25,
} as const;

export const NAME_SIMILAR_MIN = 0.45;
export const NAME_SIMILAR_STRONG_MIN = 0.6;
/** Returned by the duplicate check. */
export const MATCH_THRESHOLD = 40;
/** Persisted as a DuplicateCandidate and warned about on create. */
export const LIKELY_THRESHOLD = 60;

/** pg_trgm trigram set: each alphanumeric word lower-cased, padded "  word ", all 3-grams. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** Same formula as pg_trgm `similarity()`: shared trigrams / union of trigrams (0–1). */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export function scoreDuplicate(
  probe: IdentityProbe,
  candidate: IdentityProbe,
  /** Postgres `similarity()` when available; computed locally otherwise. */
  nameSimilarity?: number,
): DuplicateScore {
  const reasons: DuplicateReason[] = [];
  let score = 0;
  if (probe.phoneNormalized && probe.phoneNormalized === candidate.phoneNormalized) {
    reasons.push("PHONE_EXACT");
    score += DUPLICATE_WEIGHTS.PHONE_EXACT;
  }
  if (probe.emailNormalized && probe.emailNormalized === candidate.emailNormalized) {
    reasons.push("EMAIL_EXACT");
    score += DUPLICATE_WEIGHTS.EMAIL_EXACT;
  }
  if (probe.nameNormalized && probe.nameNormalized === candidate.nameNormalized) {
    reasons.push("NAME_EXACT");
    score += DUPLICATE_WEIGHTS.NAME_EXACT;
  } else {
    const sim = nameSimilarity ?? trigramSimilarity(probe.nameNormalized, candidate.nameNormalized);
    if (sim >= NAME_SIMILAR_STRONG_MIN) {
      reasons.push("NAME_SIMILAR");
      score += DUPLICATE_WEIGHTS.NAME_SIMILAR_STRONG;
    } else if (sim >= NAME_SIMILAR_MIN) {
      reasons.push("NAME_SIMILAR");
      score += DUPLICATE_WEIGHTS.NAME_SIMILAR;
    }
  }
  if (probe.dob && candidate.dob) {
    if (probe.dob === candidate.dob) {
      reasons.push("DOB_EXACT");
      score += DUPLICATE_WEIGHTS.DOB_EXACT;
    } else {
      score += DUPLICATE_WEIGHTS.DOB_MISMATCH;
    }
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export const isMatch = (s: DuplicateScore) => s.score >= MATCH_THRESHOLD;
export const isLikely = (s: DuplicateScore) => s.score >= LIKELY_THRESHOLD;

/**
 * DuplicateCandidate stores each pair once with patientAId < patientBId (DB CHECK). Postgres orders
 * uuids bytewise, which equals lexicographic order of their lower-case text form.
 */
export function orderPair(a: string, b: string): [string, string] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) throw new Error("A patient cannot be paired with itself");
  return x < y ? [x, y] : [y, x];
}
