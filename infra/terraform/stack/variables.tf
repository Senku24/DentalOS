variable "env" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}

variable "region" {
  type    = string
  default = "ap-south-1" # Mumbai only: patient data, backups and logs stay in India (PRD 7.1)
  validation {
    condition     = contains(["ap-south-1", "ap-south-2"], var.region)
    error_message = "Only Indian AWS regions (ap-south-1 Mumbai, ap-south-2 Hyderabad) are permitted."
  }
}

variable "azs" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "github_repo" {
  type        = string
  description = "owner/repo that may deploy to this environment (GitHub OIDC)."
}

variable "create_github_oidc_provider" {
  type    = bool
  default = true
}

variable "api_host" { type = string }
variable "certificate_arn" {
  type    = string
  default = ""
}

variable "staff_callback_urls" { type = list(string) }
variable "staff_logout_urls" { type = list(string) }
variable "patient_callback_urls" { type = list(string) }
variable "patient_logout_urls" { type = list(string) }
variable "app_origins" {
  type    = list(string)
  default = []
}

variable "alert_emails" {
  type    = list(string)
  default = []
}

variable "enable_patient_sms_otp" {
  type    = bool
  default = false
}

# Sizing / protection knobs that differ per environment.
variable "db_instance_class" { type = string }
variable "db_multi_az" { type = bool }
variable "db_backup_retention_days" {
  type    = number
  default = 14
}
variable "nat_per_az" { type = bool }
variable "deletion_protection" { type = bool }
variable "enable_waf" { type = bool }
variable "api_desired_count" { type = number }
variable "api_max_count" { type = number }
variable "worker_desired_count" { type = number }
variable "audit_lock_mode" {
  type    = string
  default = "GOVERNANCE"
}
variable "audit_retention_days" {
  type    = number
  default = 365
}
variable "log_retention_days" {
  type    = number
  default = 180
}
