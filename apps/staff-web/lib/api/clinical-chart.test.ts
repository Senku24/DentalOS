import { describe, expect, test } from "bun:test";
import { createClient } from "./client";
import { createClinicalApi } from "./clinical";
import { chartAsOf, splitChart } from "./clinical-chart";
import { withClinicalErrors } from "./clinical-client";
import * as C from "./clinical-fixtures";
import { clinicalMockHandler } from "./clinical-mock";

const row = (id: string, recordedAt: string, supersededAt: string | null) => ({
  id,
  status: supersededAt ? ("HISTORICAL" as const) : ("CURRENT" as const),
  recordedAt,
  supersededAt,
});

describe("chart as of an instant", () => {
  const old = row("old", "2026-11-01T10:00:00.000Z", "2026-11-10T10:00:00.000Z");
  const replacement = row("new", "2026-11-10T10:00:00.000Z", null);
  const earlier = row("gone", "2026-10-01T10:00:00.000Z", "2026-10-05T10:00:00.000Z");

  test("without asOf the stored status decides", () => {
    const { current, past } = splitChart([old, replacement, earlier]);
    expect(current.map((r) => r.id)).toEqual(["new"]);
    expect(past.map((r) => r.id)).toEqual(["old", "gone"]);
  });

  test("a signed encounter shows what was current when it was signed, not later findings", () => {
    const { current, past } = splitChart([old, replacement, earlier], "2026-11-07T09:00:00.000Z");
    expect(current.map((r) => r.id)).toEqual(["old"]);
    expect(past.map((r) => r.id)).toEqual(["gone"]);
  });

  test("only signed encounters pin the chart, and the user can switch to today's chart", () => {
    const signed = { status: "SIGNED", signedAt: "2026-11-07T09:00:00.000Z" };
    expect(chartAsOf(signed, false)).toBe(signed.signedAt);
    expect(chartAsOf(signed, true)).toBeUndefined();
    expect(chartAsOf({ status: "OPEN", signedAt: null }, false)).toBeUndefined();
    expect(chartAsOf(undefined, false)).toBeUndefined();
  });

  test("mock honours asOf like the API (later charting is not shown)", async () => {
    const api = createClinicalApi(
      withClinicalErrors(
        createClient({ baseUrl: "", mock: true, mockHandler: clinicalMockHandler }),
      ),
    );
    const today = await api.odontogram.get(C.P41, { includeHistory: true });
    const recorded = today.records.map((r) => r.recordedAt).sort();
    const first = recorded[0];
    if (!first) throw new Error("fixture chart missing");
    const before = new Date(Date.parse(first) - 1000).toISOString();
    const then = await api.odontogram.get(C.P41, { asOf: before });
    expect(then.asOf).toBe(before);
    expect(then.records).toEqual([]);
    const atFirst = await api.odontogram.get(C.P41, { asOf: first, includeHistory: true });
    expect(atFirst.records.every((r) => r.recordedAt <= first)).toBe(true);
    expect(atFirst.records.length).toBeGreaterThan(0);
  });
});
