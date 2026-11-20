import { devSession, handleSessionGet, handleSessionPost } from "../../../../lib/auth/handlers";
import { devDisabled, withAuth } from "../../../../lib/auth/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return withAuth(req, handleSessionGet, () =>
    Response.json(devSession(), { headers: { "Cache-Control": "no-store" } }),
  );
}

export function POST(req: Request) {
  return withAuth(req, handleSessionPost, devDisabled);
}
