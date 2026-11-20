"use client";
import { Alert, Button, TextField } from "@dentalos/ui";
import { type FormEvent, useState } from "react";
import { AuthCard } from "../../../lib/auth/auth-card";
import { selectTenant, signOut } from "../../../lib/auth/client";
import { TENANT_MESSAGES } from "../../../lib/auth/messages";
import { safeReturnTo, sameOriginHref } from "../../../lib/auth/return-to";
import { useSession } from "../../../lib/auth/session-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shown after sign-in when no organisation is known (first sign-in on this browser without an invite
 * link) or the remembered one no longer has the user. Until the API lists a user's memberships
 * across tenants, the organisation ID comes from the invitation link or an administrator.
 */
export function SelectOrganisation({ returnTo }: { returnTo: string }) {
  const { session } = useSession();
  const [tenantId, setTenantId] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const notMember =
    session.status === "ready" && session.authenticated && session.mode === "cognito"
      ? session.error === "not_a_member"
      : false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const id = tenantId.trim();
    if (!UUID.test(id)) {
      setError(TENANT_MESSAGES.validation_failed);
      return;
    }
    setBusy(true);
    setError(undefined);
    const r = await selectTenant(id);
    setBusy(false);
    // Re-check at the sink (defence in depth): never navigate off our origin.
    if (r.ok) window.location.assign(sameOriginHref(returnTo, window.location.origin));
    else setError(TENANT_MESSAGES[r.error ?? "unknown"] ?? TENANT_MESSAGES.unknown);
  }

  if (session.status === "ready" && session.mode === "dev") {
    return (
      <AuthCard title="Choose organisation">
        <Alert tone="info">Development mode uses a fixed organisation. Nothing to choose.</Alert>
        <a
          className="dos-btn"
          data-variant="secondary"
          data-size="md"
          href={safeReturnTo(returnTo)}
        >
          Continue
        </a>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose organisation">
      {notMember ? <Alert tone="warning">{TENANT_MESSAGES.not_a_member}</Alert> : null}
      <p style={{ margin: 0 }}>
        Enter the organisation ID from your invitation link or ask your administrator for it.
      </p>
      <form onSubmit={submit} noValidate style={{ display: "grid", gap: 12 }}>
        <TextField
          label="Organisation ID"
          name="tenantId"
          autoComplete="off"
          spellCheck={false}
          required
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          error={error}
          hint="Looks like 3f2b7c1e-…"
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="submit" loading={busy}>
            Continue
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
