import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Role } from "@dentalos/db";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SignJWT } from "jose";

/**
 * Test-only harness for the org/catalog/documents API suites: boots the real AppModule on a random
 * port against the local Postgres (app role, RLS on) and mints dev HS256 tokens. Every suite uses
 * fresh random tenants and never deletes shared rows (other suites run against the same DB).
 */
process.env.DEV_JWT_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATABASE_URL ??= "postgresql://dentalos_app:dentalos_app@localhost:5433/dentalos";
const ADMIN_URL = "postgresql://postgres:postgres@localhost:5433/dentalos";

const key = () => new TextEncoder().encode(process.env.DEV_JWT_SECRET);
export const token = (sub: string, mfa = true, email?: string) =>
  new SignJWT(email === undefined ? { mfa } : { mfa, email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(key());

export interface Harness {
  app: INestApplication;
  admin: PrismaClient;
  base: string;
  close(): Promise<void>;
  /** Creates a tenant via the admin (RLS-bypassing) connection. */
  tenant(name?: string): Promise<string>;
  member(
    tenantId: string,
    roles: Role[],
    opts?: { orgWide?: boolean; branchScope?: string[]; userId?: string },
  ): Promise<string>;
  branch(tenantId: string, code?: string): Promise<string>;
  call(
    method: string,
    path: string,
    opts: { user: string; tenant: string; body?: unknown; mfa?: boolean },
    // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON responses in tests
  ): Promise<{ status: number; body: any }>;
}

export const uid = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
export const code = (prefix = "B") =>
  `${prefix}${randomUUID().replace(/-/g, "").slice(0, 8)}`.toUpperCase();

export async function startHarness(): Promise<Harness> {
  const { AppModule } = await import("../app.module");
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const base = (await app.getUrl()).replace("[::1]", "localhost");
  return {
    app,
    admin,
    base,
    async close() {
      await app.close();
      await admin.$disconnect();
    },
    async tenant(name = "W1 test") {
      return (await admin.tenant.create({ data: { name } })).id;
    },
    async member(tenantId, roles, opts = {}) {
      const userId = opts.userId ?? uid(roles[0]?.toLowerCase() ?? "user");
      await admin.membership.create({
        data: {
          tenantId,
          userId,
          roles,
          orgWide: opts.orgWide ?? false,
          branchScope: opts.branchScope ?? [],
        },
      });
      return userId;
    },
    async branch(tenantId, c = code()) {
      return (await admin.branch.create({ data: { tenantId, code: c, name: `Branch ${c}` } })).id;
    },
    async call(method, path, opts) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await token(opts.user, opts.mfa ?? true)}`,
        "x-tenant-id": opts.tenant,
      };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const r = await fetch(base + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await r.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {}
      return { status: r.status, body };
    },
  };
}
