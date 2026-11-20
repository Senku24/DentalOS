import { describe, expect, test } from "bun:test";
import { createClient } from "./client";
import { createClinicalApi } from "./clinical";
import { withClinicalErrors } from "./clinical-client";
import * as C from "./clinical-fixtures";
import { clinicalMockHandler } from "./clinical-mock";
import type { ApiError } from "./errors";
import { createPlansApi } from "./plans";
import { planItemPatch, reorderToPhase } from "./plans-rules";

/** Mock mode follows the Wave 1 rules the screens rely on (same error codes as the API). */
const client = withClinicalErrors(
  createClient({ baseUrl: "", mock: true, mockHandler: clinicalMockHandler }),
);
const clinical = createClinicalApi(client);
const plans = createPlansApi(client);
const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: ApiError) => e,
  );

describe("clinical mock", () => {
  test("context: identity, open encounter treated by the dev user, active plans and chart", async () => {
    const ctx = await clinical.context(C.P41);
    expect(ctx.patient.id).toBe(C.P41);
    expect(ctx.openEncounters.map((e) => e.id)).toContain(C.E3);
    expect(ctx.activePlans.length).toBeGreaterThan(0);
    expect(ctx.odontogram.every((t) => t.status === "CURRENT")).toBe(true);
  });

  test("only the treating dentist signs; signed notes can't be edited, only amended", async () => {
    const other = await fail(clinical.encounters.sign(C.E4));
    expect(other?.code).toBe("not_treating_dentist");

    const signed = await clinical.encounters.get(C.E1);
    expect(signed.status).toBe("SIGNED");
    const note = signed.notes[0];
    if (!note) throw new Error("fixture note missing");
    const edit = await fail(clinical.encounters.updateNote(C.E1, note.id, { body: "changed" }));
    expect(edit?.code).toBe("encounter_signed");
    expect(edit?.message).toMatch(/amendment/);

    const amend = await clinical.encounters.addAmendment(C.E1, {
      noteId: note.id,
      body: "Correction",
      reason: "Wrong tooth noted",
    });
    expect(amend.noteId).toBe(note.id);
  });

  test("approving without consent answers 409 consent_required", async () => {
    const plan = await plans.get(C.PL1);
    expect(["ACCEPTED", "PARTIALLY_ACCEPTED"]).toContain(plan.status);
    const err = await fail(plans.approve(C.PL1, {}));
    expect(err?.code).toBe("consent_required");
    expect(err?.message).toMatch(/consent/);
  });

  test("plan writes return the plan with server-frozen estimates and phase totals", async () => {
    const draft = await plans.get(C.PL2);
    const before = draft.items.length;
    const priced = draft.items[0];
    if (!priced) throw new Error("fixture item missing");
    const next = await plans.addItem(C.PL2, {
      serviceId: priced.serviceId,
      phase: 2,
      surfaces: [],
      quantity: 2,
    });
    expect(next.items.length).toBe(before + 1);
    const added = next.items.find((i) => !draft.items.some((d) => d.id === i.id));
    expect(added?.estimatePricePaise).toBeGreaterThan(0);
    expect(next.totals.estimatePaise).toBe(
      next.items
        .filter((i) => i.status !== "REJECTED" && i.status !== "CANCELLED")
        .reduce((s, i) => s + i.estimatePricePaise * i.quantity, 0),
    );
  });

  test("editing a presented plan item: unchanged form makes no version; phase moves renumber", async () => {
    const before = await plans.get(C.PL1);
    const deferred = before.items.find((i) => i.status === "DEFERRED");
    if (!deferred) throw new Error("fixture deferred item missing");
    // The API (and mock) apply every key they receive: this is why the UI diffs first.
    expect(planItemPatch(deferred, { ...deferred, reason: "nothing" })).toBeNull();

    const target = Math.max(...before.items.map((i) => i.phase));
    const moved = await plans.reorder(C.PL1, {
      items: reorderToPhase(before.items, deferred.id, target),
    });
    const inTarget = moved.items.filter((i) => i.phase === target).map((i) => i.sequence);
    expect(new Set(inTarget).size).toBe(inTarget.length);
    expect(inTarget.sort()).toEqual(inTarget.map((_, k) => k + 1));
    expect(moved.items.find((i) => i.id === deferred.id)?.sequence).toBe(inTarget.length);

    const patch = planItemPatch(deferred, { ...deferred, quantity: deferred.quantity + 1 });
    expect(patch).toEqual({ quantity: deferred.quantity + 1 });
  });
});
