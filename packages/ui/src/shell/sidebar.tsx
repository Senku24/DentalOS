"use client";
import { Stethoscope } from "lucide-react";
import { useLink } from "../link";
import type { NavItem } from "./types";

const isActive = (current: string, href: string) =>
  href === "/" ? current === "/" : current === href || current.startsWith(`${href}/`);

export function Brand({ name }: { name: string }) {
  return (
    <div className="dos-brand">
      <span className="dos-brand__mark" aria-hidden="true">
        <Stethoscope size={18} />
      </span>
      <span className="dos-brand__name">{name}</span>
    </div>
  );
}

/** Primary navigation. Shared by the inline sidebar and the mobile drawer. */
export function SidebarNav({
  items,
  currentPath,
  onNavigate,
}: { items: NavItem[]; currentPath: string; onNavigate?: () => void }) {
  const Link = useLink();
  let lastSection: string | undefined;
  return (
    <nav className="dos-nav" aria-label="Primary">
      {items.map((it) => {
        const heading = it.section && it.section !== lastSection ? it.section : undefined;
        lastSection = it.section ?? lastSection;
        const Icon = it.icon;
        return (
          <div key={it.href} style={{ display: "contents" }}>
            {heading ? <div className="dos-nav__section">{heading}</div> : null}
            <Link
              href={it.href}
              className="dos-nav__link"
              aria-current={isActive(currentPath, it.href) ? "page" : undefined}
              onClick={onNavigate}
              title={it.label}
            >
              <Icon size={18} aria-hidden="true" />
              <span className="dos-nav__label">{it.label}</span>
            </Link>
          </div>
        );
      })}
    </nav>
  );
}
