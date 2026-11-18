import path from "node:path";
import type { NextConfig } from "next";

/**
 * `@dentalos/validation` is not yet a declared dependency of staff-web (package.json is owned by the
 * foundation). Until it is, it resolves through the tsconfig `paths` alias, and `externalDir` lets
 * Next compile the TypeScript sources that live outside this app directory.
 */
const config: NextConfig = {
  transpilePackages: ["@dentalos/ui", "@dentalos/contracts"],
  experimental: { externalDir: true },
  // Monorepo root (builds run from apps/staff-web); silences the multiple-lockfile root guess.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
};
export default config;
