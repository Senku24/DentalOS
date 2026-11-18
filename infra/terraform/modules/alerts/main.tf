variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "emails" {
  type        = list(string)
  default     = []
  description = "On-call addresses. Each must confirm the SNS subscription email."
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = var.kms_key_arn
}

data "aws_iam_policy_document" "publish" {
  statement {
    sid       = "AllowAwsServicesToPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "cloudwatch.amazonaws.com", "rds.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.publish.json
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

output "topic_arn" { value = aws_sns_topic.alerts.arn }
