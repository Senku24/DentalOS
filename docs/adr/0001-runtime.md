# ADR 0001 — API runtime: NestJS on Bun (conditional GO)

Status: **Provisional GO** (2026-11-18). Decision owner: engineering. Fallback: Node.js 22 LTS (Dockerfile + start script change only).

## Evidence (PRD 6.2 checklist)
| Capability | Result | Proof |
|---|---|---|
| HTTP server + Nest adapter (express) | ✅ | `apps/api/src/api.test.ts` |
| Auth: JWT verification (jose), MFA gate, membership lookup | ✅ | api tests |
| Prisma connect / transactions / migrations / RLS | ✅ | `packages/db/src/rls.test.ts` |
| Background jobs + retries + dedupe (pg-boss 12) | ✅ | `apps/worker/src/jobs.test.ts` |
| SSE (tenant + branch filtered, heartbeat, clean shutdown) | ✅ | api tests |
| File flow: presigned download/upload (AWS SDK v3 under Bun) | ⚠️ signing + policy constraints proven; **real S3/MinIO round trip not yet run** (MinIO image not pullable in the build sandbox) | `platform.test.ts` |
| Structured logging (pino, redaction, request ids) | ✅ | `platform.test.ts` |
| Tracing / error monitoring (OpenTelemetry, Sentry-class) | ❌ not yet attempted | — |
| Graceful shutdown, health checks, container | ✅ image builds, `/health/*` OK, Docker HEALTHCHECK healthy, SIGTERM → exit 0 | `infra/Dockerfile.api` |
| Load behaviour of Bun+Nest under sustained traffic | ❌ not measured (M5 load test) | — |

## Gotchas found (keep!)
1. **Bun resolves `tsconfig.json` from the CWD, not the entry file.** Starting `bun apps/api/src/main.ts` from the repo root drops
   `experimentalDecorators` and Nest crashes with `descriptor.value` errors. Always start from `apps/api` (see Dockerfile `WORKDIR`).
2. **SSE blocks graceful shutdown** unless streams end: heartbeats (`interval`) never complete. `EventBus.closing` + `takeUntil` fixes it.
3. **pg-boss queue policy is fixed at creation**; de-dupe by `singletonKey` only works with the `short` policy, not the default.
4. `bunx --cwd <dir> prisma …` is not valid (bunx tried to fetch a package named after the dir) — run from the package directory.

## Exit criteria to turn GO into final GO
- Real S3 (or MinIO) upload/download round trip in CI or staging.
- OpenTelemetry tracing + error reporting working under Bun (or an explicit decision to use pino logs + CloudWatch metrics only for V1).
- A short soak test in staging (health + 50 rps for 30 min, no memory growth).
If any fails and cannot be fixed safely, switch the runtime to Node 22 LTS; domain code avoids `Bun.*` APIs so this is mechanical.

## Rules while GO
- No `Bun.*` runtime APIs in `apps/api`, `apps/worker` domain code or packages (tests may use `bun:test`).
- CI runs the API image build so a runtime switch stays one Dockerfile change.
