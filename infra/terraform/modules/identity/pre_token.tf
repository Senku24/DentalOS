# ------------------------------------------------- Staff pre-token-generation (V2) trigger
#
# Cognito ACCESS tokens carry no `email` claim by default. The API authenticates with the access token
# (CognitoTokenVerifier, ADR 0002) and binds invitations to the IdP-verified e-mail, so this trigger
# copies `email` + `email_verified` (and `name`, for Membership.displayName) from the user's attributes
# into the access token. V2 access-token customisation needs the ESSENTIALS (or PLUS) pool tier.
# The handler only reads attributes Cognito already holds; it never calls out and never fails sign-in.

variable "log_retention_days" {
  type    = number
  default = 365
}

variable "logs_kms_key_arn" {
  type        = string
  default     = null
  description = "CMK for the trigger's CloudWatch log group (the stack passes the `logs` key)."
}

locals {
  pre_token_handler = <<-JS
    // Cognito pre token generation V2 (event version 2/3). Attribute values arrive as strings.
    export const handler = async (event) => {
      const a = (event.request && event.request.userAttributes) || {};
      const claims = {};
      const email = typeof a.email === "string" ? a.email.trim() : "";
      if (email) {
        claims.email = email;
        claims.email_verified = a.email_verified === "true";
      }
      const name = typeof a.name === "string" ? a.name.trim() : "";
      if (name) claims.name = name.slice(0, 120);
      event.response = event.response || {};
      event.response.claimsAndScopeOverrideDetails = {
        ...(event.response.claimsAndScopeOverrideDetails || {}),
        accessTokenGeneration: { claimsToAddOrOverride: claims },
      };
      return event;
    };
  JS
}

data "archive_file" "pre_token" {
  type = "zip"
  # Under the (git-ignored) .terraform directory of the root being planned.
  output_path = "${path.root}/.terraform/build/staff-pre-token-generation.zip"
  source {
    content  = local.pre_token_handler
    filename = "index.mjs"
  }
}

data "aws_iam_policy_document" "pre_token_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pre_token" {
  name               = "${var.name}-staff-pre-token"
  assume_role_policy = data.aws_iam_policy_document.pre_token_assume.json
}

resource "aws_cloudwatch_log_group" "pre_token" {
  name              = "/aws/lambda/${var.name}-staff-pre-token"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn
}

# Least privilege: write to its own log group only (no AWSLambdaBasicExecutionRole wildcard).
data "aws_iam_policy_document" "pre_token_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.pre_token.arn}:*"]
  }
}

resource "aws_iam_role_policy" "pre_token_logs" {
  name   = "logs"
  role   = aws_iam_role.pre_token.id
  policy = data.aws_iam_policy_document.pre_token_logs.json
}

resource "aws_lambda_function" "pre_token" {
  function_name    = "${var.name}-staff-pre-token"
  description      = "Adds email, email_verified and name to staff access tokens (Cognito V2 trigger)"
  role             = aws_iam_role.pre_token.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.pre_token.output_path
  source_code_hash = data.archive_file.pre_token.output_base64sha256
  memory_size      = 128
  timeout          = 3 # Cognito waits at most 5 s for a trigger

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.pre_token.name
  }

  depends_on = [aws_iam_role_policy.pre_token_logs]
}

resource "aws_lambda_permission" "pre_token" {
  statement_id  = "AllowCognitoStaffPool"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_token.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.staff.arn
}
