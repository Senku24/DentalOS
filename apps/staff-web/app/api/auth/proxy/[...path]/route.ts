import { handleProxy } from "../../../../../lib/auth/handlers";
import { devDisabled, withAuth } from "../../../../../lib/auth/route";

/** Same-origin API proxy (Cognito mode). Dev mode keeps calling the API directly. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const proxy = (req: Request) => withAuth(req, handleProxy, devDisabled);
export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
