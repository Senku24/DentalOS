import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clinicalRoutes, planRoutes } from "./clinical-routes";

/**
 * Every clinical/plan route builder must hit a real controller route. The routes are read straight
 * from the Nest decorators in apps/api/src/{clinical,plans}/*.controller.ts, so a renamed or
 * removed endpoint fails here instead of in the browser.
 */
const API_SRC = join(import.meta.dir, "../../../api/src");
const CONTROLLERS = [
  "clinical/encounters.controller.ts",
  "clinical/patient-clinical.controller.ts",
  "plans/plans.controller.ts",
  "plans/consent.controller.ts",
];

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** "METHOD /path/:param" for every handler (params normalised to ":p"). */
function controllerRoutes(): Set<string> {
  const out = new Set<string>();
  for (const file of CONTROLLERS) {
    const src = readFileSync(join(API_SRC, file), "utf8");
    let base = "";
    const re =
      /@Controller\(\s*"([^"]*)"\s*\)|@(Get|Post|Patch|Put|Delete)\(\s*(?:"([^"]*)")?\s*\)/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (m[1] !== undefined) {
        base = m[1];
        continue;
      }
      const method = (m[2] ?? "").toUpperCase() as Method;
      const path = ["", base, m[3] ?? ""].filter((s, i) => i === 0 || s).join("/");
      out.add(`${method} ${normalise(path)}`);
    }
  }
  return out;
}

const normalise = (path: string) =>
  path
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .split("/")
    .map((seg) => (seg.startsWith(":") || seg.startsWith("__") ? ":p" : seg))
    .join("/");

/** Built path with placeholder ids → pattern comparable with the controller routes. */
const pattern = (built: string) =>
  normalise(built.replace(/__[a-z0-9]+__/g, "__").replace(/\/\d+(?=\/|$)/g, "/__"));

const X = "__x__";
const Y = "__y__";

const USED: [Method, string][] = [
  // encounters
  ["GET", clinicalRoutes.encounters()],
  ["POST", clinicalRoutes.encounters()],
  ["GET", clinicalRoutes.encounter(X)],
  ["PATCH", clinicalRoutes.encounter(X)],
  ["POST", clinicalRoutes.encounterSign(X)],
  ["POST", clinicalRoutes.encounterNotes(X)],
  ["PATCH", clinicalRoutes.encounterNote(X, Y)],
  ["DELETE", clinicalRoutes.encounterNote(X, Y)],
  ["GET", clinicalRoutes.encounterAmendments(X)],
  ["POST", clinicalRoutes.encounterAmendments(X)],
  ["POST", clinicalRoutes.encounterDiagnoses(X)],
  ["PATCH", clinicalRoutes.encounterDiagnosis(X, Y)],
  ["DELETE", clinicalRoutes.encounterDiagnosis(X, Y)],
  ["POST", clinicalRoutes.encounterProcedures(X)],
  ["PATCH", clinicalRoutes.encounterProcedure(X, Y)],
  ["DELETE", clinicalRoutes.encounterProcedure(X, Y)],
  ["GET", clinicalRoutes.encounterDocuments(X)],
  ["POST", clinicalRoutes.encounterDocuments(X)],
  ["DELETE", clinicalRoutes.encounterDocument(X, Y)],
  // patient clinical
  ["GET", clinicalRoutes.odontogram(X)],
  ["POST", clinicalRoutes.odontogram(X)],
  ["POST", clinicalRoutes.odontogramSupersede(X)],
  ["GET", clinicalRoutes.clinicalContext(X)],
  // plans
  ["GET", planRoutes.plans()],
  ["POST", planRoutes.plans()],
  ["GET", planRoutes.plan(X)],
  ["PATCH", planRoutes.plan(X)],
  ["POST", planRoutes.planPresent(X)],
  ["POST", planRoutes.planDecisions(X)],
  ["POST", planRoutes.planApprove(X)],
  ["POST", planRoutes.planCancel(X)],
  ["POST", planRoutes.planItems(X)],
  ["POST", planRoutes.planItemsReorder(X)],
  ["GET", planRoutes.planVersions(X)],
  ["GET", planRoutes.planVersion(X, 2)],
  ["GET", planRoutes.planDiff(X, 1, 3)],
  ["GET", planRoutes.planConsents(X)],
  ["PATCH", planRoutes.planItem(X)],
  ["DELETE", planRoutes.planItem(X)],
  ["POST", planRoutes.planItemStatus(X)],
  ["GET", planRoutes.planItemSessions(X)],
  ["POST", planRoutes.planItemSessions(X)],
  ["PATCH", planRoutes.planItemSession(X)],
  ["POST", planRoutes.planItemSessionComplete(X)],
  // consent
  ["GET", planRoutes.consentTemplates()],
  ["GET", planRoutes.consentTemplate(X)],
  ["GET", planRoutes.consentTemplateVersions(X)],
  ["POST", planRoutes.signConsent(X)],
];

describe("clinical route builders vs the real controllers", () => {
  const real = controllerRoutes();

  test("the controllers were parsed", () => {
    expect(real.size).toBeGreaterThan(40);
    expect(real.has("POST /encounters/:p/sign")).toBe(true);
    expect(real.has("GET /plans/:p/versions/:p/diff/:p")).toBe(true);
  });

  test.each(USED.map(([m, p]) => [`${m} ${p}`, m, p] as const))(
    "%s exists",
    (_n, method, built) => {
      expect(real).toContain(`${method} ${pattern(built)}`);
    },
  );

  test("every builder is exercised above", () => {
    const built = new Set(USED.map(([, p]) => pattern(p)));
    const call = (f: (...a: never[]) => string) =>
      pattern((f as (...a: unknown[]) => string)(X, 1, 2));
    for (const f of [...Object.values(clinicalRoutes), ...Object.values(planRoutes)])
      expect(built).toContain(call(f));
  });

  test("ids are encoded and versions are numeric", () => {
    expect(clinicalRoutes.encounterNote("a/b", "c d")).toBe("/encounters/a%2Fb/notes/c%20d");
    expect(planRoutes.planDiff("p1", 1, 3)).toBe("/plans/p1/versions/1/diff/3");
    expect(clinicalRoutes.clinicalContext("p1")).toBe("/patients/p1/clinical-context");
    expect(planRoutes.signConsent("p1")).toBe("/patients/p1/consents/sign");
  });
});
