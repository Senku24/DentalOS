import { injectTraceContext } from "@dentalos/config";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PgBoss } from "pg-boss";
import { logger } from "../observability/logger";

/**
 * Same shape as the worker's JobEnvelope (apps/worker/src/jobs.ts): every job carries the tenant, the actor / source,
 * an idempotency key (PRD 6.6) and the enqueuer's trace context. Payloads hold ids only (the pgboss schema is not
 * tenant-RLS data: no PII / clinical content).
 */
export interface JobEnvelope<T = unknown> {
  tenantId: string;
  actorId: string;
  source: string;
  idempotencyKey: string;
  data: T;
  trace?: Record<string, string>;
}

export interface EnqueueOptions {
  /** Do not run before this time (reminders, quiet hours). */
  startAfter?: Date;
}

/**
 * Enqueues background jobs from the API (receipts, invoice-issued, refund-processed, reminders, plan consent, ...).
 * Send-only: the worker owns the pgboss schema and the queues (`ensureQueue` at its start-up) and grants this role
 * access to them (apps/worker/src/jobs.ts `grantAppRole`), so this client never installs or migrates anything. It
 * connects lazily with DATABASE_URL (the app role), so the API boots without the worker; `enqueue` then fails with
 * a clear error if the queue or privileges are not there yet.
 *
 * Enqueue AFTER the business transaction commits (and keep the `NotificationOutbox` / source row as the source of
 * truth): a job is a nudge, handlers must be idempotent and re-derive their work from ids.
 */
@Injectable()
export class JobQueueService implements OnModuleDestroy {
  private starting?: Promise<PgBoss>;

  private client(): Promise<PgBoss> {
    this.starting ??= (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is required to enqueue background jobs");
      const boss = new PgBoss({
        connectionString: url,
        max: 3,
        migrate: false,
        createSchema: false,
        supervise: false,
        schedule: false,
      });
      boss.on("error", (err) => logger.error({ err: String(err) }, "pgboss"));
      await boss.start();
      return boss;
    })();
    // A failed start must not be cached forever.
    this.starting.catch(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Returns the job id, or null when an identical job (same tenant + idempotency key) is already queued. */
  async enqueue<T>(
    queue: string,
    env: JobEnvelope<T>,
    opts: EnqueueOptions = {},
  ): Promise<string | null> {
    if (!env.tenantId || !env.idempotencyKey)
      throw new Error("job requires tenantId and idempotencyKey");
    const boss = await this.client();
    const traced = { ...env, trace: env.trace ?? injectTraceContext() };
    return boss.send(queue, traced, {
      singletonKey: `${env.tenantId}:${env.idempotencyKey}`,
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
    });
  }

  async onModuleDestroy() {
    const boss = await this.starting?.catch(() => undefined);
    await boss?.stop({ graceful: false, timeout: 5000 });
  }
}
