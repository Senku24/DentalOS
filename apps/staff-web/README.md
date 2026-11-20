# staff-web

Next.js (App Router) staff application. `bun run dev` serves it on http://localhost:3000.

## Modes

| Mode | When | Who you are | Data |
|---|---|---|---|
| **Dev** | `COGNITO_DOMAIN` is **unset** (and, in a production build, `DENTALOS_AUTH_MODE=dev`) | The DEV principal from `lib/session.ts` (role via `NEXT_PUBLIC_DEV_ROLE`) | Mock fixtures unless `NEXT_PUBLIC_API_URL` is set (`NEXT_PUBLIC_API_MOCK=1/0` forces either way) |
| **Cognito** | `COGNITO_DOMAIN` is set | The signed-in staff user; principal from the API's `GET /me` | Real API through the same-origin BFF proxy |

If `COGNITO_DOMAIN` is set but another required variable is missing or invalid, auth routes answer
`500 auth_misconfigured` and the sign-in page says so. It never falls back to the DEV principal.

Dev mode is impossible to reach by accident in production: when `NODE_ENV=production` (every
`next build` / `next start`) and `COGNITO_DOMAIN` is unset, the configuration is treated as
misconfigured — API routes answer `500 auth_misconfigured` and pages redirect to `/sign-in`, which
shows the misconfiguration notice. To smoke-test a production build locally without Cognito, set
`DENTALOS_AUTH_MODE=dev` explicitly. Never set it in a deployed environment; it is rejected when
`COGNITO_DOMAIN` is also set.

## Sign-in (Cognito mode)

OAuth 2.0 authorization code + PKCE (S256) against the staff user pool's managed login. A
backend-for-frontend (BFF) in Next route handlers keeps every token on the server:

| Route | What it does |
|---|---|
| `GET /api/auth/login?returnTo=&tenantId=&reauth=1` | Creates `state`, `nonce` and a PKCE verifier, seals them into a 10-minute HttpOnly transaction cookie, then redirects to `/oauth2/authorize`. `reauth=1` adds `prompt=login&max_age=0` for step-up. |
| `GET /api/auth/callback` | Checks `state` (constant-time) and exchanges the code with the verifier. Validates the ID token's `iss`, `aud`, `exp`, `nonce` and `token_use`, and checks that a step-up produced a fresh `auth_time`. Then starts a **new** session (new session id) and redirects to `returnTo`, or to `/select-organisation` when no organisation is known. |
| `POST /api/auth/logout` | CSRF-checked. Revokes the refresh token, clears the cookies, then sends the browser to Cognito `/logout`. |
| `GET /api/auth/session` | Refreshes the access token if it is close to expiry, then calls `GET /me` with `Authorization: Bearer` + `X-Tenant-Id`. Returns `{ principal, user, needsTenant, csrfToken, … }`. Tokens are never returned. |
| `POST /api/auth/session {tenantId}` | CSRF-checked organisation switch. Membership is verified through `GET /me` first. |
| `/api/auth/proxy/<api path>` | Same-origin API proxy. Adds the bearer token and `X-Tenant-Id`, refreshes tokens, CSRF-checks `POST/PUT/PATCH/DELETE` and streams the response (SSE works). |

- **Session storage:** AES-256-GCM sealed JSON (access token, refresh token, expiry, `sub`, selected
  tenant) in `__Host-dos_session.N` cookies. These are chunked because Cognito tokens are large, and
  are `HttpOnly; Secure; SameSite=Lax; Path=/`. The session has an absolute lifetime
  (`SESSION_MAX_AGE`), whatever refreshes happen. Keys are derived from `SESSION_SECRET` with HKDF.
  The transaction cookie uses a different AEAD purpose, so it can never be replayed as a session.
- **CSRF:** every state-changing BFF call needs both of these:
  - an `Origin` equal to `APP_URL` (or, when `Origin` is absent, `Sec-Fetch-Site: same-origin`);
  - `X-CSRF-Token` equal to HMAC(session id). The token sits in the JS-readable
    `__Host-dos_csrf` cookie and in the `/api/auth/session` response. Use `csrfHeaders()` from
    `lib/auth/client.ts`.
- **Open redirects:** `returnTo` must be a same-origin relative path (`lib/auth/return-to.ts`).
  `//host`, `/\host`, absolute URLs, control characters, `/api/*` and `/_next/*` all become `/`.
- **Middleware** (`middleware.ts`): in Cognito mode, every page without a valid session is
  redirected to `/api/auth/login?returnTo=…`, and API routes get `401`. `/sign-in` and
  `/api/auth/*` are public. In dev mode the middleware lets every request through.
- **Step-up:** when the API answers `401 { error: "reauth_required" }` (`@StepUp`, ADR 0002), call
  `reauthenticate()` from `lib/auth/client.ts`. The user signs in again interactively and comes back
  to the page to retry the action. If the new token's `auth_time` is not fresh, sign-in is refused
  with `reauth_failed`.
- **E-mail claim:** Cognito access tokens carry `email` / `email_verified` only because of the
  pre-token-generation V2 trigger in `infra/terraform/modules/identity/pre_token.tf`. Invitation
  acceptance needs that claim.

## Environment variables

Server-only unless the name starts with `NEXT_PUBLIC_`. Never put secrets in `NEXT_PUBLIC_*`.

| Variable | Required | Example / default | Notes |
|---|---|---|---|
| `COGNITO_DOMAIN` | turns Cognito mode on | `https://dentalos-staging-staff.auth.ap-south-1.amazoncognito.com` | Managed-login domain (Terraform `aws_cognito_user_pool_domain.staff`). A bare host gets `https://`. |
| `DENTALOS_AUTH_MODE` | production builds without Cognito only | `dev` | Explicit opt-in to dev mode when `NODE_ENV=production` (local `next build && next start` smoke tests). Unset in every deployment; rejected together with `COGNITO_DOMAIN`. |
| `COGNITO_CLIENT_ID` | yes | Terraform output `staff.client_id` | |
| `COGNITO_CLIENT_SECRET` | yes for the Terraform client | output `client_secrets.staff` (sensitive) | The client has `generate_secret = true`; sent as HTTP Basic to `/oauth2/token`. |
| `COGNITO_ISSUER` | yes, or the pair below | output `staff.issuer` | `https://cognito-idp.<region>.amazonaws.com/<poolId>` |
| `COGNITO_USER_POOL_ID` + `COGNITO_REGION` | instead of `COGNITO_ISSUER` | `ap-south-1_AbCdE`, `ap-south-1` | `AWS_REGION` is accepted for the region. |
| `COGNITO_SCOPES` | no | `openid email profile` | |
| `COGNITO_LOGOUT_URI` | no | `${APP_URL}/sign-in?signed_out=1` | Must be listed in the client's `logout_urls`. |
| `APP_URL` | yes | `https://staff.example.in` | Public origin. The redirect URI is `${APP_URL}/api/auth/callback`, which must be in the client's `callback_urls`. Use https everywhere except `http://localhost:3000`, where `__Host-`/`Secure` cookies are turned off. |
| `API_URL` | yes | `http://api.internal:4000` | API base the BFF calls server-side. Falls back to `NEXT_PUBLIC_API_URL`. |
| `SESSION_SECRET` | yes, ≥ 32 chars | `openssl rand -base64 48` | Seals the session and signs CSRF tokens. Rotating it signs everyone out. |
| `SESSION_MAX_AGE` | no | `43200` (12 h) | Absolute session lifetime in seconds (minimum 300). Matches the staff refresh-token validity. |
| `DEFAULT_TENANT_ID` | no | UUID | Organisation used when the user picked none and none is remembered. Otherwise the user is sent to `/select-organisation`. |
| `NEXT_PUBLIC_API_URL` | no | dev: `http://localhost:4000`; Cognito: `/api/auth/proxy` | Base URL of the browser API client. In Cognito mode, point it at the BFF proxy so the browser never needs a token. |
| `NEXT_PUBLIC_API_MOCK` | no | `1` / `0` | Forces mock fixtures on or off (dev). |
| `NEXT_PUBLIC_DEV_ROLE` | no | `OWNER`, `RECEPTIONIST`, … | Dev-mode principal role. Default `MANAGER`. |
| `NEXT_PUBLIC_DEV_TOKEN` | no | dev JWT | Dev mode only. Passed through as a bearer token when calling a local API directly. |

### Local Cognito testing

The staging client already lists `http://localhost:3000/api/auth/callback` and
`http://localhost:3000/sign-in?signed_out=1` (`infra/terraform/envs/staging.tfvars`). Set the
variables above with `APP_URL=http://localhost:3000`.

## Tests

`bun test` covers the BFF (`lib/auth/auth.test.ts`): state, nonce and PKCE, sealed cookies, CSRF,
the `returnTo` allow-list, refresh, the proxy and the middleware guard.
