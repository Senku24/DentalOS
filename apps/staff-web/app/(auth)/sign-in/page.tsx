import { Alert } from "@dentalos/ui";
import { AuthCard } from "../../../lib/auth/auth-card";
import { loginUrl } from "../../../lib/auth/client";
import { authConfig } from "../../../lib/auth/config";
import { SIGN_IN_MESSAGES } from "../../../lib/auth/messages";
import { safeReturnTo } from "../../../lib/auth/return-to";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SignInPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const error = first(sp.error);
  const signedOut = first(sp.signed_out) === "1";
  const returnTo = safeReturnTo(first(sp.returnTo));
  let mode: "dev" | "cognito" | "misconfigured" = "dev";
  try {
    mode = authConfig() ? "cognito" : "dev";
  } catch {
    mode = "misconfigured";
  }
  const message = error ? (SIGN_IN_MESSAGES[error] ?? SIGN_IN_MESSAGES.idp_error) : undefined;

  return (
    <AuthCard title="Sign in to DentalOS">
      {signedOut ? <Alert tone="success">You have been signed out.</Alert> : null}
      {message ? <Alert tone="danger">{message}</Alert> : null}
      {mode === "cognito" ? (
        <>
          <p style={{ margin: 0 }}>
            Staff sign in with their DentalOS account and authenticator app (MFA is required).
          </p>
          <a className="dos-btn" data-variant="primary" data-size="md" href={loginUrl(returnTo)}>
            Continue to sign in
          </a>
        </>
      ) : mode === "dev" ? (
        <>
          <Alert tone="info">
            Sign-in is not configured in this environment, so the app uses the development
            principal. Set the Cognito variables (see apps/staff-web/README.md) to enable it.
          </Alert>
          <a className="dos-btn" data-variant="secondary" data-size="md" href={returnTo}>
            Continue
          </a>
        </>
      ) : (
        <Alert tone="danger">
          Sign-in is misconfigured on this server. Ask an administrator to check the auth settings.
        </Alert>
      )}
    </AuthCard>
  );
}
