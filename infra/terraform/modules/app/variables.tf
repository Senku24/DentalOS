variable "name" { type = string }
variable "env" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "app_subnet_ids" { type = list(string) }
variable "alb_sg_id" { type = string }
variable "app_sg_id" { type = string }
variable "kms" { type = map(string) }
variable "alerts_topic_arn" { type = string }
variable "log_retention_days" { type = number }

variable "certificate_arn" {
  type        = string
  default     = ""
  description = "ACM certificate for the HTTPS listener. Empty = plain-HTTP listener (non-production only; the stack refuses this for production)."
}
variable "api_host" {
  type        = string
  description = "Host header routed to the API, e.g. api.staging.example.in"
}
variable "alb_deletion_protection" { type = bool }
variable "enable_waf" { type = bool }
variable "enable_exec" {
  type        = bool
  default     = false
  description = "ECS Exec into running tasks. Off by default: it is a break-glass path (PRD 7.4)."
}

variable "image_tag" {
  type        = string
  default     = "bootstrap"
  description = "Initial tag only. CI registers new task-definition revisions on every deploy."
}
variable "api_desired_count" { type = number }
variable "api_max_count" { type = number }
variable "api_cpu" {
  type    = number
  default = 512
}
variable "api_memory" {
  type    = number
  default = 1024
}
variable "worker_desired_count" { type = number }
variable "worker_cpu" {
  type    = number
  default = 256
}
variable "worker_memory" {
  type    = number
  default = 512
}

variable "cognito_staff" {
  type = object({ pool_id = string, pool_arn = string, client_id = string })
}
variable "docs_bucket" { type = string }
variable "docs_bucket_arn" { type = string }
variable "audit_bucket_arn" { type = string }
variable "secret_arns" {
  type = object({ app_database_url = string, admin_database_url = string, app_db_password = string })
}
