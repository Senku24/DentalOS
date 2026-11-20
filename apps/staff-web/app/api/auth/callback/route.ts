import { handleCallback } from "../../../../lib/auth/handlers";
import { devDisabled, withAuth } from "../../../../lib/auth/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return withAuth(req, handleCallback, devDisabled);
}
