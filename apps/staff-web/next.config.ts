import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const ROOT = path.resolve(process.cwd(), "../..");

/**
 * One `.env` at the repo root serves every app. Next only reads env files from its own folder, so
 * load the root file here (before NEXT_PUBLIC_* values are inlined). Existing env vars win.
 */
function loadRootEnv(file = path.join(ROOT, ".env")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] === undefined || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = (m[2] ?? "").replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadRootEnv();

const config: NextConfig = {
  transpilePackages: ["@dentalos/ui", "@dentalos/contracts", "@dentalos/validation"],
  // Monorepo root (builds run from apps/staff-web); silences the multiple-lockfile root guess.
  outputFileTracingRoot: ROOT,
  // Separate output dir for side-by-side builds (the e2e suite builds into
  // node_modules/.cache/e2e-<variant> so it never clobbers a running `next dev` in .next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Browser calls go same-origin to /api-proxy/*, which Next forwards to the API. This avoids CORS
  // and keeps the Authorization / X-Tenant-Id headers server-side in dev.
  async rewrites() {
    const api = (process.env.API_INTERNAL_URL || "http://localhost:3001").replace(/\/$/, "");
    return [{ source: "/api-proxy/:path*", destination: `${api}/:path*` }];
  },
};
export default config;
