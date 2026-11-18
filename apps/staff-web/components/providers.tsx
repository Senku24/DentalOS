"use client";
import { LinkProvider, ToastProvider } from "@dentalos/ui";
import Link from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";

function NextLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <Link {...props} />;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <LinkProvider component={NextLink}>
      <ToastProvider>{children}</ToastProvider>
    </LinkProvider>
  );
}
