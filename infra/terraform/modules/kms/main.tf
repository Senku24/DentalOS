variable "name" { type = string }
variable "region" { type = string }

data "aws_caller_identity" "me" {}

locals {
  # One key per data class so access can be granted (and audited) separately.
  keys = {
    data    = "RDS storage, backups, performance insights"
    s3      = "document and audit-archive buckets"
    logs    = "CloudWatch log groups"
    secrets = "Secrets Manager and ECR"
    alerts  = "SNS alert topic"
  }
}

data "aws_iam_policy_document" "key" {
  for_each = local.keys

  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.me.account_id}:root"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid       = "AllowCloudWatchLogs"
      actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["logs.${var.region}.amazonaws.com"]
      }
      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.me.account_id}:log-group:*"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "alerts" ? [1] : []
    content {
      sid       = "AllowEventsAndAlarms"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["events.amazonaws.com", "cloudwatch.amazonaws.com", "rds.amazonaws.com"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  for_each                = local.keys
  description             = "${var.name} ${each.key}: ${each.value}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key[each.key].json
}

resource "aws_kms_alias" "this" {
  for_each      = local.keys
  name          = "alias/${var.name}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}

output "arns" { value = { for k, v in aws_kms_key.this : k => v.arn } }
