"use client";
import {
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
  createContext,
  useContext,
} from "react";

export type LinkComponent = ComponentType<
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
>;
const DefaultLink: LinkComponent = (p) => <a {...p} />;
const Ctx = createContext<LinkComponent>(DefaultLink);

/** Apps inject their router link (e.g. next/link) so this package stays router-agnostic. */
export function LinkProvider({
  component,
  children,
}: { component: LinkComponent; children: ReactNode }) {
  return <Ctx.Provider value={component}>{children}</Ctx.Provider>;
}
export const useLink = () => useContext(Ctx);
