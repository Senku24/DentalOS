variable "name" { type = string }
variable "region" { type = string }
variable "staff_callback_urls" {
  type        = list(string)
  description = "OAuth redirect URLs for the staff app (https only, except http://localhost:3000 in staging)."
}
variable "staff_logout_urls" { type = list(string) }
variable "patient_callback_urls" { type = list(string) }
variable "patient_logout_urls" { type = list(string) }
variable "deletion_protection" { type = bool }
variable "enable_patient_sms_otp" {
  type        = bool
  default     = false
  description = "SMS OTP needs SNS SMS origination plus DLT entity/template registration in India. Email OTP is always on."
}

# ------------------------------------------------------------------- Staff
resource "aws_cognito_user_pool" "staff" {
  name                     = "${var.name}-staff"
  deletion_protection      = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "ON" # PRD 7.3: mandatory MFA for every staff user
  user_pool_tier           = "ESSENTIALS"

  software_token_mfa_configuration { enabled = true } # TOTP only: no SMS second factor (SIM-swap risk)

  password_policy {
    minimum_length                   = 14
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
    password_history_size            = 5
  }

  # Invite-only: staff are created by an administrator through DentalOS (Membership is the authority).
  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "You have been invited to DentalOS"
      email_message = "Your username is {username} and your temporary password is {####}. It expires in 3 days."
      sms_message   = "Your DentalOS username is {username}, temporary password {####}."
    }
  }

  # No self-service recovery: a lost MFA device or password is reset by an administrator after verification.
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }

  user_attribute_update_settings { attributes_require_verification_before_update = ["email"] }
}

resource "aws_cognito_user_pool_client" "staff" {
  name         = "${var.name}-staff-web"
  user_pool_id = aws_cognito_user_pool.staff.id

  generate_secret                      = true # held by the Next.js server (BFF), never the browser
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.staff_callback_urls
  logout_urls                          = var.staff_logout_urls

  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 12
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}

resource "aws_cognito_user_pool_domain" "staff" {
  domain       = "${var.name}-staff"
  user_pool_id = aws_cognito_user_pool.staff.id
}

# ----------------------------------------------------------------- Patients
resource "aws_cognito_user_pool" "patient" {
  name                = "${var.name}-patient"
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  username_attributes = var.enable_patient_sms_otp ? ["email", "phone_number"] : ["email"]
  mfa_configuration   = "OFF" # the OTP *is* the factor; no passwords exist for patients
  user_pool_tier      = "ESSENTIALS"

  # Passwordless: choice-based sign-in with one-time codes only.
  sign_in_policy {
    allowed_first_auth_factors = var.enable_patient_sms_otp ? ["EMAIL_OTP", "SMS_OTP"] : ["EMAIL_OTP"]
  }

  # Patients are registered by the clinic (or via verified enquiry), not by open self-signup.
  admin_create_user_config { allow_admin_create_user_only = true }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "patient" {
  name         = "${var.name}-patient-portal"
  user_pool_id = aws_cognito_user_pool.patient.id

  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.patient_callback_urls
  logout_urls                          = var.patient_logout_urls

  explicit_auth_flows           = ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 30
  id_token_validity      = 30
  refresh_token_validity = 7
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_domain" "patient" {
  domain       = "${var.name}-patient"
  user_pool_id = aws_cognito_user_pool.patient.id
}

output "staff" {
  value = {
    pool_id   = aws_cognito_user_pool.staff.id
    pool_arn  = aws_cognito_user_pool.staff.arn
    client_id = aws_cognito_user_pool_client.staff.id
    issuer    = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.staff.id}"
    mfa       = aws_cognito_user_pool.staff.mfa_configuration
  }
}

output "patient" {
  value = {
    pool_id   = aws_cognito_user_pool.patient.id
    pool_arn  = aws_cognito_user_pool.patient.arn
    client_id = aws_cognito_user_pool_client.patient.id
    issuer    = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.patient.id}"
  }
}

output "client_secrets" {
  sensitive = true
  value = {
    staff   = aws_cognito_user_pool_client.staff.client_secret
    patient = aws_cognito_user_pool_client.patient.client_secret
  }
}
