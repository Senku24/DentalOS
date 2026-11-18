# M0 — Foundation status

## Done
- Turborepo + Bun workspaces: `apps/{api,worker,staff-web,patient-portal}`, `packages/{db,ui,contracts,validation,config}`.
- PostgreSQL 16 (docker, port 5433) with Prisma migrations; RLS on `Tenant`, `Branch`, `Membership`, `AuditEvent`
  (`FORCE ROW LEVEL SECURITY`, app role `dentalos_app` is NOSUPERUSER/NOBYPASSRLS, fails closed without `app.tenant_id`).
- `withTenant()` sets tenant context per transaction (`set_config(..., true)`), rejects non-UUID ids.
- API (NestJS on Bun): token verification abstraction, MFA required, membership resolved server-side
  (client `x-tenant-id` is only a hint), role decorator, branch-scope helper, append-only audit service, health live/ready, graceful shutdown.
- Design tokens + Button/Badge; CI workflow (lint, migrate, typecheck, test).

## Bun/NestJS POC (PRD 6.2) — partial
Proven under Bun 1.3.13: Nest HTTP (express adapter), DI with decorator metadata, jose JWT verification,
Prisma connectivity/transactions/migrations, health checks, graceful shutdown hook, integration tests via `bun test`.
NOT yet proven: background jobs/retries, file upload/download, WebSocket/SSE, structured logging/tracing/error monitoring,
container deployment. Fallback to Node.js LTS remains the decision if any of these fail.

## Not done in M0 yet
- Managed IdP (provider not chosen; `DevTokenVerifier` is dev/test only), step-up auth, patient OTP.
- Full permission matrix (PRD 12.2), break-glass access.
- Tamper-resistance of audit beyond append-only grants (e.g. hash chaining).
- Dockerfile, IaC, staging environments, OpenAPI generation, remaining design-system components, app shell.

## Local dev
`bun install && bun run db:up && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dentalos bunx --cwd packages/db prisma migrate deploy`
then `bun run test`. API needs `DATABASE_URL` (app role) and `DEV_JWT_SECRET`.
