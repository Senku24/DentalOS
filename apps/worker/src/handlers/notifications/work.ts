import {
  SpanKind,
  extractTraceContext,
  injectTraceContext,
  runInContext,
  withSpan,
} from "@dentalos/config";
import { type PrismaClient, type Tx, withTenant } from "@dentalos/db";
import type { z } from "@dentalos/validation";
import type { PgBoss } from "pg-boss";
import { type JobEnvelope, type JobQueueOptions, ensureQueue } from "../../jobs";

/**
 * Notification handler runner. Same contract as `registerTenantJob` (jobs.ts): tenant envelope, trace continuation,
 * a span per job, handlers run with RLS context (`withTenant`, actor = envelope actor). The difference is that the
 * handler receives a `tx()` function instead of one open transaction, so it can keep every transaction short and do
 * its network I/O (provider send) and its follow-up enqueues OUTSIDE any transaction (ADR 0004 §9.5, M3 conventions:
 * no network I/O inside `withTenant`; enqueue AFTER the business commit).
 */
export interface WorkCtx<T> {
  env: JobEnvelope<T>;
  boss: PgBoss;
  /** One short tenant transaction (RLS + actor of the envelope). */
  tx<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
  /** Enqueue a follow-up job for the same tenant (call it AFTER the transaction that produced the rows committed). */
  send(
    queue: string,
    data: unknown,
    opts: { idempotencyKey: string; startAfter?: Date; source?: string },
  ): Promise<string | null>;
}

export interface HandlerCtx {
  boss: PgBoss;
  prisma: PrismaClient;
}

export const log = (level: "info" | "warn" | "error", msg: string, extra: object = {}) =>
  console[level === "info" ? "log" : level](
    JSON.stringify({ level, service: "worker", msg, ...extra }),
  );

/** Sends a tenant-envelope job (singletonKey de-dupes identical queued jobs; `startAfter` delays it). */
export async function sendJob(
  boss: PgBoss,
  queue: string,
  env: JobEnvelope,
  opts: { startAfter?: Date } = {},
) {
  if (!env.tenantId || !env.idempotencyKey)
    throw new Error("job requires tenantId and idempotencyKey");
  return boss.send(
    queue,
    { ...env, trace: env.trace ?? injectTraceContext() },
    {
      singletonKey: `${env.tenantId}:${env.idempotencyKey}`,
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
    },
  );
}

/**
 * Registers `handler` on `queue`. A payload that fails `schema` is logged and dropped (a poison message must not
 * retry forever); a throw from the handler makes pg-boss retry per the queue policy.
 */
export async function registerWork<S extends z.ZodType>(
  ctx: HandlerCtx,
  queue: string,
  schema: S,
  handler: (c: WorkCtx<z.output<S>>) => Promise<void>,
  opts: JobQueueOptions = {},
) {
  const { boss, prisma } = ctx;
  await ensureQueue(boss, queue, opts);
  await boss.work<JobEnvelope<unknown>>(queue, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
    for (const job of jobs) {
      const raw = job.data;
      const parsed = schema.safeParse(raw?.data ?? {});
      if (!raw?.tenantId || !parsed.success) {
        log("error", "dropping malformed job", { queue, jobId: job.id });
        continue;
      }
      const env = { ...raw, data: parsed.data } as JobEnvelope<z.output<S>>;
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
            handler({
              env,
              boss,
              tx: (fn) => withTenant(prisma, env.tenantId, fn, { actorId: env.actorId }),
              send: (q, data, o) =>
                sendJob(
                  boss,
                  q,
                  {
                    tenantId: env.tenantId,
                    actorId: env.actorId,
                    source: o.source ?? env.source,
                    idempotencyKey: o.idempotencyKey,
                    data,
                  },
                  { startAfter: o.startAfter },
                ),
            }),
          SpanKind.CONSUMER,
        ),
      );
    }
  });
}
