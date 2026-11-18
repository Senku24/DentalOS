# DentalOS infrastructure (Terraform)

AWS **ap-south-1 (Mumbai)** only: a validation rule rejects any non-Indian region (PRD 7.1).
One AWS account per environment (staging, production); same code, different `envs/*.tfvars` and backend.

| Path | What |
|---|---|
| `bootstrap/` | One-time per account: encrypted, versioned state bucket + lock table (local state) |
| `stack/` | The environment: wires the modules below |
| `modules/kms` | One CMK per data class (data, s3, logs, secrets, alerts), rotation on |
| `modules/network` | VPC, 3 subnet tiers (db tier has **no** internet route), S3 endpoint, flow logs (180 d), SGs |
| `modules/data` | RDS PostgreSQL 16 (encrypted, forced TLS, daily backups, event + alarms), Secrets Manager, S3 `docs` + object-locked `audit` buckets |
| `modules/identity` | Cognito: **staff** pool (invite-only, TOTP MFA required, no SMS MFA) and **patient** pool (passwordless OTP) |
| `modules/app` | ECR (immutable tags), ECS Fargate api + worker (+ ADOT trace sidecar), one-shot migrate task, ALB, WAF, autoscaling, alarms |
| `modules/cicd` | GitHub OIDC deploy role, limited to one repo **Environment** |

## Bring-up (needs a human with AWS access; nothing here has been applied)
1. `terraform -chdir=infra/terraform/bootstrap init && terraform -chdir=infra/terraform/bootstrap apply -var env=staging`,
   copy its `backend_config` output into `envs/staging.backend.hcl` (see the `.example`).
2. Edit `envs/staging.tfvars` (`github_repo`, hosts, callback URLs; leave `certificate_arn` empty only for synthetic-data staging).
3. `terraform -chdir=infra/terraform/stack init -backend-config=../envs/staging.backend.hcl`
   then `plan -var-file=../envs/staging.tfvars` and `apply` after reviewing the plan.
4. Create a GitHub Environment `staging` with secret `AWS_DEPLOY_ROLE_ARN` (= output `deploy_role_arn`) and variables
   `ECS_CLUSTER`, `APP_SUBNETS`, `APP_SG`, `API_URL` (from the outputs).
5. Run the **Deploy** workflow. Services start at the desired counts but have no image until the first deploy pushes
   one; ECS keeps retrying and the workflow's rollout step then succeeds.
6. Point `api_host` at `alb_dns_name`; confirm alert-email subscriptions; run a restore drill.

## Things to know
- **Secrets live in Terraform state** (generated DB passwords, Cognito client secrets). The state bucket is KMS-encrypted,
  versioned and TLS-only; restrict who can read it like production credentials.
- The DB owner (`dentalos_owner`) is used only by the migrate task. The app connects as `dentalos_app`, subject to RLS;
  migration `0002` creates it with a dev password and the migrate task **rotates it** from Secrets Manager on every deploy.
- `ignore_changes` on `task_definition` and `desired_count`: CI owns the running revision, autoscaling owns the count.
- Automated RDS backups (14 d prod) also give point-in-time restore inside that window. The PRD's "daily backup, manual
  recovery" baseline is therefore a subset; RPO/RTO are still undecided (PRD 7.6) and a **restore drill is still required**.
- Production guardrails (`check` block): HTTPS certificate, WAF, deletion protection and Multi-AZ must be set.
- Not yet covered: staff-web / patient-portal services and Dockerfiles, ALB access logs, Route 53/ACM, VPC interface endpoints,
  cross-region (ap-south-2) backup copy, audit-chain export job to the `audit` bucket, SMS origination (DLT) for patient OTP.

## Local checks (no AWS access needed)
`terraform fmt -recursive -check`, and per directory `terraform init -backend=false && terraform validate`
(CI does both, plus a Trivy config scan failing on HIGH/CRITICAL).
