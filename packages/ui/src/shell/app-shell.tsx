"use client";
import * as RD from "@radix-ui/react-dialog";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Bell, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "../button";
import { BranchSwitcher } from "./branch-switcher";
import { CommandPalette } from "./command-palette";
import { Brand, SidebarNav } from "./sidebar";
import type { BranchOption, CommandItem, NavItem, ShellUser } from "./types";

const STORE_KEY = "dentalos.sidebar.collapsed";

export interface AppShellProps {
  brand?: string;
  nav: NavItem[];
  currentPath: string;
  onNavigate: (href: string) => void;
  branches: BranchOption[];
  branchId: string;
  onBranchChange: (id: string) => void;
  allowAllBranches: boolean;
  user: ShellUser;
  onSignOut: () => void;
  unreadCount?: number;
  commands: CommandItem[];
  children: ReactNode;
}

export function AppShell(p: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [palette, setPalette] = useState(false);

  // Per-viewer convenience only; must render correctly when storage is unavailable.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORE_KEY) === "1");
    } catch {}
  }, []);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(STORE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const brand = p.brand ?? "DentalOS";
  const initials = p.user.name
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="dos-shell" data-collapsed={collapsed ? "true" : "false"}>
      <a className="dos-skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className="dos-sidebar" data-inline="true">
        <Brand name={brand} />
        <SidebarNav items={p.nav} currentPath={p.currentPath} />
        <div className="dos-sidebar__foot">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            iconOnly={collapsed}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={18} aria-hidden="true" />
            )}
            {collapsed ? null : <span>Collapse</span>}
          </Button>
        </div>
      </aside>

      <header className="dos-topbar">
        <Button
          className="dos-only-mobile"
          variant="ghost"
          iconOnly
          aria-label="Open navigation"
          onClick={() => setMobileNav(true)}
        >
          <Menu size={20} aria-hidden="true" />
        </Button>
        <BranchSwitcher
          branches={p.branches}
          value={p.branchId}
          onChange={p.onBranchChange}
          allowAll={p.allowAllBranches}
        />
        <div className="dos-topbar__spacer" />
        <button
          type="button"
          className="dos-search-trigger"
          onClick={() => setPalette(true)}
          aria-label="Search ⌘K"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <Search size={16} aria-hidden="true" />
          <span className="dos-hide-mobile">Search</span>
          <kbd className="dos-hide-mobile">⌘K</kbd>
        </button>
        <span className="dos-icon-btn-badge">
          <Button
            variant="ghost"
            iconOnly
            aria-label={p.unreadCount ? `Notifications, ${p.unreadCount} unread` : "Notifications"}
          >
            <Bell size={18} aria-hidden="true" />
          </Button>
          {p.unreadCount ? (
            <span className="dos-count" aria-hidden="true">
              {p.unreadCount > 9 ? "9+" : p.unreadCount}
            </span>
          ) : null}
        </span>
        <DM.Root>
          <DM.Trigger asChild>
            <button type="button" className="dos-btn" data-variant="ghost">
              <span className="dos-avatar">{initials}</span>
              <span className="dos-sr-only">Account menu, {p.user.name}</span>
            </button>
          </DM.Trigger>
          <DM.Portal>
            <DM.Content className="dos-menu" align="end" sideOffset={6}>
              <DM.Label className="dos-menu-label">
                {p.user.name} · {p.user.roleLabel}
              </DM.Label>
              <DM.Separator className="dos-menu-sep" />
              <DM.Item className="dos-menu-item" onSelect={p.onSignOut}>
                <LogOut size={16} aria-hidden="true" /> Sign out
              </DM.Item>
            </DM.Content>
          </DM.Portal>
        </DM.Root>
      </header>

      <main id="main-content" className="dos-main" tabIndex={-1}>
        {p.children}
      </main>

      <RD.Root open={mobileNav} onOpenChange={setMobileNav}>
        <RD.Portal>
          <RD.Overlay className="dos-overlay" />
          <RD.Content className="dos-drawer" data-side="left" style={{ width: "min(300px, 85vw)" }}>
            <RD.Title className="dos-sr-only">Navigation</RD.Title>
            <RD.Description className="dos-sr-only">Main navigation menu</RD.Description>
            <Brand name={brand} />
            <SidebarNav
              items={p.nav}
              currentPath={p.currentPath}
              onNavigate={() => setMobileNav(false)}
            />
          </RD.Content>
        </RD.Portal>
      </RD.Root>

      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        items={p.commands}
        onNavigate={p.onNavigate}
      />
    </div>
  );
}
