import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

/**
 * Runs `fn` inside a transaction with the tenant context set for RLS.
 * Fails closed: an empty or malformed tenant id throws before any query runs.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("Invalid tenant context");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
