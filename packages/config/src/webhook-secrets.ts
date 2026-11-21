/**
 * Signing secrets for inbound (public) webhooks — payment gateways and message-delivery providers — resolved
 * from the environment, never from `Tenant.settings` (ADR 0004 §5, §9.2).
 *
 * Convention (most specific first; a value may hold several comma-separated secrets for rotation, any of which
 * may verify a signature):
 *
 *   WEBHOOK_SECRET_<GATEWAY>_<TENANT>   e.g. WEBHOOK_SECRET_STUB_099961FB_F443_4C6F_BD93_3680DDB4C4A6
 *   WEBHOOK_SECRET_<GATEWAY>            shared by every tenant of that gateway (single-merchant / local dev)
 *
 * <GATEWAY> is upper-cased with every non-alphanumeric run turned into `_`; <TENANT> is the tenant UUID
 * upper-cased with `-` as `_`. Production deployments swap this lookup for a secret-manager call behind the same
 * signature. An empty result means "no secret configured": the route must answer 401 (never accept unsigned).
 */
const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export function webhookSecretEnvNames(gateway: string, tenantId: string): string[] {
  const g = norm(gateway);
  return [`WEBHOOK_SECRET_${g}_${norm(tenantId)}`, `WEBHOOK_SECRET_${g}`];
}

export function webhookSecrets(
  gateway: string,
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  for (const name of webhookSecretEnvNames(gateway, tenantId)) {
    const raw = env[name];
    if (raw?.trim()) {
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}
