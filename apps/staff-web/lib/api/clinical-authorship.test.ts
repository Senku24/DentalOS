import { describe, expect, test } from "bun:test";
import { canDeleteAuthored, canEditAuthored } from "./clinical-authorship";

describe("authorship mirrors the API (403 not_author)", () => {
  const enc = { treatingDentistUserId: "dent-1" };

  test("only the author edits or changes a procedure's status", () => {
    expect(canEditAuthored("dent-2", "dent-2")).toBe(true);
    expect(canEditAuthored("dent-2", "dent-1")).toBe(false);
    expect(canEditAuthored("dent-2", undefined)).toBe(false);
    expect(canEditAuthored(undefined, undefined)).toBe(false);
  });

  test("the author or the treating dentist deletes; another clinician does not", () => {
    expect(canDeleteAuthored("dent-2", enc, "dent-2")).toBe(true);
    expect(canDeleteAuthored("dent-2", enc, "dent-1")).toBe(true);
    expect(canDeleteAuthored("dent-2", enc, "hyg-3")).toBe(false);
    expect(canDeleteAuthored("dent-2", enc, undefined)).toBe(false);
  });
});
