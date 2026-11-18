# ADR 0002 — Identity (Cognito) and AWS infrastructure baseline

Status: **Proposed** (2026-11-19). Nothing has been applied to AWS; code is validated, not deployed.

## Decisions
1. **Cognito, two pools in ap-south-1.** Staff: invite-only, TOTP MFA required (`mfa_configuration = ON`, no SMS factor),
   admin-only recovery. Patients: passwordless email OTP (SMS OTP optional once DLT is registered), clinic-created accounts.
2. **MFA evidence = pool configuration.** Cognito access tokens carry no dependable MFA claim, so `CognitoTokenVerifier`
   marks `mfa: true` only when the pool is MFA-enforced (`COGNITO_MFA_ENFORCED`, default true; Terraform exposes `staff_mfa`).
3. **Access tokens only**, verified against the pool JWKS: RS256 pinned, issuer, expiry, `token_use=access`, `client_id`.
   Any failure, including JWKS unreachable, is a 401. The shared-secret dev verifier is refused when `NODE_ENV=production`.
4. **Step-up = re-authentication.** `@StepUp(seconds)` compares `auth_time` with now and answers
   `401 {error: "reauth_required"}`; the client sends the user through sign-in again (Cognito cannot step up in-session).
   Permission is checked first so users who could never act are not asked to re-authenticate.
5. **Compute: ECS Fargate on ARM64**, behind an ALB + WAF; trace data via an ADOT sidecar to X-Ray (in-region).
6. **Database roles**: schema owner for migrations only; application role is RLS-bound; its password is rotated from
   Secrets Manager by the migrate task on every deploy (migration 0002's dev password is never live in a deployed DB).
7. **Deploys are manual-dispatch** via GitHub OIDC into a role bound to one GitHub Environment. Migrations run first as a
   one-shot task; ECS circuit breaker rolls back failing revisions.

## Consequences / open items
- Patient identity (`PatientAccount`, tenant picker for phones spanning tenants) and the patient guard land with M1/M4.
- Staff-web needs the OAuth code-flow BFF (callback route, session cookie, refresh) — next UI/identity work.
- Terraform state holds generated secrets (see infra README); consider moving DB credentials to RDS-managed secrets with
  rotation when we add a rotation Lambda or adopt IAM database auth.
- Provider choices for payments/messaging/AI are unaffected; their egress will be allow-listed later.
