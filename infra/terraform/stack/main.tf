locals {
  name = "dentalos-${var.env}"
}

module "kms" {
  source = "../modules/kms"
  name   = local.name
  region = var.region
}

module "alerts" {
  source      = "../modules/alerts"
  name        = local.name
  kms_key_arn = module.kms.arns["alerts"]
  emails      = var.alert_emails
}

module "network" {
  source             = "../modules/network"
  name               = local.name
  cidr               = var.vpc_cidr
  azs                = var.azs
  nat_per_az         = var.nat_per_az
  log_retention_days = var.log_retention_days
  logs_kms_key_arn   = module.kms.arns["logs"]
}

module "data" {
  source                   = "../modules/data"
  name                     = local.name
  db_subnet_ids            = module.network.db_subnet_ids
  db_sg_id                 = module.network.db_sg_id
  kms                      = module.kms.arns
  alerts_topic_arn         = module.alerts.topic_arn
  db_instance_class        = var.db_instance_class
  db_multi_az              = var.db_multi_az
  db_backup_retention_days = var.db_backup_retention_days
  deletion_protection      = var.deletion_protection
  app_origins              = var.app_origins
  audit_lock_mode          = var.audit_lock_mode
  audit_retention_days     = var.audit_retention_days
}

module "identity" {
  source                 = "../modules/identity"
  name                   = local.name
  region                 = var.region
  staff_callback_urls    = var.staff_callback_urls
  staff_logout_urls      = var.staff_logout_urls
  patient_callback_urls  = var.patient_callback_urls
  patient_logout_urls    = var.patient_logout_urls
  deletion_protection    = var.deletion_protection
  enable_patient_sms_otp = var.enable_patient_sms_otp
  log_retention_days     = var.log_retention_days
  logs_kms_key_arn       = module.kms.arns["logs"]
}

module "app" {
  source                  = "../modules/app"
  name                    = local.name
  env                     = var.env
  region                  = var.region
  vpc_id                  = module.network.vpc_id
  public_subnet_ids       = module.network.public_subnet_ids
  app_subnet_ids          = module.network.app_subnet_ids
  alb_sg_id               = module.network.alb_sg_id
  app_sg_id               = module.network.app_sg_id
  kms                     = module.kms.arns
  alerts_topic_arn        = module.alerts.topic_arn
  log_retention_days      = var.log_retention_days
  certificate_arn         = var.certificate_arn
  api_host                = var.api_host
  alb_deletion_protection = var.deletion_protection
  enable_waf              = var.enable_waf
  api_desired_count       = var.api_desired_count
  api_max_count           = var.api_max_count
  worker_desired_count    = var.worker_desired_count
  cognito_staff           = module.identity.staff
  docs_bucket             = module.data.docs_bucket
  docs_bucket_arn         = module.data.docs_bucket_arn
  audit_bucket_arn        = module.data.audit_bucket_arn
  secret_arns             = module.data.secret_arns
}

module "cicd" {
  source               = "../modules/cicd"
  name                 = local.name
  env                  = var.env
  github_repo          = var.github_repo
  create_oidc_provider = var.create_github_oidc_provider
  ecr_arns             = module.app.ecr_arns
  passrole_arns        = module.app.role_arns
  cluster_name         = module.app.cluster_name
}

# Production must never serve patient data over plain HTTP, run without WAF, or be deletable by accident.
check "production_guardrails" {
  assert {
    condition     = var.env != "production" || (var.certificate_arn != "" && var.enable_waf && var.deletion_protection && var.db_multi_az)
    error_message = "production requires: certificate_arn, enable_waf, deletion_protection and db_multi_az."
  }
}
