variable "name" { type = string }
variable "db_subnet_ids" { type = list(string) }
variable "db_sg_id" { type = string }
variable "kms" {
  type        = map(string)
  description = "Key ARNs from the kms module (data, s3, secrets)."
}
variable "alerts_topic_arn" { type = string }
variable "db_instance_class" { type = string }
variable "db_multi_az" { type = bool }
variable "db_allocated_gb" {
  type    = number
  default = 50
}
variable "db_max_allocated_gb" {
  type    = number
  default = 500
}
variable "db_backup_retention_days" {
  type        = number
  default     = 14
  description = "Daily automated backups (PRD 7.6). Note: >0 also enables point-in-time restore inside this window."
}
variable "deletion_protection" { type = bool }
variable "app_origins" {
  type        = list(string)
  default     = []
  description = "Browser origins allowed to POST uploads straight to S3 (presigned POST)."
}
variable "audit_retention_days" {
  type    = number
  default = 365 # placeholder until counsel defines the clinical/financial audit retention (PRD 12.4)
}
variable "audit_lock_mode" {
  type    = string
  default = "GOVERNANCE"
  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.audit_lock_mode)
    error_message = "GOVERNANCE or COMPLIANCE."
  }
}

data "aws_caller_identity" "me" {}

# ---------------------------------------------------------------- PostgreSQL
resource "random_password" "master" {
  length  = 40
  special = false # alphanumeric: safe to embed in connection URLs
}

resource "random_password" "app" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.db_subnet_ids
}

resource "aws_db_parameter_group" "pg16" {
  name_prefix = "${var.name}-pg16-"
  family      = "postgres16"
  lifecycle { create_before_destroy = true }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name_prefix        = "${var.name}-rds-mon-"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  db_name  = "dentalos"
  username = "dentalos_owner" # owns the schema; used by migrations only. The app uses dentalos_app (RLS applies).
  password = random_password.master.result

  allocated_storage     = var.db_allocated_gb
  max_allocated_storage = var.db_max_allocated_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms["data"]

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.db_sg_id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.pg16.name

  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "20:00-21:00" # 01:30-02:30 IST
  maintenance_window        = "sun:21:30-sun:22:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${var.name}-final" : null

  auto_minor_version_upgrade          = true
  performance_insights_enabled        = true
  performance_insights_kms_key_id     = var.kms["data"]
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  iam_database_authentication_enabled = true
}

resource "aws_db_event_subscription" "failures" {
  name_prefix = "${var.name}-"
  sns_topic   = var.alerts_topic_arn
  source_type = "db-instance"
  source_ids  = [aws_db_instance.this.identifier]
  # "backup" covers backup start/finish/failure: a failed daily backup must page someone (PRD 7.6, 10.4).
  event_categories = ["backup", "failure", "failover", "maintenance", "recovery", "low storage"]
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${var.name}-db-free-storage-low"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 10 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [var.alerts_topic_arn]
  ok_actions          = [var.alerts_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-db-cpu-high"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [var.alerts_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name          = "${var.name}-db-connections-high"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 150
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [var.alerts_topic_arn]
}

# ------------------------------------------------------------------ Secrets
resource "aws_secretsmanager_secret" "app_database_url" {
  name_prefix = "${var.name}/app-database-url-"
  description = "DATABASE_URL for the RLS-bound dentalos_app role (API + worker)"
  kms_key_id  = var.kms["secrets"]
}

resource "aws_secretsmanager_secret_version" "app_database_url" {
  secret_id     = aws_secretsmanager_secret.app_database_url.id
  secret_string = "postgresql://dentalos_app:${random_password.app.result}@${aws_db_instance.this.address}:5432/dentalos?sslmode=require&connection_limit=10"
}

resource "aws_secretsmanager_secret" "admin_database_url" {
  name_prefix = "${var.name}/admin-database-url-"
  description = "Owner connection for migrations only. Never mounted into API/worker services."
  kms_key_id  = var.kms["secrets"]
}

resource "aws_secretsmanager_secret_version" "admin_database_url" {
  secret_id     = aws_secretsmanager_secret.admin_database_url.id
  secret_string = "postgresql://dentalos_owner:${random_password.master.result}@${aws_db_instance.this.address}:5432/dentalos?sslmode=require"
}

resource "aws_secretsmanager_secret" "app_db_password" {
  name_prefix = "${var.name}/app-db-password-"
  description = "Value applied to the dentalos_app role by the migrate task"
  kms_key_id  = var.kms["secrets"]
}

resource "aws_secretsmanager_secret_version" "app_db_password" {
  secret_id     = aws_secretsmanager_secret.app_db_password.id
  secret_string = random_password.app.result
}

# --------------------------------------------------------------- S3 buckets
locals {
  buckets = {
    docs  = "patient documents, X-rays, scans, generated receipts (private; presigned access only)"
    audit = "write-once archive of the audit hash chain (object lock)"
  }
}

resource "aws_s3_bucket" "this" {
  for_each            = local.buckets
  bucket              = "${var.name}-${each.key}-${data.aws_caller_identity.me.account_id}"
  object_lock_enabled = each.key == "audit"
  force_destroy       = false
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms["s3"]
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.this["audit"].id
  rule {
    default_retention {
      mode = var.audit_lock_mode
      days = var.audit_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  bucket = aws_s3_bucket.this["docs"].id
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

resource "aws_s3_bucket_cors_configuration" "docs" {
  count  = length(var.app_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.this["docs"].id
  cors_rule {
    allowed_methods = ["POST", "GET"]
    allowed_origins = var.app_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 600
  }
}

data "aws_iam_policy_document" "bucket" {
  for_each = aws_s3_bucket.this

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value.arn, "${each.value.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyUnencryptedUploads"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${each.value.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  policy   = data.aws_iam_policy_document.bucket[each.key].json
}

output "db_address" { value = aws_db_instance.this.address }
output "db_identifier" { value = aws_db_instance.this.identifier }
output "docs_bucket" { value = aws_s3_bucket.this["docs"].bucket }
output "docs_bucket_arn" { value = aws_s3_bucket.this["docs"].arn }
output "audit_bucket_arn" { value = aws_s3_bucket.this["audit"].arn }
output "audit_bucket" { value = aws_s3_bucket.this["audit"].bucket }
output "secret_arns" {
  value = {
    app_database_url   = aws_secretsmanager_secret.app_database_url.arn
    admin_database_url = aws_secretsmanager_secret.admin_database_url.arn
    app_db_password    = aws_secretsmanager_secret.app_db_password.arn
  }
}
