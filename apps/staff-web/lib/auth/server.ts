import { cookies } from "next/headers";
import { authConfig } from "./config";
import { type Session, readSessionFrom } from "./session-store";

/**
 * Server Components / Server Actions: the current BFF session (`null` when signed out or in dev mode).
 * Read-only: refreshing tokens needs a route handler (cookies cannot be written while rendering).
 */
export async function getServerSession(): Promise<Session | null> {
  const cfg = authConfig();
  if (!cfg) return null;
  const jar = await cookies();
  return readSessionFrom(new Map(jar.getAll().map((c) => [c.name, c.value] as const)), cfg);
}

/** "dev" without Cognito configuration, else "cognito". */
export const authMode = (): "dev" | "cognito" => (authConfig() ? "cognito" : "dev");
