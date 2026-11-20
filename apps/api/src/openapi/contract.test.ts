import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { todayIn } from "../org/http";
import { type Harness, startHarness } from "../org/test-harness";
import { ROUTE_DOCS, type RouteDoc } from "./responses";

/**
 * Contract check: live responses of the registry-typed routes parse against the documented schemas
 * (ROUTE_DOCS → openapi.json), so the response contract cannot silently drift from the controllers.
 * Strict parsing: an undocumented extra field fails too.
 */
let h: Harness;
let t: string;
let owner: string;
let b1: string;

beforeAll(async () => {
  h = await startHarness();
  t = await h.tenant("Contract");
  b1 = await h.branch(t);
  owner = await h.member(t, ["OWNER", "DENTIST"], { orgWide: true });
});
afterAll(() => h.close());

/** Deep-strict copy of a zod schema: objects reject unknown keys. */
function strict(s: z.ZodType): z.ZodType {
  const def = (s as unknown as { def: { type: string } }).def;
  if (s instanceof z.ZodObject)
    return z.strictObject(
      Object.fromEntries(
        Object.entries(s.shape as Record<string, z.ZodType>).map(([k, v]) => [k, strict(v)]),
      ),
    );
  if (s instanceof z.ZodArray) return z.array(strict(s.element as z.ZodType));
  if (s instanceof z.ZodNullable) return strict(s.unwrap() as z.ZodType).nullable();
  if (s instanceof z.ZodOptional) return strict(s.unwrap() as z.ZodType).optional();
  void def;
  return s;
}

function check(opId: string, body: unknown) {
  const doc = ROUTE_DOCS[opId] as RouteDoc;
  expect(doc).toBeDefined();
  const schema = doc.items ? z.object({ items: z.array(doc.items) }) : (doc.response as z.ZodType);
  const r = strict(schema).safeParse(body);
  if (!r.success) throw new Error(`${opId}: ${JSON.stringify(r.error.issues)}`);
}

describe("registry-typed responses match live API responses", () => {
  test("org, branches, staff, invitations, assignments, me", async () => {
    const as = (method: string, path: string, body?: unknown) =>
      h.call(method, path, { user: owner, tenant: t, body });
    const ok = async (opId: string, method: string, path: string, body?: unknown) => {
      const r = await as(method, path, body);
      expect(`${opId} ${r.status}`).toBe(
        `${opId} ${method === "POST" && !path.includes("/") ? 201 : r.status < 300 ? r.status : 200}`,
      );
      check(opId, r.body);
      return r.body;
    };

    await ok("Me_me", "GET", "/me");
    await ok("Tenant_get", "GET", "/org");
    await ok("Tenant_onboarding", "GET", "/org/onboarding");
    await ok("Branches_list", "GET", "/branches");
    await ok("Branches_get", "GET", `/branches/${b1}`);
    await ok("Staff_list", "GET", "/staff");
    const inv = await ok("Invitations_create", "POST", "/invitations", {
      email: "contract@example.com",
      roles: ["RECEPTIONIST"],
      branchScope: [b1],
    });
    await ok("Invitations_list", "GET", "/invitations");
    await ok("Invitations_revoke", "POST", `/invitations/${inv.id}/revoke`);
    const tomorrow = new Date(`${todayIn("Asia/Kolkata")}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await ok("Assignments_assign", "POST", "/dentist-assignments", {
      userId: owner,
      branchId: b1,
      effectiveFrom: tomorrow.toISOString().slice(0, 10),
    });
    await ok("Assignments_list", "GET", "/dentist-assignments");

    const leaver = await h.member(t, ["RECEPTIONIST"], { branchScope: [b1] });
    const row = await h.admin.membership.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: t, userId: leaver } },
    });
    await ok("Staff_get", "GET", `/staff/${row.id}`);
    await ok("Staff_updateProfile", "PATCH", `/staff/${row.id}/profile`, { displayName: "Leaver" });
    await ok("Staff_remove", "DELETE", `/staff/${row.id}`);
    const again = await as("DELETE", `/staff/${row.id}`);
    expect(again.status).toBe(409);
    expect(ROUTE_DOCS.Staff_remove?.errors?.[409]).toContain(again.body.error);
  });
});
