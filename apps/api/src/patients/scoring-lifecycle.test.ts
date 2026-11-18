import { expect, test } from "bun:test";
import {
  PATIENT_LIFECYCLE_STAGES,
  normalizeEmail,
  normalizeName,
  normalizePhoneIN,
} from "@dentalos/validation";
import {
  type IdentityProbe,
  LIKELY_THRESHOLD,
  MATCH_THRESHOLD,
  isLikely,
  isMatch,
  orderPair,
  scoreDuplicate,
  trigramSimilarity,
  trigrams,
} from "./duplicate-scoring";
import { LIFECYCLE_TRANSITIONS, canTransition } from "./lifecycle";

const probe = (
  name: string,
  o: { phone?: string; email?: string; dob?: string } = {},
): IdentityProbe => ({
  nameNormalized: normalizeName(name),
  phoneNormalized: normalizePhoneIN(o.phone),
  emailNormalized: normalizeEmail(o.email),
  dob: o.dob ?? null,
});

test("trigrams follow pg_trgm padding", () => {
  expect([...trigrams("cat")].sort()).toEqual(["  c", " ca", "at ", "cat"]);
  expect(trigrams("")).toEqual(new Set());
});

test("trigramSimilarity matches Postgres similarity() values", () => {
  // SELECT similarity('ananya rao','ananya rau') = 0.6923077 on PG16.
  expect(trigramSimilarity("ananya rao", "ananya rau")).toBeCloseTo(0.6923077, 5);
  expect(trigramSimilarity("abc", "abc")).toBe(1);
  expect(trigramSimilarity("abc", "")).toBe(0);
  expect(trigramSimilarity("ravi kumar", "zoe smith")).toBeLessThan(0.1);
});

test("same phone + same name + same dob scores 100 with all reasons", () => {
  const a = probe("Ananya Rao", { phone: "98765 43210", dob: "1990-01-02" });
  const b = probe("  ananya  RAO ", { phone: "+91 98765-43210", dob: "1990-01-02" });
  const s = scoreDuplicate(a, b);
  expect(s.score).toBe(100);
  expect(s.reasons).toEqual(["PHONE_EXACT", "NAME_EXACT", "DOB_EXACT"]);
});

test("phone + similar name is likely; reasons explain it", () => {
  const s = scoreDuplicate(
    probe("Ananya Rao", { phone: "9876543210" }),
    probe("Ananya Rau", { phone: "09876543210" }),
  );
  expect(s.reasons).toEqual(["PHONE_EXACT", "NAME_SIMILAR"]);
  expect(s.score).toBe(65);
  expect(isLikely(s)).toBe(true);
});

test("shared family phone with a different name and dob is not a match", () => {
  const s = scoreDuplicate(
    probe("Ravi Kumar", { phone: "9876543210", dob: "1960-05-05" }),
    probe("Meera Kumar", { phone: "9876543210", dob: "1992-03-03" }),
  );
  expect(s.reasons).toContain("PHONE_EXACT");
  expect(isMatch(s)).toBe(false);
});

test("phone alone is a possible (not likely) match", () => {
  const s = scoreDuplicate(
    probe("Ravi", { phone: "9876543210" }),
    probe("Zoe Smith", { phone: "9876543210" }),
  );
  expect(s.score).toBe(45);
  expect(isMatch(s)).toBe(true);
  expect(isLikely(s)).toBe(false);
});

test("exact name + dob (number changed) is likely; exact name alone is not a match", () => {
  const withDob = scoreDuplicate(
    probe("Ananya Rao", { dob: "1990-01-02", phone: "9000000001" }),
    probe("Ananya Rao", { dob: "1990-01-02", phone: "9000000002" }),
  );
  expect(withDob.score).toBe(60);
  expect(withDob.reasons).toEqual(["NAME_EXACT", "DOB_EXACT"]);
  expect(isLikely(withDob)).toBe(true);
  expect(isMatch(scoreDuplicate(probe("Ananya Rao"), probe("Ananya Rao")))).toBe(false);
});

test("email + exact name is likely; email is case-insensitive", () => {
  const s = scoreDuplicate(
    probe("Ananya Rao", { email: "Ananya@Example.com" }),
    probe("Ananya Rao", { email: "ananya@example.com" }),
  );
  expect(s.reasons).toEqual(["EMAIL_EXACT", "NAME_EXACT"]);
  expect(s.score).toBe(70);
});

test("DB-provided similarity overrides the local computation", () => {
  const a = probe("Ananya Rao", { dob: "1990-01-02" });
  const b = probe("Anu Rao", { dob: "1990-01-02" });
  expect(scoreDuplicate(a, b, 0.9).reasons).toEqual(["NAME_SIMILAR", "DOB_EXACT"]);
  expect(scoreDuplicate(a, b, 0.1).reasons).toEqual(["DOB_EXACT"]);
});

test("score is clamped and thresholds are ordered", () => {
  const s = scoreDuplicate(
    probe("A B", { phone: "9876543210", email: "x@y.in", dob: "2000-01-01" }),
    probe("A B", { phone: "9876543210", email: "x@y.in", dob: "2000-01-01" }),
  );
  expect(s.score).toBe(100);
  expect(
    scoreDuplicate(probe("X", { dob: "2000-01-01" }), probe("Q", { dob: "1999-01-01" })).score,
  ).toBe(0);
  expect(MATCH_THRESHOLD).toBeLessThan(LIKELY_THRESHOLD);
});

test("orderPair stores the smaller uuid first and rejects self pairs", () => {
  const a = "0f000000-0000-4000-8000-000000000000";
  const b = "A0000000-0000-4000-8000-000000000000";
  expect(orderPair(b, a)).toEqual([a, b.toLowerCase()]);
  expect(orderPair(a, b)).toEqual([a, b.toLowerCase()]);
  expect(() => orderPair(a, a.toUpperCase())).toThrow();
});

test("lifecycle: forward journey and cycles are allowed", () => {
  expect(canTransition("REGISTERED", "ACTIVE")).toBe(true);
  expect(canTransition("ACTIVE", "IN_TREATMENT")).toBe(true);
  expect(canTransition("IN_TREATMENT", "FOLLOW_UP")).toBe(true);
  expect(canTransition("FOLLOW_UP", "RECALL")).toBe(true);
  expect(canTransition("RECALL", "IN_TREATMENT")).toBe(true);
  expect(canTransition("INACTIVE", "ACTIVE")).toBe(true);
  expect(canTransition("ACTIVE", "ACTIVE")).toBe(true);
});

test("lifecycle: invalid moves are rejected", () => {
  expect(canTransition("ACTIVE", "REGISTERED")).toBe(false);
  expect(canTransition("REGISTERED", "RECALL")).toBe(false);
  expect(canTransition("REGISTERED", "FOLLOW_UP")).toBe(false);
  expect(canTransition("INACTIVE", "IN_TREATMENT")).toBe(false);
  expect(canTransition("IN_TREATMENT", "RECALL")).toBe(false);
});

test("lifecycle: every stage can be deactivated; nothing returns to REGISTERED", () => {
  for (const s of PATIENT_LIFECYCLE_STAGES) {
    if (s !== "INACTIVE") expect(canTransition(s, "INACTIVE")).toBe(true);
    for (const to of LIFECYCLE_TRANSITIONS[s]) expect(to).not.toBe("REGISTERED");
  }
});
