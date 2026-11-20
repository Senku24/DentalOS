import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Permission } from "@dentalos/contracts";
import { ROLE_PERMISSIONS } from "@dentalos/contracts";
import type { ApiClient } from "./client";
import { ApiError } from "./errors";
import { fid } from "./fixtures";
import { createSchedulingApi } from "./scheduling";
import { loadBranchDentists, withKnownDentists } from "./scheduling-dentists";
import { resetSchedulingMock, schedulingMockCall, setMockPrincipal } from "./scheduling-mock";

const B1 = fid("0b", 1);

/** The scheduling client wired straight to the mock (no latency, no session import). */
const mockClient: ApiClient = {
  config: { baseUrl: "", mock: true },
  request: (method, path, opts) =>
    schedulingMockCall(
      method,
      path,
      Object.fromEntries(
        Object.entries(opts?.query ?? {})
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ),
      opts?.body,
    ) as never,
};
const sapi = createSchedulingApi(mockClient);

const as = (role: keyof typeof ROLE_PERMISSIONS) =>
  setMockPrincipal((perm: Permission) =>
    (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(perm),
  );
const label = (id: string) => `label:${id}`;

beforeEach(() => resetSchedulingMock(new Date()));
afterAll(() => setMockPrincipal(() => true));

describe("dentist pickers without staff:read", () => {
  test("the mock enforces staff:read on /dentist-assignments and /staff like the API", async () => {
    as("RECEPTIONIST");
    const err = await sapi.directory.dentistAssignments({ branchId: B1, status: "current" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    await expect(sapi.directory.staff({ role: "DENTIST" })).rejects.toBeInstanceOf(ApiError);
  });

  test("manager: full list from current assignments, not the fallback", async () => {
    as("MANAGER");
    const r = await loadBranchDentists(sapi, B1, label);
    expect(r.source).toBe("assignments");
    expect(r.dentists.map((d) => d.userId).sort()).toEqual(["usr-dent-1", "usr-owner-1"]);
  });

  test("receptionist / dentist: 403 falls back to dentists with working hours here, not an empty list", async () => {
    for (const role of ["RECEPTIONIST", "DENTIST"] as const) {
      as(role);
      const r = await loadBranchDentists(sapi, B1, label);
      expect(r.source).toBe("working-hours");
      expect(r.dentists).toEqual([{ userId: "usr-dent-1", label: "label:usr-dent-1" }]);
    }
  });

  test("ids already on screen are added once, sorted by label", () => {
    const base = [{ userId: "b", label: "Bea" }];
    expect(withKnownDentists(base, ["a", null, "b", "a", undefined], (id) => `Al ${id}`)).toEqual([
      { userId: "a", label: "Al a" },
      { userId: "b", label: "Bea" },
    ]);
    expect(withKnownDentists(base, [], label)).toEqual(base);
  });
});
