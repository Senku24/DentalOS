data "aws_caller_identity" "me" {}

locals {
  repos = toset(["api", "worker", "staff-web", "patient-portal"])
  https = var.certificate_arn != ""
  otel  = <<-YAML
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
    processors:
      batch: {}
    exporters:
      awsxray: {}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [awsxray]
  YAML
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "DEPLOY_ENV", value = var.env },
    { name = "AWS_REGION", value = var.region },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
  ]
}

# ------------------------------------------------------------------- ECR
resource "aws_ecr_repository" "this" {
  for_each             = local.repos
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE" # a deployed tag can never be silently replaced
  force_delete         = false
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms["secrets"]
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

# ------------------------------------------------------------------- Logs
resource "aws_cloudwatch_log_group" "svc" {
  for_each          = toset(["api", "worker", "migrate", "otel"])
  name              = "/dentalos/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms["logs"]
}

# -------------------------------------------------------------------- IAM
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.me.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.secret_arns)
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.kms["secrets"]]
  }
  statement {
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms["logs"]]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "api" {
  name_prefix        = "${var.name}-api-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role" "worker" {
  name_prefix        = "${var.name}-worker-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# The migrate task gets no AWS permissions at all: it only talks to Postgres.
resource "aws_iam_role" "migrate" {
  name_prefix        = "${var.name}-migrate-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid       = "DocumentObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${var.docs_bucket_arn}/t/*"] # tenant-prefixed keys only
  }
  statement {
    sid       = "DocumentList"
    actions   = ["s3:ListBucket"]
    resources = [var.docs_bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["t/*"]
    }
  }
  statement {
    sid       = "DocumentKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms["s3"]]
  }
  statement {
    sid = "StaffDirectory"
    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminUserGlobalSignOut",
      "cognito-idp:AdminResetUserPassword",
      "cognito-idp:AdminSetUserMFAPreference",
    ]
    resources = [var.cognito_staff.pool_arn]
  }
  statement {
    sid       = "Traces"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "api" {
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "DocumentObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${var.docs_bucket_arn}/t/*"]
  }
  statement {
    sid       = "AuditArchiveWriteOnly"
    actions   = ["s3:PutObject"]
    resources = ["${var.audit_bucket_arn}/*"] # no read, no delete
  }
  statement {
    sid       = "Keys"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms["s3"]]
  }
  statement {
    sid       = "Traces"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "worker" {
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

# --------------------------------------------------------------- Cluster
resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  configuration {
    execute_command_configuration {
      kms_key_id = var.kms["logs"]
      logging    = "OVERRIDE"
      log_configuration {
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.svc["api"].name
        cloud_watch_encryption_enabled = true
      }
    }
  }
}

locals {
  log = { for k, v in aws_cloudwatch_log_group.svc : k => {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = v.name
      "awslogs-region"        = var.region
      "awslogs-stream-prefix" = k
    }
  } }
  otel_sidecar = {
    name             = "otel"
    image            = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.0"
    essential        = false
    command          = ["--config=env:AOT_CONFIG_CONTENT"]
    environment      = [{ name = "AOT_CONFIG_CONTENT", value = local.otel }]
    logConfiguration = local.log["otel"]
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([
    {
      name         = "api"
      image        = "${aws_ecr_repository.this["api"].repository_url}:${var.image_tag}"
      essential    = true
      portMappings = [{ containerPort = 3001, protocol = "tcp" }]
      environment = concat(local.common_env, [
        { name = "SERVICE_NAME", value = "dentalos-api" },
        { name = "PORT", value = "3001" },
        { name = "COGNITO_USER_POOL_ID", value = var.cognito_staff.pool_id },
        { name = "COGNITO_CLIENT_ID", value = var.cognito_staff.client_id },
        { name = "COGNITO_MFA_ENFORCED", value = "true" },
        { name = "S3_BUCKET", value = var.docs_bucket },
      ])
      secrets          = [{ name = "DATABASE_URL", valueFrom = var.secret_arns.app_database_url }]
      logConfiguration = local.log["api"]
      stopTimeout      = 30
      dependsOn        = [{ containerName = "otel", condition = "START" }]
    },
    local.otel_sidecar,
  ])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${aws_ecr_repository.this["worker"].repository_url}:${var.image_tag}"
      essential = true
      environment = concat(local.common_env, [
        { name = "SERVICE_NAME", value = "dentalos-worker" },
        { name = "S3_BUCKET", value = var.docs_bucket },
      ])
      secrets          = [{ name = "DATABASE_URL", valueFrom = var.secret_arns.app_database_url }]
      logConfiguration = local.log["worker"]
      stopTimeout      = 30
      dependsOn        = [{ containerName = "otel", condition = "START" }]
    },
    local.otel_sidecar,
  ])
}

# One-shot task run by CI before each deploy: migrate as the owner, then rotate dentalos_app's password.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migrate.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${aws_ecr_repository.this["api"].repository_url}:${var.image_tag}"
    essential = true
    command   = ["sh", "-c", "cd /app/packages/db && bunx prisma migrate deploy && bun scripts/set-app-role-password.ts"]
    secrets = [
      { name = "DATABASE_URL", valueFrom = var.secret_arns.admin_database_url },
      { name = "ADMIN_DATABASE_URL", valueFrom = var.secret_arns.admin_database_url },
      { name = "APP_DB_PASSWORD", valueFrom = var.secret_arns.app_db_password },
    ]
    logConfiguration = local.log["migrate"]
  }])
}

# --------------------------------------------------------------------- ALB
#trivy:ignore:AWS-0053 internet-facing by design: the staff app, patient portal and API are public web services (WAF + TLS + auth in front)
resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [var.alb_sg_id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.alb_deletion_protection
  idle_timeout               = 120 # SSE streams send a heartbeat every 15 s
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name}-api"
  vpc_id               = var.vpc_id
  port                 = 3001
  protocol             = "HTTP"
  target_type          = "ip"
  deregistration_delay = 30
  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }
}

#trivy:ignore:AWS-0054 port 80 only redirects to HTTPS; the plain-HTTP fallback exists for non-production without a certificate and is blocked for production by the stack guardrail
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  dynamic "default_action" {
    for_each = local.https ? [1] : []
    content {
      type = "redirect"
      redirect {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
  dynamic "default_action" {
    for_each = local.https ? [] : [1]
    content {
      type = "fixed-response"
      fixed_response {
        content_type = "text/plain"
        message_body = "not found"
        status_code  = "404"
      }
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = local.https ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    host_header { values = [var.api_host] }
  }
}

# --------------------------------------------------------------------- WAF
resource "aws_wafv2_web_acl" "this" {
  count = var.enable_waf ? 1 : 0
  name  = var.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000 # requests per 5 minutes per IP
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = {
      common    = { priority = 10, name = "AWSManagedRulesCommonRuleSet" }
      badinputs = { priority = 20, name = "AWSManagedRulesKnownBadInputsRuleSet" }
    }
    content {
      name     = rule.value.name
      priority = rule.value.priority
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.value.name
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  count        = var.enable_waf ? 1 : 0
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this[0].arn
}

# ---------------------------------------------------------------- Services
resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  enable_execute_command             = var.enable_exec
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  propagate_tags                     = "SERVICE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.app_sg_id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true # a failing deploy rolls itself back
  }
  depends_on = [aws_lb_listener_rule.api]

  # CI owns the running revision and autoscaling owns the count after the first apply.
  lifecycle { ignore_changes = [task_definition, desired_count] }
}

resource "aws_ecs_service" "worker" {
  name                   = "worker"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = var.worker_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_exec
  propagate_tags         = "SERVICE"

  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [var.app_sg_id]
    assign_public_ip = false
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  lifecycle { ignore_changes = [task_definition, desired_count] }
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = max(var.api_desired_count, 1)
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

# ------------------------------------------------------------------ Alarms
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.this.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
  ok_actions          = [var.alerts_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  alarm_name          = "${var.name}-api-unhealthy-hosts"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.this.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "api_p95" {
  alarm_name          = "${var.name}-api-latency-p95"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.this.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1.5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alerts_topic_arn]
}

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "alb_zone_id" { value = aws_lb.this.zone_id }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "ecr_urls" { value = { for k, v in aws_ecr_repository.this : k => v.repository_url } }
output "ecr_arns" { value = [for v in aws_ecr_repository.this : v.arn] }
output "role_arns" {
  value = [
    aws_iam_role.execution.arn,
    aws_iam_role.api.arn,
    aws_iam_role.worker.arn,
    aws_iam_role.migrate.arn,
  ]
}
output "task_families" {
  value = {
    api     = aws_ecs_task_definition.api.family
    worker  = aws_ecs_task_definition.worker.family
    migrate = aws_ecs_task_definition.migrate.family
  }
}
output "app_subnet_ids" { value = var.app_subnet_ids }
output "app_sg_id" { value = var.app_sg_id }
