# Permission matrix

> Generated from `packages/contracts/src/permissions.ts` — do not edit by hand.
> Regenerate: `bun run --cwd packages/contracts docs:permissions`.

Scopes: **tenant** any holder · **branch** resource branch must be in scope (or orgWide) ·
**org** requires orgWide · **self** own records unless orgWide.
A user may hold several roles (union of permissions). `PATIENT` has no staff permissions;
the patient portal uses a separate self-scoped surface.

| Permission | Scope | OWNER | MANAGER | DENTIST | RECEPTIONIST | ACCOUNTANT |
|---|---|:-:|:-:|:-:|:-:|:-:|
| `org:read` | tenant | ✔ | ✔ | ✔ | ✔ | ✔ |
| `org:manage` | org | ✔ |  |  |  |  |
| `branch:read` | branch | ✔ | ✔ | ✔ | ✔ | ✔ |
| `branch:manage` | org | ✔ |  |  |  |  |
| `staff:read` | branch | ✔ | ✔ |  |  |  |
| `staff:manage` | org | ✔ |  |  |  |  |
| `catalog:read` | tenant | ✔ | ✔ | ✔ | ✔ | ✔ |
| `catalog:manage` | org | ✔ |  |  |  |  |
| `price:override` | branch | ✔ | ✔ |  |  |  |
| `patient:read` | tenant | ✔ | ✔ | ✔ | ✔ | ✔ |
| `patient:write` | tenant | ✔ | ✔ | ✔ | ✔ |  |
| `patient:merge` | tenant | ✔ | ✔ |  |  |  |
| `patient:export` | org | ✔ |  |  |  |  |
| `document:read` | branch | ✔ | ✔ | ✔ | ✔ |  |
| `document:write` | branch | ✔ | ✔ | ✔ | ✔ |  |
| `consent:manage` | branch | ✔ | ✔ | ✔ | ✔ |  |
| `appointment:read` | branch | ✔ | ✔ | ✔ | ✔ |  |
| `appointment:write` | branch | ✔ | ✔ |  | ✔ |  |
| `appointment:checkin` | branch | ✔ | ✔ |  | ✔ |  |
| `schedule:manage` | branch | ✔ | ✔ |  |  |  |
| `clinical:read` | branch | ✔ | ✔ | ✔ |  |  |
| `clinical:write` | branch |  |  | ✔ |  |  |
| `clinical:sign` | branch |  |  | ✔ |  |  |
| `clinical:amend` | branch |  |  | ✔ |  |  |
| `plan:read` | branch | ✔ | ✔ | ✔ |  |  |
| `plan:write` | branch |  |  | ✔ |  |  |
| `plan:approve` | branch |  |  | ✔ |  |  |
| `billing:read` | branch | ✔ | ✔ |  | ✔ | ✔ |
| `invoice:write` | branch | ✔ | ✔ |  | ✔ | ✔ |
| `payment:record` | branch | ✔ | ✔ |  | ✔ | ✔ |
| `discount:apply` | branch | ✔ | ✔ |  |  | ✔ |
| `refund:issue` | branch | ✔ |  |  |  | ✔ |
| `finance:report` | branch | ✔ | ✔ |  |  | ✔ |
| `compensation:read` | self | ✔ |  | ✔ |  | ✔ |
| `compensation:manage` | org | ✔ |  |  |  | ✔ |
| `inventory:read` | branch | ✔ | ✔ | ✔ | ✔ |  |
| `inventory:write` | branch | ✔ | ✔ | ✔ |  |  |
| `inventory:transfer` | branch | ✔ | ✔ |  |  |  |
| `comms:send` | branch | ✔ | ✔ |  | ✔ |  |
| `comms:templates` | org | ✔ |  |  |  |  |
| `analytics:branch` | branch | ✔ | ✔ |  |  | ✔ |
| `analytics:org` | org | ✔ |  |  |  | ✔ |
| `ai:use` | branch | ✔ | ✔ | ✔ |  |  |
| `ai:admin` | org | ✔ |  |  |  |  |
| `audit:read` | org | ✔ |  |  |  |  |
| `breakglass:use` | org |  |  |  |  |  |
