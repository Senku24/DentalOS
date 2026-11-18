import { context } from "@opentelemetry/api";
import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Runs `fn` inside a transaction with the tenant context set for RLS.
 * Fails closed: an empty or malformed tenant id throws before any query runs.
 * Context is transaction-local (`set_config(..., true)`), so it cannot leak across pooled connections.
 * Do not perform network I/O inside `fn`: it holds a transaction open.
 *
 * `actorId` is exposed to DB-side triggers as `app.actor_id` for attribution.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: { actorId?: string } = {},
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("Invalid tenant context");
  // Prisma runs interactive-transaction callbacks outside the caller's async context, which would
  // orphan every DB span (and the tenant/request trace). Re-enter the captured context explicitly.
  const parent = context.active();
  return prisma.$transaction(async (tx) =>
    context.with(parent, async () => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      if (opts.actorId !== undefined)
        await tx.$executeRaw`SELECT set_config('app.actor_id', ${opts.actorId}, true)`;
      // `await` inside the context: Prisma promises are lazy and only start on first `then`.
      return await fn(tx);
    }),
  );
}
