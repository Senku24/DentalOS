/**
 * Applies Prisma migrations as the SUPERUSER (ADMIN_DATABASE_URL). The app role cannot run DDL, and
 * Prisma's CLI reads DATABASE_URL, so it is overridden for this child process only.
 *   bun run db:migrate   (bun --env-file=.env scripts/db-migrate.ts)
 */
const admin = process.env.ADMIN_DATABASE_URL;
if (!admin) throw new Error("ADMIN_DATABASE_URL is not set (copy .env.example to .env first)");

const proc = Bun.spawn(["bunx", "prisma", "migrate", "deploy"], {
  cwd: `${import.meta.dir}/../packages/db`,
  env: { ...process.env, DATABASE_URL: admin },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
