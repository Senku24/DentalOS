/**
 * Writes apps/api/openapi.json from the Nest app's own metadata (see src/openapi/generate.ts).
 *   bun run openapi           # regenerate
 *   bun run openapi --check   # exit 1 when openapi.json is stale (CI)
 */
import "reflect-metadata";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENAPI_PATH, buildOpenApi, isStale } from "../src/openapi/document";

const doc = await buildOpenApi();
if (process.argv.includes("--check")) {
  if (isStale(doc, readFileSync(OPENAPI_PATH, "utf8"))) {
    console.error("openapi.json is stale: run `bun run openapi` in apps/api");
    process.exit(1);
  }
  console.log("openapi.json is up to date");
} else {
  writeFileSync(OPENAPI_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  // Keep the committed file in Biome's JSON style so `biome check .` stays green.
  const root = join(import.meta.dir, "..", "..", "..");
  const r = Bun.spawnSync(["bunx", "biome", "format", "--write", OPENAPI_PATH], { cwd: root });
  if (r.exitCode !== 0) console.warn(r.stderr.toString());
  console.log(`wrote ${OPENAPI_PATH} (${Object.keys(doc.paths as object).length} paths)`);
}
