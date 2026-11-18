// Background worker placeholder. Job queue (provider TBD, PRD 12.1) must preserve tenant context,
// actor/source attribution, and idempotency; job handlers should call withTenant() from @dentalos/db.
console.log("worker started");
process.on("SIGTERM", () => process.exit(0));
