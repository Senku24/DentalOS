import { describe, expect, mock, test } from "bun:test";
import { createClient } from "./client";
import { ApiError, errorStateFor, kindForStatus, mapHttpError } from "./errors";
import { fid } from "./fixtures";
import { mockHandler } from "./mock";
import { API_PREFIX, buildUrl, routes } from "./routes";

describe("routes", () => {
  test("match the final API (no global prefix)", () => {
    expect(API_PREFIX).toBe("");
    expect(routes.org()).toBe("/org");
    expect(routes.branchDeactivate("b1")).toBe("/branches/b1/deactivate");
    expect(routes.invitationResend("i1")).toBe("/invitations/i1/resend");
    expect(routes.dentistTransfer()).toBe("/dentist-assignments/transfer");
    expect(routes.priceOverrides("s1")).toBe("/catalog/services/s1/overrides");
    expect(routes.priceOverrideClear("s1")).toBe("/catalog/services/s1/overrides/clear");
    expect(routes.branchPriceList()).toBe("/catalog/price-list");
    expect(routes.allergyResolve("p1", "a1")).toBe("/patients/p1/allergies/a1/resolve");
    expect(routes.patientLifecycle("p1")).toBe("/patients/p1/lifecycle");
    expect(routes.patientIdentity("p1")).toBe("/patients/p1/identity-verification");
    expect(routes.duplicates()).toBe("/duplicate-candidates");
    expect(routes.duplicateDismiss("d1")).toBe("/duplicate-candidates/d1/dismiss");
    expect(routes.patientMerge()).toBe("/patient-merges");
    expect(routes.mergePreview()).toBe("/patient-merges/preview");
    expect(routes.documents()).toBe("/documents");
    expect(routes.documentUploads()).toBe("/documents/uploads");
    expect(routes.documentDelete("d1")).toBe("/documents/d1/delete");
  });

  test("encode path segments", () => {
    expect(routes.patient("a/b c")).toBe("/patients/a%2Fb%20c");
  });

  test("buildUrl drops empty values, keeps booleans and trims base slashes", () => {
    expect(
      buildUrl("http://api.test/", "/patients", {
        q: "nair",
        cursor: undefined,
        lifecycleStage: "",
        includeMerged: false,
        limit: 25,
        x: null,
      }),
    ).toBe("http://api.test/patients?q=nair&includeMerged=false&limit=25");
    expect(buildUrl("", "/org")).toBe("/org");
    expect(buildUrl("", "/patients", { q: "a&b" })).toBe("/patients?q=a%26b");
  });
});

describe("error mapping", () => {
  test("status → kind", () => {
    expect(kindForStatus(0)).toBe("network");
    expect(kindForStatus(400)).toBe("validation");
    expect(kindForStatus(401)).toBe("unauthorized");
    expect(kindForStatus(403)).toBe("forbidden");
    expect(kindForStatus(404)).toBe("not_found");
    expect(kindForStatus(409)).toBe("conflict");
    expect(kindForStatus(410)).toBe("gone");
    expect(kindForStatus(429)).toBe("rate_limited");
    expect(kindForStatus(503)).toBe("server");
    expect(kindForStatus(418)).toBe("unknown");
  });

  test("validation issues become field errors (first message per path wins)", () => {
    const e = mapHttpError(400, {
      error: "validation_failed",
      issues: [
        { path: "branchScope", message: "Branch scope required unless orgWide" },
        { path: "branchScope", message: "second" },
        { path: "email", message: "Invalid email" },
      ],
    });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("validation");
    expect(e.code).toBe("validation_failed");
    expect(e.fieldErrors).toEqual({
      branchScope: "Branch scope required unless orgWide",
      email: "Invalid email",
    });
  });

  test("known codes get friendly copy; unknown fall back to the kind", () => {
    expect(mapHttpError(409, { error: "last_owner" }).message).toMatch(
      /at least one organisation-wide owner/,
    );
    expect(mapHttpError(409, { error: "weird_code" }).message).toMatch(/conflicts/);
    expect(mapHttpError(500, "<html>").kind).toBe("server");
  });

  test("API error contracts: possible_duplicates, patient_merged, reauth_required", () => {
    const dup = mapHttpError(409, { error: "possible_duplicates", matches: [{ score: 90 }] });
    expect(dup.isPossibleDuplicates).toBe(true);
    expect(dup.body.matches).toEqual([{ score: 90 }]);

    const merged = mapHttpError(409, {
      error: "patient_merged",
      mergedIntoId: "x",
      survivorId: "s1",
    });
    expect(merged.mergedSurvivorId).toBe("s1");
    expect(mapHttpError(409, { error: "conflict" }).mergedSurvivorId).toBeUndefined();

    const reauth = mapHttpError(401, { error: "reauth_required" });
    expect(reauth.needsReauth).toBe(true);
    expect(mapHttpError(401, {}).needsReauth).toBe(false);
  });

  test("errorStateFor gives a title/description pair", () => {
    expect(errorStateFor(mapHttpError(403, {}))).toEqual({
      title: "Access denied",
      description: "You don't have permission to do that.",
    });
    expect(errorStateFor(new Error("boom")).description).toBe("boom");
  });
});

describe("client", () => {
  const ok = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  test("sends JSON with the dev bearer token and parses the response", async () => {
    const f = mock(async (_url: string | URL | Request, _init?: RequestInit) => ok({ id: "1" }));
    const c = createClient({
      baseUrl: "http://api.test",
      token: "dev-token",
      mock: false,
      fetch: f as unknown as typeof fetch,
    });
    const r = await c.request<{ id: string }>("POST", "/branches", {
      body: { code: "X" },
      query: { a: 1 },
    });
    expect(r).toEqual({ id: "1" });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/branches?a=1");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"code":"X"}');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer dev-token");
    expect(h["Content-Type"]).toBe("application/json");
  });

  test("omits auth and content-type when not needed; handles 204", async () => {
    const f = mock(async () => new Response(null, { status: 204 }));
    const c = createClient({ baseUrl: "", mock: false, fetch: f as unknown as typeof fetch });
    expect(await c.request("DELETE", "/catalog/categories/1")).toBeUndefined();
    const h = (f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(h.Authorization).toBeUndefined();
    expect(h["Content-Type"]).toBeUndefined();
  });

  test("maps HTTP failures to ApiError", async () => {
    const f = mock(async () => ok({ error: "patient_merged", survivorId: "s9" }, 409));
    const c = createClient({ baseUrl: "", mock: false, fetch: f as unknown as typeof fetch });
    const e = await c.request("PATCH", "/patients/1", { body: {} }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).mergedSurvivorId).toBe("s9");
  });

  test("maps fetch rejections to a network error", async () => {
    const f = mock(async () => {
      throw new TypeError("Failed to fetch");
    });
    const c = createClient({ baseUrl: "", mock: false, fetch: f as unknown as typeof fetch });
    const e = (await c.request("GET", "/org").catch((x) => x)) as ApiError;
    expect(e.kind).toBe("network");
    expect(e.status).toBe(0);
  });

  test("mock mode routes to the handler with stringified query and never fetches", async () => {
    const handler = mock(async () => ({ items: [] }));
    const f = mock(async () => ok({}));
    const c = createClient({
      baseUrl: "",
      mock: true,
      mockHandler: handler,
      fetch: f as unknown as typeof fetch,
    });
    await c.request("GET", "/branches", { query: { active: true, x: undefined } });
    expect(handler.mock.calls[0]).toEqual([
      "GET",
      "/branches",
      { active: "true" },
      undefined,
    ] as never);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("mock API (fixtures)", () => {
  test("patient search filters by name and paginates with a cursor", async () => {
    const r = (await mockHandler("GET", "/patients", { q: "rahul sharma" }, undefined)) as {
      items: { firstName: string }[];
    };
    expect(r.items.length).toBe(2);
    const page1 = (await mockHandler("GET", "/patients", { limit: "10" }, undefined)) as {
      items: unknown[];
      nextCursor: string | null;
    };
    expect(page1.items).toHaveLength(10);
    expect(page1.nextCursor).toBe("10");
  });

  test("create patient: 409 possible_duplicates with matches, URGENT never blocked", async () => {
    const body = {
      firstName: "Rahul",
      lastName: "Sharma",
      phone: "9000077001",
      originBranchId: fid("0b", 1),
      intakeType: "WALK_IN",
    };
    const e = (await mockHandler("POST", "/patients", {}, body).catch((x) => x)) as ApiError;
    expect(e.isPossibleDuplicates).toBe(true);
    expect((e.body.matches as unknown[]).length).toBeGreaterThan(0);

    const urgent = (await mockHandler(
      "POST",
      "/patients",
      {},
      { ...body, intakeType: "URGENT" },
    )) as {
      id: string;
      possibleDuplicates: unknown[];
    };
    expect(urgent.id).toBeTruthy();
    expect(urgent.possibleDuplicates.length).toBeGreaterThan(0);
  });

  test("writes to a merged patient return 409 patient_merged with the survivor", async () => {
    const e = (await mockHandler(
      "POST",
      `/patients/${fid("01", 45)}/allergies`,
      {},
      { substance: "Latex" },
    ).catch((x) => x)) as ApiError;
    expect(e.code).toBe("patient_merged");
    expect(e.mergedSurvivorId).toBe(fid("01", 46));
  });

  test("request bodies are validated with the shared schemas", async () => {
    const e = (await mockHandler("POST", "/branches", {}, { code: "x", name: "" }).catch(
      (x) => x,
    )) as ApiError;
    expect(e.kind).toBe("validation");
    expect(Object.keys(e.fieldErrors)).toEqual(expect.arrayContaining(["code", "name"]));
  });

  test("unknown routes are 404", async () => {
    const e = (await mockHandler("GET", "/nope", {}, undefined).catch((x) => x)) as ApiError;
    expect(e.kind).toBe("not_found");
  });
});
