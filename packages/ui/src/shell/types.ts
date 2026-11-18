import type { LucideIcon } from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Optional group heading shown above the first item of a group. */
  section?: string;
}
export interface BranchOption {
  id: string;
  name: string;
}
export interface ShellUser {
  name: string;
  roleLabel: string;
}
export interface CommandItem {
  id: string;
  label: string;
  group: string;
  href?: string;
  onSelect?: () => void;
}
