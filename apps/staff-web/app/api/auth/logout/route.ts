import { handleLogout } from "../../../../lib/auth/handlers";
import { withAuth } from "../../../../lib/auth/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: Request) {
  return withAuth(req, handleLogout, () => Response.json({ redirect: "/" }));
}
