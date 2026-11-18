output "alb_dns_name" {
  value       = module.app.alb_dns_name
  description = "Point api_host (CNAME/ALIAS) here."
}
output "deploy_role_arn" {
  value       = module.cicd.deploy_role_arn
  description = "Set as the AWS_DEPLOY_ROLE_ARN secret of the matching GitHub Environment."
}
output "cluster_name" { value = module.app.cluster_name }
output "ecr_urls" { value = module.app.ecr_urls }
output "task_families" { value = module.app.task_families }
output "app_subnet_ids" { value = module.app.app_subnet_ids }
output "app_sg_id" { value = module.app.app_sg_id }
output "cognito" {
  value = {
    staff_pool_id     = module.identity.staff.pool_id
    staff_client_id   = module.identity.staff.client_id
    staff_issuer      = module.identity.staff.issuer
    staff_mfa         = module.identity.staff.mfa
    patient_pool_id   = module.identity.patient.pool_id
    patient_client_id = module.identity.patient.client_id
  }
}
output "cognito_client_secrets" {
  value     = module.identity.client_secrets
  sensitive = true
}
output "docs_bucket" { value = module.data.docs_bucket }
output "audit_bucket" { value = module.data.audit_bucket }
output "db_identifier" { value = module.data.db_identifier }
output "alerts_topic_arn" { value = module.alerts.topic_arn }
