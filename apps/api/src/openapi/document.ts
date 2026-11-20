import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import pkg from "../../package.json";
import { generateOpenApi } from "./generate";

/** apps/api/openapi.json — the committed, generated contract. */
export const OPENAPI_PATH = join(import.meta.dir, "..", "..", "openapi.json");

/** The API's OpenAPI document (imports AppModule lazily: env-free, nothing is instantiated). */
export async function buildOpenApi() {
  const { AppModule } = await import("../app.module");
  return generateOpenApi(AppModule, { version: pkg.version });
}

/** Semantic comparison, so formatting (Biome) never counts as drift. */
export function isStale(doc: unknown, committed: string): boolean {
  try {
    return !isDeepStrictEqual(JSON.parse(committed), JSON.parse(JSON.stringify(doc)));
  } catch {
    return true;
  }
}
