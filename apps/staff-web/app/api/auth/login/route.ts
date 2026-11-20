import { handleLogin } from "../../../../lib/auth/handlers";
import { safeReturnTo } from "../../../../lib/auth/return-to";
import { withAuth } from "../../../../lib/auth/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  // Dev mode: nothing to sign in to — go straight to the destination (DEV principal applies).
  return withAuth(req, handleLogin, (r) => {
    const here = new URL(r.url);
    const target = new URL(safeReturnTo(here.searchParams.get("returnTo")), here);
    // Defence in depth: the redirect must stay on this origin.
    return Response.redirect(target.origin === here.origin ? target : new URL("/", here), 302);
  });
}
