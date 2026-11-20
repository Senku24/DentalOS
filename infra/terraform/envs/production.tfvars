env         = "production"
github_repo = "CHANGE-ME/dentalos"

api_host        = "api.CHANGE-ME.example"
certificate_arn = "" # REQUIRED for production (guardrail check fails without it)

staff_callback_urls   = ["https://app.CHANGE-ME.example/api/auth/callback"]
staff_logout_urls     = ["https://app.CHANGE-ME.example/sign-in?signed_out=1"]
patient_callback_urls = ["https://portal.CHANGE-ME.example/auth/callback"]
patient_logout_urls   = ["https://portal.CHANGE-ME.example/"]
app_origins           = ["https://app.CHANGE-ME.example", "https://portal.CHANGE-ME.example"]

alert_emails = []

# Starting point only: size from the M5 load test and the pilot's agreed capacity assumptions.
db_instance_class        = "db.m7g.large"
db_multi_az              = true
db_backup_retention_days = 14
nat_per_az               = true
deletion_protection      = true
enable_waf               = true
api_desired_count        = 2
api_max_count            = 6
worker_desired_count     = 2
# COMPLIANCE lock is irreversible for the retention period: switch only after counsel sets the audit retention (PRD 12.4).
audit_lock_mode      = "GOVERNANCE"
audit_retention_days = 365
