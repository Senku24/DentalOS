/** Copy for sign-in errors (codes come from the callback handler; IdP text is never reflected). */
export const SIGN_IN_MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  idp_error: "The sign-in service reported a problem. Try again.",
  login_expired: "The sign-in attempt took too long or was opened in another browser. Try again.",
  state_mismatch: "The sign-in response did not match this browser. Try again.",
  invalid_request: "The sign-in response was incomplete. Try again.",
  token_exchange_failed: "We couldn't complete sign-in. Try again.",
  invalid_id_token: "The sign-in response could not be verified. Try again.",
  reauth_failed: "Please enter your password again to confirm it's you.",
  idp_unreachable: "The sign-in service is unreachable. Check your connection and try again.",
  session_expired: "Your session has ended. Sign in again.",
};

export const TENANT_MESSAGES: Record<string, string> = {
  not_a_member: "You are not a member of that organisation (or your access was removed).",
  validation_failed: "Enter a valid organisation ID.",
  csrf_failed: "Your session changed in another tab. Reload the page and try again.",
  session_expired: "Your session has ended. Sign in again.",
  api_unavailable: "The DentalOS server is unreachable. Try again shortly.",
  unknown: "Something went wrong. Try again.",
};
