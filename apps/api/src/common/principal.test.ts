import { expect, test } from "bun:test";
import type { Principal } from "../auth/roles";
import { branchWhere, withBranchScope } from "./principal";

const scoped: Principal = {
  userId: "u",
  tenantId: "t",
  roles: ["MANAGER"],
  orgWide: false,
  branchScope: ["b1", "b2"],
};
const org: Principal = { ...scoped, roles: ["OWNER"], orgWide: true, branchScope: [] };

test("spreading branchWhere over an existing key overwrites it (the documented pitfall)", () => {
  const spread: unknown = { id: "x", ...branchWhere(scoped, "id") };
  expect(spread).toEqual({ id: { in: ["b1", "b2"] } });
});

test("withBranchScope ANDs the scope and keeps every existing key and AND clause", () => {
  const merged = (...a: Parameters<typeof withBranchScope>): unknown => withBranchScope(...a);
  expect(merged(scoped, { tenantId: "t", id: "x" }, "id")).toEqual({
    tenantId: "t",
    id: "x",
    AND: [{ id: { in: ["b1", "b2"] } }],
  });
  expect(merged(scoped, { AND: [{ active: true }] })).toEqual({
    AND: [{ active: true }, { branchId: { in: ["b1", "b2"] } }],
  });
  expect(merged(org, { id: "x" })).toEqual({ id: "x", AND: [{}] });
});
