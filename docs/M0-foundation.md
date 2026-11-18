# M0 — Foundation status

See `docs/adr/0001-runtime.md` for the Bun/NestJS go/no-go evidence and gotchas, and `docs/permissions.md`
(generated) for the role/permission matrix. Overall plan: V1 implementation plan (M0→M5).

## Done
- Turborepo + Bun workspaces: `apps/{api,worker,staff-web,patient-portal}`, `packages/{db,ui,contracts,validation,config}`.
- PostgreSQL 16 + Prisma migrations `0001–0003`. RLS on every table (`FORCE ROW LEVEL SECURITY`); app role `dentalos_app`
  is NOSUPERUSER/NOBYPASSRLS and fails closed without `app.tenant_id`. **Meta-test fails CI if any table lacks forced RLS + a policy.**
- `withTenant()`: transaction-local tenant (+ optional actor) context, rejects non-UUID ids.
- Audit: append-only for the app role, **per-tenant SHA-256 hash chain** (trigger) and `verify_audit_chain(tenant)`; tamper test.
- Membership: `roles[]` (a user may be owner + dentist) and explicit `orgWide` flag.
- `@dentalos/contracts`: code-first permission catalogue, `can()` / `branchFilter()`, generated matrix doc, 23 table-driven tests.
- API (NestJS on Bun): token-verifier abstraction, MFA required, server-resolved membership, `@Can('perm')`, health, SSE
  (`/events`, tenant+branch filtered), pino logging with redaction + request ids, S3 presign service (tenant-prefixed keys).
- Worker: pg-boss job helpers (tenant envelope, retries, idempotent enqueue) with tests.
- `infra/Dockerfile.api` builds and runs healthy; SIGTERM exits 0. CI: biome, migrate, typecheck, test, image build.

## Not done in M0 yet
- Real S3/MinIO round trip; OpenTelemetry tracing/error monitoring; soak test (ADR exit criteria).
- Managed IdP verifier (Cognito) and step-up auth; patient OTP/portal principal (models land with `Patient` in M1).
- Privileged DB role + tenant provisioning path; AsyncLocalStorage tenant context helper (arrive with first real services, M1).
- Worker Dockerfile/entrypoint wiring, OpenAPI generation, Terraform/staging, backup job + restore drill.
- Design-system components beyond Button/Badge, and the app shell.

## Local dev
```
bun install && bun run db:up
cd packages/db && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dentalos bunx prisma migrate deploy && bunx prisma generate
cd ../.. && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dentalos bun run test
```
API env: `DATABASE_URL` (app role), `DEV_JWT_SECRET`. Start the API **from `apps/api`** (see ADR gotcha 1).
Regenerate the permission doc: `bun run --cwd packages/contracts docs:permissions`.
