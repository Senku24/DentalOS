import { initTracing, shutdownTracing } from "@dentalos/config";

// Background worker entrypoint. Queue handlers are registered with registerTenantJob() (see jobs.ts)
// as modules add them; each handler runs inside tenant RLS context and continues the enqueuer's trace.
initTracing({ serviceName: process.env.SERVICE_NAME ?? "dentalos-worker", prisma: true });
console.log(JSON.stringify({ level: "info", service: "worker", msg: "worker started" }));

process.on("SIGTERM", () => {
  void shutdownTracing().finally(() => process.exit(0)); // flush spans, then exit
});
