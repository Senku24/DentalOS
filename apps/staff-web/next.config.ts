import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@dentalos/ui", "@dentalos/contracts", "@dentalos/validation"],
  // Monorepo root (builds run from apps/staff-web); silences the multiple-lockfile root guess.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
};
export default config;
