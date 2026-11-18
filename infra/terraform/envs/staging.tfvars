env         = "staging"
github_repo = "CHANGE-ME/dentalos" # owner/repo

api_host = "api.staging.CHANGE-ME.example"
# certificate_arn = "arn:aws:acm:ap-south-1:...:certificate/..."  # empty = HTTP only (staging, synthetic data only)

staff_callback_urls   = ["https://app.staging.CHANGE-ME.example/auth/callback", "http://localhost:3000/auth/callback"]
staff_logout_urls     = ["https://app.staging.CHANGE-ME.example/", "http://localhost:3000/"]
patient_callback_urls = ["https://portal.staging.CHANGE-ME.example/auth/callback", "http://localhost:3002/auth/callback"]
patient_logout_urls   = ["https://portal.staging.CHANGE-ME.example/", "http://localhost:3002/"]
app_origins           = ["https://app.staging.CHANGE-ME.example", "https://portal.staging.CHANGE-ME.example"]

alert_emails = []

db_instance_class        = "db.t4g.medium"
db_multi_az              = false
db_backup_retention_days = 7
nat_per_az               = false
deletion_protection      = false
enable_waf               = true
api_desired_count        = 1
api_max_count            = 2
worker_desired_count     = 1
audit_lock_mode          = "GOVERNANCE"
audit_retention_days     = 30
