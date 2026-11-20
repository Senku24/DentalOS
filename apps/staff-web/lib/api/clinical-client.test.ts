import { describe, expect, test } from "bun:test";
import { collectPages } from "./clinical-client";

describe("collectPages", () => {
  const pages: Record<string, { items: number[]; nextCursor: string | null }> = {
    start: { items: [1, 2], nextCursor: "b" },
    b: { items: [3], nextCursor: "c" },
    c: { items: [4], nextCursor: null },
  };

  test("follows nextCursor so older items (past the first page) can be picked", async () => {
    const seen: (string | undefined)[] = [];
    const all = await collectPages(async (cursor) => {
      seen.push(cursor);
      return pages[cursor ?? "start"] ?? { items: [], nextCursor: null };
    });
    expect(all).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([undefined, "b", "c"]);
  });

  test("stops at maxPages", async () => {
    const all = await collectPages(async () => ({ items: [0], nextCursor: "again" }), 3);
    expect(all).toEqual([0, 0, 0]);
  });
});
