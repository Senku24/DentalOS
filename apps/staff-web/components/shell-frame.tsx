"use client";
import { type Principal, can } from "@dentalos/contracts";
import { ALL_BRANCHES, AppShell, type CommandItem } from "@dentalos/ui";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { NAV } from "../lib/nav";
import { DEV_BRANCHES, DEV_PRINCIPAL, DEV_USER } from "../lib/session";

const principal: Principal = DEV_PRINCIPAL;

export function ShellFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [branchId, setBranchId] = useState(
    principal.orgWide ? ALL_BRANCHES : (principal.branchScope[0] ?? ""),
  );

  const nav = useMemo(
    () =>
      NAV.filter(
        (n) => !n.permission || can(principal, n.permission, { ownerUserId: principal.userId }),
      ),
    [],
  );
  const branches = useMemo(
    () =>
      principal.orgWide
        ? DEV_BRANCHES
        : DEV_BRANCHES.filter((b) => principal.branchScope.includes(b.id)),
    [],
  );
  const commands: CommandItem[] = useMemo(
    () =>
      nav.map((n) => ({ id: n.href, label: `Go to ${n.label}`, group: "Navigate", href: n.href })),
    [nav],
  );

  return (
    <AppShell
      nav={nav}
      currentPath={path}
      onNavigate={(h) => router.push(h)}
      branches={branches}
      branchId={branchId}
      onBranchChange={setBranchId}
      allowAllBranches={principal.orgWide}
      user={DEV_USER}
      onSignOut={() => router.push("/")}
      unreadCount={2}
      commands={commands}
    >
      {children}
    </AppShell>
  );
}
