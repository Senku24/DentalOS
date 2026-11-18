"use client";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import type { CommandItem } from "./types";

/** Global/command search (Ctrl/⌘+K). Items are supplied by the app, already permission-filtered. */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  onNavigate,
  header,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  items: CommandItem[];
  onNavigate: (href: string) => void;
  header?: ReactNode;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, CommandItem[]>();
    for (const it of items) m.set(it.group, [...(m.get(it.group) ?? []), it]);
    return [...m.entries()];
  }, [items]);
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search and commands"
      overlayClassName="dos-overlay"
      contentClassName="dos-cmd"
    >
      {header}
      <Command.Input
        placeholder="Search pages and actions…"
        aria-label="Search pages and actions"
      />
      <Command.List>
        <Command.Empty>No results found.</Command.Empty>
        {groups.map(([group, list]) => (
          <Command.Group key={group} heading={group}>
            {list.map((it) => (
              <Command.Item
                key={it.id}
                value={`${it.group} ${it.label}`}
                onSelect={() => {
                  onOpenChange(false);
                  if (it.onSelect) it.onSelect();
                  else if (it.href) onNavigate(it.href);
                }}
              >
                <Search size={16} aria-hidden="true" />
                {it.label}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
