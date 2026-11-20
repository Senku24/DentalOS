import { describe, expect, test } from "bun:test";
import { createClient } from "./client";
import { withClinicalErrors } from "./clinical-client";
import { clinicalErrorMessage, withClinicalMessage } from "./clinical-errors";
import { ApiError, mapHttpError } from "./errors";

const conflict = (body: Record<string, unknown>) => mapHttpError(409, body);

describe("clinical error mapping", () => {
  test("approval errors the plan screen must explain", () => {
    expect(withClinicalMessage(conflict({ error: "consent_required", version: 3 })).message).toBe(
      "The patient must sign the treatment-plan consent for the current version (v3) before the plan can be approved.",
    );
    expect(withClinicalMessage(conflict({ error: "item_still_scheduled" })).message).toMatch(
      /booked appointment/,
    );
    expect(withClinicalMessage(conflict({ error: "item_has_scheduled_sessions" })).message).toMatch(
      /scheduled sessions/,
    );
  });

  test("signed encounters point to amendments, never to editing", () => {
    const e = withClinicalMessage(conflict({ error: "encounter_signed" }));
    expect(e.kind).toBe("conflict");
    expect(e.code).toBe("encounter_signed");
    expect(e.message).toMatch(/Add an amendment/);
  });

  test("invalid_plan_item explains the reason and lands on the planItemId field", () => {
    const e = withClinicalMessage(
      mapHttpError(400, { error: "invalid_plan_item", field: "planItemId", reason: "plan_closed" }),
    );
    expect(e.kind).toBe("validation");
    expect(e.fieldErrors.planItemId).toMatch(/completed or cancelled/);
    expect(
      clinicalErrorMessage("invalid_plan_item", { reason: "item_not_startable" }) ?? "",
    ).toMatch(/accepted, scheduled or in-progress/);
    expect(clinicalErrorMessage("invalid_plan_item", { reason: "?" })).toMatch(/can't be linked/);
  });

  test("dentist_not_in_branch maps onto the dentist field", () => {
    const e = withClinicalMessage(
      mapHttpError(400, { error: "dentist_not_in_branch", field: "treatingDentistUserId" }),
    );
    expect(e.fieldErrors.treatingDentistUserId).toBe(
      "That dentist can't sign clinical records at this branch.",
    );
  });

  test("server field issues win over the code's field mapping", () => {
    const e = withClinicalMessage(
      mapHttpError(400, {
        error: "dentist_not_in_branch",
        field: "treatingDentistUserId",
        issues: [{ path: "treatingDentistUserId", message: "From server" }],
      }),
    );
    expect(e.fieldErrors.treatingDentistUserId).toBe("From server");
  });

  test("invalid_transition names both states", () => {
    expect(
      clinicalErrorMessage("invalid_transition", { from: "IN_PROGRESS", to: "PROPOSED" }),
    ).toBe("Can't move from in progress to proposed.");
    expect(clinicalErrorMessage("invalid_transition")).toBe("That status change isn't allowed.");
  });

  test("unknown codes and non-API errors keep the generic copy", () => {
    const e = conflict({ error: "something_new" });
    expect(withClinicalMessage(e)).toBe(e);
    expect(withClinicalMessage(new Error("boom")).message).toBe("boom");
    expect(clinicalErrorMessage(undefined)).toBeUndefined();
  });

  test("the clinical client re-labels transport errors and lets aborts through", async () => {
    const failing = createClient({
      baseUrl: "",
      mock: true,
      mockHandler: async () => {
        throw mapHttpError(409, { error: "not_treating_dentist" });
      },
    });
    const c = withClinicalErrors(failing);
    const err = await c.request("POST", "/encounters/x/sign").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(
      "Only the treating dentist can do this for the encounter.",
    );

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const aborting = withClinicalErrors(
      createClient({
        baseUrl: "",
        mock: true,
        mockHandler: async () => {
          throw abort;
        },
      }),
    );
    expect(await aborting.request("GET", "/x").catch((e: unknown) => e)).toBe(abort);
  });
});
