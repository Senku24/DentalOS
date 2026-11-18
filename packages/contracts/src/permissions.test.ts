import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ALL_PERMISSIONS,
  type Principal,
  ROLES,
  ROLE_PERMISSIONS,
  branchFilter,
  can,
  renderPermissionsDoc,
} from "./index";

const T = "11111111-1111-1111-1111-111111111111";
const B1 = "b1";
const B2 = "b2";
const p = (over: Partial<Principal>): Principal => ({
  userId: "u1",
  tenantId: T,
  roles: ["MANAGER"],
  orgWide: false,
  branchScope: [B1],
  ...over,
});

test("every role permission exists in the catalogue", () => {
  for (const r of ROLES)
    for (const perm of ROLE_PERMISSIONS[r]) expect(ALL_PERMISSIONS).toContain(perm);
});

test("every permission is granted to at least one role (no dead permissions)", () => {
  for (const perm of ALL_PERMISSIONS) {
    const holders = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(perm));
    // breakglass is deliberately ungranted until the audited workflow exists (PRD 7.4).
    if (perm === "breakglass:use") expect(holders).toHaveLength(0);
    else expect(holders.length).toBeGreaterThan(0);
  }
});

test("PATIENT has no staff permissions", () => {
  expect(ROLE_PERMISSIONS.PATIENT).toHaveLength(0);
  for (const perm of ALL_PERMISSIONS)
    expect(can(p({ roles: ["PATIENT"], orgWide: true }), perm)).toBe(false);
});

// [role, permission, expected]: separation-of-duties and least-privilege assertions.
const table: [Principal["roles"][number], (typeof ALL_PERMISSIONS)[number], boolean][] = [
  ["RECEPTIONIST", "clinical:sign", false],
  ["RECEPTIONIST", "refund:issue", false],
  ["RECEPTIONIST", "appointment:write", true],
  ["DENTIST", "refund:issue", false],
  ["DENTIST", "clinical:sign", true],
  ["DENTIST", "staff:manage", false],
  ["ACCOUNTANT", "clinical:read", false],
  ["ACCOUNTANT", "refund:issue", true],
  ["MANAGER", "clinical:sign", false],
  ["MANAGER", "compensation:manage", false],
  ["OWNER", "clinical:sign", false],
  ["OWNER", "staff:manage", true],
];
for (const [role, perm, want] of table)
  test(`${role} ${want ? "can" : "cannot"} ${perm}`, () => {
    expect(can(p({ roles: [role], orgWide: true }), perm)).toBe(want);
  });

test("branch scope: in-scope allowed, out-of-scope denied", () => {
  const m = p({});
  expect(can(m, "appointment:write", { branchId: B1 })).toBe(true);
  expect(can(m, "appointment:write", { branchId: B2 })).toBe(false);
});

test("orgWide principal reaches every branch; scoped one gets a filter", () => {
  expect(can(p({ orgWide: true }), "appointment:write", { branchId: B2 })).toBe(true);
  expect(branchFilter(p({ orgWide: true }))).toBeUndefined();
  expect(branchFilter(p({}))).toEqual([B1]);
});

test("empty branch scope without orgWide grants no branch data (fails closed)", () => {
  const m = p({ branchScope: [] });
  expect(can(m, "appointment:write", { branchId: B1 })).toBe(false);
  expect(branchFilter(m)).toEqual([]);
});

test("org-scoped permissions require orgWide", () => {
  expect(can(p({ roles: ["OWNER"], orgWide: false }), "staff:manage")).toBe(false);
  expect(can(p({ roles: ["OWNER"], orgWide: true }), "staff:manage")).toBe(true);
});

test("cross-tenant resource is always denied", () => {
  const owner = p({ roles: ["OWNER"], orgWide: true });
  expect(can(owner, "patient:read", { tenantId: "22222222-2222-2222-2222-222222222222" })).toBe(
    false,
  );
  expect(can(owner, "patient:read", { tenantId: T })).toBe(true);
});

test("self scope: dentist sees own compensation only", () => {
  const d = p({ roles: ["DENTIST"] });
  expect(can(d, "compensation:read", { ownerUserId: "u1" })).toBe(true);
  expect(can(d, "compensation:read", { ownerUserId: "u2" })).toBe(false);
  expect(can(d, "compensation:read")).toBe(false);
});

test("multiple roles take the union (owner who is also a dentist)", () => {
  const both = p({ roles: ["OWNER", "DENTIST"], orgWide: true });
  expect(can(both, "clinical:sign", { branchId: B1 })).toBe(true);
  expect(can(both, "staff:manage")).toBe(true);
});

test("docs/permissions.md is in sync with the matrix", () => {
  const file = readFileSync(new URL("../../../docs/permissions.md", import.meta.url), "utf8");
  expect(file).toBe(renderPermissionsDoc());
});
