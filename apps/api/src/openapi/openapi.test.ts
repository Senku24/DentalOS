import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { OPENAPI_PATH, buildOpenApi, isStale } from "./document";

type Op = Record<string, unknown> & { parameters?: { name?: string; in?: string }[] };
type Doc = { openapi: string; paths: Record<string, Record<string, Op>> };

const doc = (await buildOpenApi()) as unknown as Doc;

test("apps/api/openapi.json is up to date (run `bun run openapi` in apps/api)", () => {
  expect(existsSync(OPENAPI_PATH)).toBe(true);
  expect(isStale(doc, readFileSync(OPENAPI_PATH, "utf8"))).toBe(false);
});

test("isStale detects drift and ignores formatting", () => {
  const text = JSON.stringify(doc);
  expect(isStale(doc, JSON.stringify(JSON.parse(text), null, 4))).toBe(false);
  const changed = JSON.parse(text) as Doc;
  const { "/staff/{id}": _dropped, ...rest } = changed.paths;
  expect(isStale(doc, JSON.stringify({ ...changed, paths: rest }))).toBe(true);
  expect(isStale(doc, "not json")).toBe(true);
});

test("routes, auth metadata and zod inputs are derived from the app", () => {
  expect(doc.openapi).toBe("3.1.0");
  const remove = doc.paths["/staff/{id}"]?.delete as Op;
  expect(remove["x-permission"]).toBe("staff:manage");
  expect(remove.responses).toHaveProperty("200");
  expect(remove.parameters).toContainEqual(expect.objectContaining({ name: "id", in: "path" }));
  // Body schema comes from the ZodPipe, named after the @dentalos/validation export.
  const patch = doc.paths["/staff/{id}"]?.patch as Op;
  expect(JSON.stringify(patch.requestBody)).toContain(
    "#/components/schemas/UpdateMembershipRequest",
  );
  // @Authenticated (no tenant header), @Public (no security), @StepUp extension.
  const accept = doc.paths["/invitations/accept"]?.post as Op;
  expect(accept["x-auth"]).toBe("authenticated");
  expect(JSON.stringify(accept.parameters ?? [])).not.toContain("TenantId");
  expect(doc.paths["/me/admin"]?.get?.["x-step-up-max-age"]).toBe(900);
  const health = Object.entries(doc.paths).find(([p]) => p.startsWith("/health"))?.[1];
  expect(Object.values(health ?? {})[0]?.security).toEqual([]);
  // Query objects are expanded into parameters.
  const staffList = doc.paths["/staff"]?.get as Op;
  const names = (staffList.parameters ?? []).map((p) => p.name);
  expect(names).toEqual(expect.arrayContaining(["role", "branchId"]));
  // Every path template variable is declared.
  for (const [path, ops] of Object.entries(doc.paths)) {
    const vars = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const op of Object.values(ops)) {
      const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      for (const v of vars)
        expect(`${path} ${v}: ${declared.includes(v)}`).toBe(`${path} ${v}: true`);
    }
  }
});

test("operation ids are unique", () => {
  const ids = Object.values(doc.paths).flatMap((ops) =>
    Object.values(ops).map((o) => o.operationId as string),
  );
  expect(new Set(ids).size).toBe(ids.length);
});
