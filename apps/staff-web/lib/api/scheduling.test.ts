import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApiClient, Method } from "./client";
import { createSchedulingApi, schedulingRoutes } from "./scheduling";

/**
 * Route builders and client methods vs the REAL Nest controllers (parsed from source, so a path or
 * verb change in apps/api breaks this test instead of the front desk).
 */

const CONTROLLERS = [
  "scheduling/appointments.controller.ts",
  "scheduling/chairs.controller.ts",
  "scheduling/working-hours.controller.ts",
  "scheduling/availability.controller.ts",
  "realtime/events.controller.ts",
  "plans/plans.controller.ts",
  // Read-only staff directory used for dentist pickers (staff:read; see scheduling-dentists.ts).
  "org/assignments.controller.ts",
  "org/staff.controller.ts",
];

const norm = (path: string) =>
  `/${path
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith(":") || s === "ID" ? ":p" : s))
    .join("/")}`;

function controllerRoutes(): Set<string> {
  const out = new Set<string>();
  for (const rel of CONTROLLERS) {
    const src = readFileSync(
      fileURLToPath(new URL(`../../../api/src/${rel}`, import.meta.url)),
      "utf8",
    );
    let prefix = "";
    const re = /@(Controller|Get|Post|Put|Patch|Delete|Sse)\((?:"([^"]*)")?\)/g;
    for (const m of src.matchAll(re)) {
      const [, deco, arg = ""] = m;
      if (deco === "Controller") {
        prefix = arg;
        continue;
      }
      const verb = deco === "Sse" ? "GET" : (deco as string).toUpperCase();
      out.add(`${verb} ${norm(`${prefix}/${arg}`)}`);
    }
  }
  return out;
}

const routes = controllerRoutes();

describe("scheduling routes vs controllers", () => {
  test("controllers were parsed", () => {
    expect(routes.has("POST /appointments/:p/reschedule")).toBe(true);
    expect(routes.has("GET /front-desk/queue")).toBe(true);
    expect(routes.has("GET /events")).toBe(true);
  });

  test("every route builder points at a real controller path", () => {
    for (const [name, build] of Object.entries(schedulingRoutes)) {
      const path = norm((build as (id?: string) => string)("ID"));
      const exists = [...routes].some((r) => r.endsWith(` ${path}`));
      if (!exists) throw new Error(`${name} → ${path} has no controller route`);
    }
  });

  test("every scheduling controller route has a builder", () => {
    const built = new Set(
      Object.values(schedulingRoutes).map((b) => norm((b as (id?: string) => string)("ID"))),
    );
    const scheduling = [...routes].filter((r) => !/ \/(plan|staff|dentist-assignments)/.test(r));
    for (const r of scheduling) expect(built.has(r.split(" ")[1] as string)).toBe(true);
  });

  test("path segments are encoded", () => {
    expect(schedulingRoutes.appointmentCancel("a/b c")).toBe("/appointments/a%2Fb%20c/cancel");
  });

  test("every client method uses the controller's verb and path", async () => {
    const calls: { method: Method; path: string; query?: unknown; body?: unknown }[] = [];
    const fake: ApiClient = {
      config: { baseUrl: "", mock: false },
      request: async (method, path, opts) => {
        calls.push({ method, path, query: opts?.query, body: opts?.body });
        return {} as never;
      },
    };
    const api = createSchedulingApi(fake);
    const b = "00000000-0000-4000-8000-000000000001";
    await api.chairs.list({ branchId: b });
    await api.chairs.get("ID");
    await api.chairs.create({ branchId: b, code: "C1", name: "Chair" });
    await api.chairs.update("ID", { name: "x" });
    await api.chairs.setActive("ID", true);
    await api.chairs.setActive("ID", false);
    await api.hours.list({ branchId: b });
    await api.hours.set({
      scope: "BRANCH",
      branchId: b,
      effectiveFrom: "2026-12-01",
      sessions: [],
    });
    await api.settings.get(b);
    await api.settings.update(b, { slotMinutes: 10 });
    await api.availability({ branchId: b, date: "2026-12-01", durationMin: 30 });
    await api.appointments.list({ branchId: b, status: ["BOOKED", "CONFIRMED"] });
    await api.appointments.get("ID");
    await api.appointments.events("ID");
    await api.appointments.book({} as never);
    await api.appointments.walkIn({} as never);
    await api.appointments.update("ID", {});
    await api.appointments.transition("ID", { to: "CHECKED_IN" });
    await api.appointments.cancel("ID", "Patient called");
    await api.appointments.reschedule("ID", {} as never);
    await api.frontDesk.queue({ branchId: b });
    await api.plans.list({ patientId: b });
    await api.plans.get("ID");
    await api.directory.dentistAssignments({ branchId: b, status: "current" });
    await api.directory.staff({ role: "DENTIST" });
    for (const c of calls) {
      const key = `${c.method} ${norm(c.path)}`;
      if (!routes.has(key)) throw new Error(`${key} is not a controller route`);
    }
    expect(calls.length).toBe(25);
    // status filter is a comma list on the wire; settings PATCH carries branchId in the query.
    expect(calls[11]?.query).toMatchObject({ status: "BOOKED,CONFIRMED" });
    expect(calls[9]).toMatchObject({ method: "PATCH", query: { branchId: b } });
    expect(calls[18]?.body).toEqual({ reason: "Patient called" });
  });
});
