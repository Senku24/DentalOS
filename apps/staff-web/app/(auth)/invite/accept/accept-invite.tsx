"use client";
import { Alert, Button, Spinner } from "@dentalos/ui";
import { useState } from "react";
import { mapHttpError } from "../../../../lib/api/errors";
import { AuthCard } from "../../../../lib/auth/auth-card";
import { AUTH_ROUTES, csrfHeaders, selectTenant, signOut } from "../../../../lib/auth/client";
import { useSession } from "../../../../lib/auth/session-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The signed-in user (middleware already sent them through Cognito) accepts the invitation through
 * the BFF proxy; the API binds it to the IdP-verified e-mail on the access token. On success the
 * new organisation becomes the active one.
 */
export function AcceptInvite({ tenantId, token }: { tenantId: string; token: string }) {
  const { session } = useSession();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string>();
  const valid = UUID.test(tenantId) && token.length >= 32;

  async function accept() {
    setState("busy");
    setError(undefined);
    try {
      const r = await fetch(`${AUTH_ROUTES.proxy}/invitations/accept`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...csrfHeaders("POST"),
        },
        body: JSON.stringify({ tenantId, token }),
      });
      if (!r.ok && r.status !== 409) {
        setError(mapHttpError(r.status, await r.json().catch(() => null)).message);
        setState("idle");
        return;
      }
      // 409 already_member: still switch to the organisation.
      const sel = await selectTenant(tenantId);
      if (!sel.ok) throw new Error(sel.error);
      setState("done");
      window.location.assign("/");
    } catch {
      setError("We couldn't finish joining the organisation. Try again.");
      setState("idle");
    }
  }

  if (!valid) {
    return (
      <AuthCard title="Accept invitation">
        <Alert tone="danger">This invitation link is incomplete. Open the full link again.</Alert>
      </AuthCard>
    );
  }
  if (session.status === "loading") {
    return (
      <AuthCard title="Accept invitation">
        <Spinner label="Checking your session" />
      </AuthCard>
    );
  }
  if (session.status === "ready" && session.mode === "dev") {
    return (
      <AuthCard title="Accept invitation">
        <Alert tone="info">
          Sign-in is not configured in this environment (development principal), so invitations
          cannot be accepted here.
        </Alert>
      </AuthCard>
    );
  }
  const who = session.status === "ready" && session.authenticated ? session.user.email : undefined;
  return (
    <AuthCard title="Accept invitation">
      <p style={{ margin: 0 }}>
        You have been invited to join an organisation on DentalOS
        {who ? (
          <>
            {" "}
            as <strong>{who}</strong>
          </>
        ) : null}
        . The invitation only works for the e-mail address it was sent to.
      </p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button onClick={() => void accept()} loading={state !== "idle"}>
          Join organisation
        </Button>
        <Button variant="ghost" onClick={() => void signOut()}>
          Use a different account
        </Button>
      </div>
    </AuthCard>
  );
}
