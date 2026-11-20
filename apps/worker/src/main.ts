import { initTracing, shutdownTracing } from "@dentalos/config";
import { PrismaClient } from "@dentalos/db";
import type { PgBoss } from "pg-boss";
import { handlerRegistrars, registerHandlers } from "./handlers";
import { startBoss } from "./jobs";

// Background worker entrypoint. Queue handlers are registered with registerTenantJob() (see jobs.ts) from
// ./handlers as modules add them; each handler runs inside tenant RLS context and continues the enqueuer's trace.
initTracing({ serviceName: process.env.SERVICE_NAME ?? "dentalos-worker", prisma: true });
console.log(JSON.stringify({ level: "info", service: "worker", msg: "worker started" }));

let boss: PgBoss | undefined;
let prisma: PrismaClient | undefined;

// pg-boss (and its schema) is only started once there is something to run.
if (handlerRegistrars.length > 0) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run background handlers");
  prisma = new PrismaClient({ datasources: { db: { url } } });
  // pg-boss installs / migrates its own schema, which the tenant-scoped app role cannot do: connect as the owner
  // (PGBOSS_DATABASE_URL, else ADMIN_DATABASE_URL, else DATABASE_URL) and let startBoss grant the app role access so
  // the API can enqueue (docs/LOCAL-SETUP.md "Background jobs").
  const bossUrl = process.env.PGBOSS_DATABASE_URL || process.env.ADMIN_DATABASE_URL || url;
  boss = await startBoss(bossUrl, { appRole: process.env.PGBOSS_APP_ROLE || "dentalos_app" });
  await registerHandlers({ boss, prisma });
  console.log(
    JSON.stringify({
      level: "info",
      service: "worker",
      msg: "handlers registered",
      count: handlerRegistrars.length,
    }),
  );
}

process.on("SIGTERM", () => {
  void (async () => {
    await boss?.stop();
    await prisma?.$disconnect();
    await shutdownTracing(); // flush spans, then exit
  })().finally(() => process.exit(0));
});
