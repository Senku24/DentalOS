import { PrismaClient } from "@prisma/client";

const ROLE_RE = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * Migration 0002 creates `dentalos_app` with a well-known DEV password so local setups work.
 * Deployments MUST rotate it right after `migrate deploy`; this does that with a value from the
 * secrets manager. Quoting is done by Postgres (`format(%I, %L)`), never by string concatenation.
 */
export async function setRolePassword(adminUrl: string, role: string, password: string) {
  if (!ROLE_RE.test(role)) throw new Error("invalid role name");
  if (password.length < 24) throw new Error("password too short (min 24 characters)");
  const prisma = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    const [row] = await prisma.$queryRaw<{ stmt: string }[]>`
      SELECT format('ALTER ROLE %I PASSWORD %L', ${role}::text, ${password}::text) AS stmt`;
    if (!row) throw new Error("could not build statement");
    await prisma.$executeRawUnsafe(row.stmt);
  } finally {
    await prisma.$disconnect();
  }
}
