import {
  SpanKind,
  extractTraceContext,
  injectTraceContext,
  runInContext,
  withSpan,
} from "@dentalos/config";
import { type PrismaClient, type Tx, withTenant } from "@dentalos/db";
import { PgBoss } from "pg-boss";

/**
 * Every job carries tenant context, actor/source attribution and an idempotency key (PRD 6.6).
 * Payloads hold ids only: the pgboss schema is not tenant-RLS data, so no PII/clinical content here.
 */
export interface JobEnvelope<T = unknown> {
  tenantId: string;
  actorId: string;
  source: string;
  idempotencyKey: string;
  data: T;
  /** W3C trace context of the enqueuer, so the job continues the originating trace. */
  trace?: Record<string, string>;
}

export interface JobQueueOptions {
  retryLimit?: number;
  retryDelaySeconds?: number;
}

/**
 * Starts pg-boss. `connectionString` must be a role that may create / migrate the `pgboss` schema (the owner:
 * `PGBOSS_DATABASE_URL`, else `ADMIN_DATABASE_URL`). The tenant-scoped app role (`dentalos_app`, used by the API to
 * enqueue and by handlers through Prisma) has no rights on that schema, so after start-up the owner grants it
 * USAGE + DML (idempotent; also set as default privileges so queues created later are covered). Without this
 * the API's JobQueueService fails with "permission denied for schema pgboss".
 */
export async function startBoss(
  connectionString: string,
  opts: { appRole?: string | null } = {},
): Promise<PgBoss> {
  const boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    console.error(JSON.stringify({ level: "error", msg: "pgboss", err: String(err) })),
  );
  await boss.start();
  const role = opts.appRole === undefined ? "dentalos_app" : opts.appRole;
  if (role) await grantAppRole(boss, role);
  return boss;
}

/** GRANT the app role access to the pgboss schema. Non-fatal: privileges may instead be managed by the DBA. */
export async function grantAppRole(boss: PgBoss, role: string): Promise<boolean> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) throw new Error(`invalid role name: ${role}`);
  const r = `"${role}"`;
  const db = boss.getDb();
  try {
    for (const sql of [
      `GRANT USAGE ON SCHEMA pgboss TO ${r}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${r}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${r}`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${r}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO ${r}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO ${r}`,
    ]) {
      await db.executeSql(sql);
    }
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "warn",
        service: "worker",
        msg: "could not grant pgboss access to the app role (run the worker with PGBOSS_DATABASE_URL / ADMIN_DATABASE_URL)",
        role,
        err: String(err),
      }),
    );
    return false;
  }
}

/**
 * `short` policy = at most one *queued* job per singletonKey, which is what makes
 * idempotency-key de-duplication work (the default `standard` policy ignores singletonKey).
 */
export async function ensureQueue(boss: PgBoss, queue: string, opts: JobQueueOptions = {}) {
  await boss.createQueue(queue, {
    policy: "short",
    retryLimit: opts.retryLimit ?? 3,
    retryDelay: opts.retryDelaySeconds ?? 5,
    retryBackoff: true,
  });
}

export async function enqueue<T>(boss: PgBoss, queue: string, env: JobEnvelope<T>) {
  if (!env.tenantId || !env.idempotencyKey)
    throw new Error("job requires tenantId and idempotencyKey");
  // singletonKey de-duplicates identical in-flight jobs; handlers must still be idempotent
  // because delivery is at-least-once.
  const traced = { ...env, trace: env.trace ?? injectTraceContext() };
  return boss.send(queue, traced, { singletonKey: `${env.tenantId}:${env.idempotencyKey}` });
}

/**
 * Registers a handler that always runs inside the tenant's RLS context.
 * A throw => pg-boss retries per queue policy; exhausted jobs land failed (alert on these).
 */
export async function registerTenantJob<T>(
  boss: PgBoss,
  prisma: PrismaClient,
  queue: string,
  handler: (tx: Tx, env: JobEnvelope<T>) => Promise<void>,
  opts: JobQueueOptions = {},
) {
  await ensureQueue(boss, queue, opts);
  await boss.work<JobEnvelope<T>>(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      const env = job.data;
      await runInContext(extractTraceContext(env.trace), () =>
        withSpan(
          `job ${queue}`,
          {
            "messaging.system": "pg-boss",
            "messaging.destination.name": queue,
            "messaging.message.id": job.id,
            "dentalos.tenant_id": env.tenantId,
            "dentalos.job.source": env.source,
          },
          () =>
            withTenant(prisma, env.tenantId, (tx) => handler(tx, env), { actorId: env.actorId }),
          SpanKind.CONSUMER,
        ),
      );
    }
  });
}
