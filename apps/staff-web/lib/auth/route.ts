import { type AuthConfig, authConfig } from "./config";
import { type Deps, defaultDeps } from "./handlers";

/**
 * Adapter for the Next route files: resolves config (500 on misconfiguration, never a silent dev
 * fallback) and hands dev mode to `dev`.
 */
export async function withAuth(
  req: Request,
  cognito: (req: Request, cfg: AuthConfig, deps: Deps) => Promise<Response>,
  dev: (req: Request) => Response | Promise<Response>,
): Promise<Response> {
  let cfg: AuthConfig | null;
  try {
    cfg = authConfig();
  } catch (e) {
    console.error("[auth]", (e as Error).message);
    return Response.json({ error: "auth_misconfigured" }, { status: 500 });
  }
  return cfg ? cognito(req, cfg, defaultDeps()) : dev(req);
}

export const devDisabled = () =>
  Response.json(
    { error: "auth_disabled", message: "Cognito sign-in is not configured (dev mode)." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
