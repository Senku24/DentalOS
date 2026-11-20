import { type NextRequest, NextResponse } from "next/server";
import { type AuthConfig, authConfig } from "./lib/auth/config";
import { guardMisconfigured, guardRequest } from "./lib/auth/guard";

/**
 * Protects every app route when Cognito sign-in is configured (see lib/auth/guard.ts). Without
 * COGNITO_DOMAIN (local dev, mock mode) it is a pass-through and the DEV principal applies. An invalid
 * configuration (including a production build without COGNITO_DOMAIN) fails closed.
 */
export async function middleware(req: NextRequest) {
  let cfg: AuthConfig | null;
  try {
    cfg = authConfig();
  } catch (e) {
    console.error("[auth]", (e as Error).message);
    const m = guardMisconfigured(req.nextUrl);
    if (m.type === "redirect") return NextResponse.redirect(m.location);
    if (m.type === "next") return NextResponse.next();
    return NextResponse.json(
      { error: "auth_misconfigured" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  const cookies = new Map(req.cookies.getAll().map((c) => [c.name, c.value] as const));
  const d = await guardRequest(req.nextUrl, cookies, cfg);
  if (d.type === "redirect") return NextResponse.redirect(d.location);
  if (d.type === "unauthorized")
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|map)$).*)",
  ],
};
