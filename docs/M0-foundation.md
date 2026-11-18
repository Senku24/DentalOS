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
- **Design system** (`@dentalos/ui`): AA-checked tokens (contrast asserted in tests), Button, Badge, Text/Select/Textarea fields,
  Card/StatCard, DataTable (sort, search, paging, loading/empty/error), Dialog/Drawer/ConfirmDialog, Toast, Alert, Skeleton/Spinner,
  Empty/Error states, Breadcrumbs/PageHeader, **AppShell** (collapsible sidebar, branch switcher, ⌘K palette, notifications, account menu,
  mobile drawer, skip link). Staff app wires it with permission-filtered nav; `/design` shows every state. 32 unit tests incl. axe;
  real-browser axe (with contrast) run on `/design` + overlays at desktop and phone width: 0 violations.
- **Observability** (`@dentalos/config`): OpenTelemetry tracing (OTLP/HTTP via `OTEL_EXPORTER_OTLP_ENDPOINT`), request spans, Prisma spans,
  trace context carried into background jobs, trace ids in logs, PII-safe error recording. **Storage**: real S3 round-trip tests in CI
  (SeaweedFS service in compose; `S3_TEST_ENDPOINT`).
- **Identity**: `CognitoTokenVerifier` (JWKS, RS256-pinned, fails closed), env-driven `createTokenVerifier` (dev secret refused in production), `@StepUp` re-auth guard. **Infrastructure as code** (`infra/terraform`): KMS, VPC, RDS, S3 (+object-locked audit bucket), Cognito pools, ECS/ALB/WAF, OIDC deploy role, alarms; validated + Trivy-clean, **not applied**. `deploy.yml` (manual) and DB role-password rotation proven in a container. See ADR 0002.
- `infra/Dockerfile.api` builds and runs healthy; SIGTERM exits 0. CI: biome, migrate, typecheck, test, image build.

## Not done in M0 yet
- Soak test, plus re-checking object storage and the OTLP path against real AWS in staging (ADR exit criteria).
- Staff-web sign-in (OAuth code-flow BFF + session) against Cognito; patient OTP/portal principal (models land with `Patient` in M1).
- Privileged DB role + tenant provisioning path; AsyncLocalStorage tenant context helper (arrive with first real services, M1).
- Applying Terraform to a real AWS account (staging) and the first restore drill; OpenAPI generation; web-app images/services.
- Real-browser accessibility check in CI (Playwright + axe on `/design`); saved table views; server-driven table paging (M1).
- Patient-portal visual identity (it currently only shares tokens/base styles).

## Local dev
```
bun install && bun run db:up
cd packages/db && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dentalos bunx prisma migrate deploy && bunx prisma generate
cd ../.. && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dentalos bun run test
```
API env: `DATABASE_URL` (app role), `DEV_JWT_SECRET`. Start the API **from `apps/api`** (see ADR gotcha 1).
Regenerate the permission doc: `bun run --cwd packages/contracts docs:permissions`.
