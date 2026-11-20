import { describe, expect, test } from "bun:test";
import type { PlanItemStatus } from "@dentalos/validation";
import { formatPaise } from "../format";
import type { PlanItemDetail } from "./clinical-types";
import { groupByPhase, lineTotalPaise, nextPhase, totalsOf } from "./plans-money";
import {
  clinicianTargets,
  decisionTargets,
  isDecisionTransition,
  planItemPatch,
  reorderToPhase,
} from "./plans-rules";

let n = 0;
const item = (
  phase: number,
  sequence: number,
  status: PlanItemStatus,
  estimatePricePaise: number,
  quantity = 1,
): PlanItemDetail => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  planId: "00000000-0000-4000-8000-000000000999",
  phase,
  sequence,
  serviceId: "00000000-0000-4000-8000-000000000500",
  toothCode: null,
  surfaces: [],
  quantity,
  estimatePricePaise,
  priceSource: "BASE",
  pricedAt: "2026-11-01T00:00:00.000Z",
  status,
  notes: null,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
});

describe("plan money", () => {
  const items = [
    item(2, 1, "PROPOSED", 450_000),
    item(1, 2, "ACCEPTED", 120_050, 2), // ₹1,200.50 × 2
    item(1, 1, "COMPLETED", 80_000),
    item(1, 3, "REJECTED", 999_900),
    item(2, 2, "DEFERRED", 150_000),
    item(2, 3, "CANCELLED", 70_000),
  ];

  test("line total = frozen unit estimate × quantity (server value wins)", () => {
    expect(lineTotalPaise({ status: "ACCEPTED", estimatePricePaise: 120_050, quantity: 2 })).toBe(
      240_100,
    );
    expect(
      lineTotalPaise({ status: "ACCEPTED", estimatePricePaise: 1, quantity: 2, lineTotalPaise: 7 }),
    ).toBe(7);
  });

  test("phases are grouped ascending, items by sequence, with per-phase totals", () => {
    const groups = groupByPhase({ items });
    expect(groups.map((g) => g.phase)).toEqual([1, 2]);
    expect(groups[0]?.items.map((i) => i.sequence)).toEqual([1, 2, 3]);
    expect(groups[0]?.totals).toEqual({
      estimatePaise: 320_100, // rejected excluded
      acceptedPaise: 320_100,
      completedPaise: 80_000,
      pendingPaise: 0,
    });
    expect(groups[1]?.totals).toEqual({
      estimatePaise: 600_000, // cancelled excluded
      acceptedPaise: 0,
      completedPaise: 0,
      pendingPaise: 600_000,
    });
  });

  test("plan totals equal the sum of phase totals and render as rupees", () => {
    const t = totalsOf({ items });
    expect(t.estimatePaise).toBe(920_100);
    expect(formatPaise(t.estimatePaise)).toBe("₹9,201");
    expect(formatPaise(groupByPhase({ items })[0]?.totals.estimatePaise)).toBe("₹3,201");
    expect(formatPaise(240_100)).toBe("₹2,401");
    expect(formatPaise(120_050)).toBe("₹1,200.50");
    expect(formatPaise(15_000_000)).toBe("₹1,50,000");
  });

  test("server totals win over the local fallback", () => {
    const server = { estimatePaise: 1, acceptedPaise: 2, completedPaise: 3, pendingPaise: 4 };
    expect(totalsOf({ items, totals: server })).toBe(server);
    const g = groupByPhase({ items, phaseTotals: [{ phase: 2, ...server }] });
    expect(g[1]?.totals).toEqual(server);
    expect(g[0]?.totals.estimatePaise).toBe(320_100);
  });

  test("next phase is one past the highest (capped at 20)", () => {
    expect(nextPhase([])).toBe(1);
    expect(nextPhase(items)).toBe(3);
    expect(nextPhase([{ phase: 20 }])).toBe(20);
  });
});

describe("plan rules offered by the UI", () => {
  test("patient decisions come from proposed/deferred items, never from scheduled", () => {
    expect(decisionTargets("PROPOSED")).toEqual(["ACCEPTED", "REJECTED", "DEFERRED"]);
    expect(decisionTargets("DEFERRED")).toEqual(["ACCEPTED", "REJECTED"]);
    expect(decisionTargets("ACCEPTED")).toEqual(["DEFERRED"]);
    expect(isDecisionTransition("SCHEDULED", "ACCEPTED")).toBe(false);
    expect(decisionTargets("COMPLETED")).toEqual([]);
  });

  test("clinician moves exclude patient decisions except SCHEDULED → ACCEPTED", () => {
    expect(clinicianTargets("SCHEDULED")).toEqual(["IN_PROGRESS", "ACCEPTED", "CANCELLED"]);
    expect(clinicianTargets("PROPOSED")).toEqual(["CANCELLED"]);
    expect(clinicianTargets("IN_PROGRESS")).toEqual(["COMPLETED", "CANCELLED"]);
  });
});

describe("plan item edit body", () => {
  const base = {
    ...item(1, 1, "PROPOSED", 100_000, 2),
    toothCode: 26,
    surfaces: ["O"],
    notes: "x",
  };
  const same = { toothCode: 26, surfaces: ["O"], quantity: 2, notes: "x" };

  test("an unchanged form sends nothing (no junk plan version, consent stays current)", () => {
    expect(planItemPatch(base, same)).toBeNull();
    expect(planItemPatch(base, { ...same, reason: "typed but nothing changed" })).toBeNull();
    expect(planItemPatch({ ...base, notes: null }, { ...same, notes: null })).toBeNull();
    expect(planItemPatch({ ...base, notes: null }, { ...same, notes: "" })).toBeNull();
  });

  test("only changed keys travel; tooth and surfaces always together", () => {
    expect(planItemPatch(base, { ...same, quantity: 3 })).toEqual({ quantity: 3 });
    expect(planItemPatch(base, { ...same, notes: null })).toEqual({ notes: null });
    expect(planItemPatch(base, { ...same, toothCode: 27 })).toEqual({
      toothCode: 27,
      surfaces: ["O"],
    });
    expect(planItemPatch(base, { ...same, surfaces: ["O", "M"] })).toEqual({
      toothCode: 26,
      surfaces: ["O", "M"],
    });
    expect(planItemPatch(base, { ...same, reprice: true, reason: "Price list" })).toEqual({
      reprice: true,
      reason: "Price list",
    });
  });

  test("a phase move goes through reorder: the item lands last in the target phase", () => {
    const a = item(1, 1, "PROPOSED", 1);
    const b = item(1, 2, "PROPOSED", 1);
    const c = item(2, 1, "PROPOSED", 1);
    const d = item(2, 2, "PROPOSED", 1);
    expect(reorderToPhase([d, c, b, a], a.id, 2)).toEqual([
      { itemId: b.id, phase: 1 },
      { itemId: c.id, phase: 2 },
      { itemId: d.id, phase: 2 },
      { itemId: a.id, phase: 2 },
    ]);
    expect(reorderToPhase([a, b, c, d], d.id, 3).at(-1)).toEqual({ itemId: d.id, phase: 3 });
  });
});
