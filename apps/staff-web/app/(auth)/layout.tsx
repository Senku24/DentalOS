import type { ReactNode } from "react";
import { SessionProvider } from "../../lib/auth/session-provider";

/** Auth pages load the session themselves (they work before the app-wide provider is wired in). */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
