# Local setup and run

Requirements: Bun 1.3.13, Docker (for Postgres and S3-compatible storage), openssl.

## 1. Configure `.env`
- Location: **repo root**, the same folder as `package.json`. Name must be exactly `.env`.
- Create it from the template:
  ```bash
  cp .env.example .env
  ```
- Set `DEV_JWT_SECRET` (`openssl rand -hex 32`). Everything else has working local defaults.
- `bun run db:seed` fills the `NEXT_PUBLIC_DEV_*` lines of `.env` for you (set `DEV_JWT_SECRET` first).

## 2. Commands, in order
```bash
bun install                 # install all workspace packages
bun run db:up              # start Postgres (port 5433) and S3 storage (port 8333) in Docker
bun run db:migrate         # apply database migrations (superuser; uses ADMIN_DATABASE_URL)
bun run db:generate        # generate the Prisma client
bun run db:seed            # demo data + writes the dev login (tenant, branch, token) into .env
```

## 3. Run (three terminals)
```bash
bun run dev:api            # API on http://localhost:3001  (health: /health/live)
bun run dev:web            # Staff web on http://localhost:3000
bun run dev:worker         # optional: background job worker
```
Open http://localhost:3000 — signed in as the seeded dentist (`NEXT_PUBLIC_DEV_ROLE=DENTIST`).
`NEXT_PUBLIC_DEV_ROLE` only changes what the UI shows. What the API allows is decided by the seeded user's real role (DENTIST).

## 4. Other commands
```bash
bun run lint               # Biome lint + format check
bun run typecheck          # TypeScript for all packages
bun run build              # production build (staff-web, patient-portal)
bun run openapi            # regenerate apps/api/openapi.json
bun run db:down            # stop Docker services (data is kept)
bun run format             # auto-format the repo
```
Production-style run of staff-web: `bun run --cwd apps/staff-web start` (after `bun run build`).

## 5. Background jobs (pg-boss)
The API enqueues jobs (receipts, reminders, ...) and the worker runs them. pg-boss keeps its queues in a `pgboss` schema that the
app role (`dentalos_app`) cannot create. `bun run dev:worker` therefore connects as the schema owner (`PGBOSS_DATABASE_URL`, falling back
to `ADMIN_DATABASE_URL`, which is already in your `.env`), installs / migrates `pgboss`, creates its queues and **grants `dentalos_app`
access to `pgboss.*`** (idempotent, repeated at every start; set `PGBOSS_APP_ROLE` if your app role has another name). The API's
`JobQueueService` then enqueues as `dentalos_app`.
- Start the worker at least once before the API enqueues (it creates the queues): `permission denied for schema pgboss` or
  `Queue ... not found` from the API means the worker has not run yet against this database.
- The worker only starts pg-boss once a handler is registered (`apps/worker/src/handlers/index.ts`).
- Webhook signing secrets (payment gateway, delivery receipts) come from `WEBHOOK_SECRET_<GATEWAY>[_<TENANT>]` in `.env`
  (see `.env.example`); without one the webhook routes answer 401.

## Troubleshooting
- "Application error: a client-side exception" / ChunkLoadError → a stale server holds the port or `.next` is out of date: `kill $(lsof -ti :3000)`, `rm -rf apps/staff-web/.next`, then `bun run dev:web`.
- Never run `bun run build` while `dev:web` is running (they share `apps/staff-web/.next`).
- `DEV_JWT_SECRET` missing → the API refuses to start; set it in `.env`.
- `ADMIN_DATABASE_URL is not set` → `.env` is missing or not at the repo root.
- Port 5433 busy → another Postgres is running; stop it or change the port in `infra/docker-compose.yml` and `.env`.
- Staff web shows fixture data → `NEXT_PUBLIC_API_URL` is empty in `.env`; restart `dev:web` after editing `.env`.
- 401/403 in the browser → token expired (`DEV_TOKEN_TTL`); re-run `bun run db:seed` and update `NEXT_PUBLIC_DEV_TOKEN`, then restart `dev:web`.
