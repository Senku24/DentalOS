"use client";
import type { Principal } from "@dentalos/contracts";
import { Spinner } from "@dentalos/ui";
import { usePathname } from "next/navigation";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import { setSessionPrincipal } from "../session";
import { AUTH_ROUTES, loginUrl } from "./client";
import type { SessionResponse } from "./handlers";

/**
 * Client session context. Loads `/api/auth/session` once, installs the principal for `canDo`, and in
 * Cognito mode holds back the app until the principal is known (no flash of DEV-principal UI).
 * Auth pages (sign-in, organisation picker, invite acceptance) always render.
 */

export type ClientSession =
  | { status: "loading" }
  | { status: "error" }
  | ({ status: "ready" } & SessionResponse);

interface Ctx {
  session: ClientSession;
  principal: Principal | null;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Ctx>({
  session: { status: "loading" },
  principal: null,
  refresh: async () => {},
});

export const AUTH_PAGES = ["/sign-in", "/select-organisation", "/invite/accept"];
const isAuthPage = (p: string | null) =>
  !!p && AUTH_PAGES.some((a) => p === a || p.startsWith(`${a}/`));

export function SessionProvider({
  children,
  initial,
}: { children: ReactNode; initial?: SessionResponse }) {
  const path = usePathname();
  const [session, setSession] = useState<ClientSession>(
    initial ? { status: "ready", ...initial } : { status: "loading" },
  );

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(AUTH_ROUTES.session, { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setSession({ status: "ready", ...((await r.json()) as SessionResponse) });
    } catch {
      setSession({ status: "error" });
    }
  }, []);

  useEffect(() => {
    if (!initial) void refresh();
  }, [initial, refresh]);

  const principal =
    session.status === "ready" && session.authenticated ? (session.principal ?? null) : null;
  useEffect(() => setSessionPrincipal(principal), [principal]);

  useEffect(() => {
    if (session.status !== "ready" || session.mode !== "cognito" || isAuthPage(path)) return;
    const here = `${window.location.pathname}${window.location.search}`;
    if (!session.authenticated) window.location.assign(loginUrl(here));
    else if (session.needsTenant)
      window.location.assign(`/select-organisation?returnTo=${encodeURIComponent(here)}`);
  }, [session, path]);

  // Install synchronously too, so the first gated render already sees the real principal.
  if (principal) setSessionPrincipal(principal);
  const gated =
    !isAuthPage(path) && (session.status !== "ready" || (session.mode === "cognito" && !principal));

  return (
    <SessionContext.Provider value={{ session, principal, refresh }}>
      {gated ? (
        <div style={{ display: "grid", placeItems: "center", minHeight: "40vh" }}>
          {session.status === "error" ? (
            <p role="alert">Couldn't load your session. Reload the page to try again.</p>
          ) : (
            <Spinner label="Loading your session" />
          )}
        </div>
      ) : (
        children
      )}
    </SessionContext.Provider>
  );
}

export const useSession = () => useContext(SessionContext);
