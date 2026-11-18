# ADR 0001 — API runtime: NestJS on Bun (conditional GO)

Status: **Provisional GO** (2026-11-18, updated 2026-11-19: tracing and real object-storage round trip proven). Decision owner: engineering. Fallback: Node.js 22 LTS (Dockerfile + start script change only).

## Evidence (PRD 6.2 checklist)
| Capability | Result | Proof |
|---|---|---|
| HTTP server + Nest adapter (express) | ✅ | `apps/api/src/api.test.ts` |
| Auth: JWT verification (jose), MFA gate, membership lookup | ✅ | api tests |
| Prisma connect / transactions / migrations / RLS | ✅ | `packages/db/src/rls.test.ts` |
| Background jobs + retries + dedupe (pg-boss 12) | ✅ | `apps/worker/src/jobs.test.ts` |
| SSE (tenant + branch filtered, heartbeat, clean shutdown) | ✅ | api tests |
| File flow: presigned POST upload + GET download (AWS SDK v3 under Bun) | ✅ real round trip against a SigV4-validating S3 server (SeaweedFS in `infra/docker-compose.yml`): bytes match, tampered/unsigned/re-pointed URLs refused, oversize (400) and wrong content-type (403) rejected by storage, foreign-tenant key unsignable. **Not yet against AWS S3 itself: repeat in staging** | `storage.s3.test.ts`, `platform.test.ts` |
| Structured logging (pino, redaction, request ids) | ✅ | `platform.test.ts` |
| Tracing (OpenTelemetry) | ✅ SDK 3.x + AsyncLocalStorage context + OTLP/HTTP export under Bun (also from the Linux container, flushed on SIGTERM); request SERVER spans, Prisma child spans (incl. inside `withTenant`), W3C context continued into pg-boss jobs, logs carry trace/span ids | `packages/config/src/tracing.test.ts`, `observability/tracing.test.ts`, `worker/src/jobs.test.ts` |
| Error monitoring | ✅ (in-region, vendor-neutral) unhandled errors → span exception event + pino error with trace id, **messages stripped** (they can embed PII). A hosted Sentry-class tool stays an optional provider decision | `TracedExceptionFilter` |
| Graceful shutdown, health checks, container | ✅ image builds, `/health/*` OK, Docker HEALTHCHECK healthy, SIGTERM → exit 0 | `infra/Dockerfile.api` |
| Load behaviour of Bun+Nest under sustained traffic | ❌ not measured (M5 load test) | — |

## Gotchas found (keep!)
1. **Bun resolves `tsconfig.json` from the CWD, not the entry file.** Starting `bun apps/api/src/main.ts` from the repo root drops
   `experimentalDecorators` and Nest crashes with `descriptor.value` errors. Always start from `apps/api` (see Dockerfile `WORKDIR`).
2. **SSE blocks graceful shutdown** unless streams end: heartbeats (`interval`) never complete. `EventBus.closing` + `takeUntil` fixes it.
3. **pg-boss queue policy is fixed at creation**; de-dupe by `singletonKey` only works with the `short` policy, not the default.
4. OpenTelemetry **auto-instrumentation relies on module-loader hooks that Bun does not honour**; we use manual spans (HTTP middleware, jobs) plus `@prisma/instrumentation`, which works. Do not add `@opentelemetry/auto-instrumentations-node`.
5. **Prisma interactive transactions drop the caller's async context**, orphaning DB spans. `withTenant()` re-enters the captured context and `await`s inside it (Prisma promises are lazy).
6. OTel JS has a 2.x/3.x split: `sdk-trace` 3.x + `resources`/`context-async-hooks` 3.x + OTLP exporter 0.30x need API >=1.10; mixing in `sdk-trace-base` 2.x breaks. `@prisma/instrumentation` major must match `@prisma/client` (6.x).
7. MinIO's image was not pullable in the build sandbox; SeaweedFS is the dev/CI S3. Behaviour differences from AWS S3 are possible: staging re-check above.
8. `bunx --cwd <dir> prisma …` is not valid (bunx tried to fetch a package named after the dir) — run from the package directory.

## Exit criteria to turn GO into final GO
- Repeat the object-storage round trip against real S3 (ap-south-1) in staging.
- Verify the OTLP collector path (ADOT → X-Ray/CloudWatch in ap-south-1) in staging.
- A short soak test in staging (health + 50 rps for 30 min, no memory growth).
If any fails and cannot be fixed safely, switch the runtime to Node 22 LTS; domain code avoids `Bun.*` APIs so this is mechanical.

## Rules while GO
- No `Bun.*` runtime APIs in `apps/api`, `apps/worker` domain code or packages (tests may use `bun:test`).
- CI runs the API image build so a runtime switch stays one Dockerfile change.
