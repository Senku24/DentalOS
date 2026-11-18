import type { Permission } from "@dentalos/contracts";
import type { NavItem } from "@dentalos/ui";
import {
  BarChart3,
  Boxes,
  CalendarDays,
  LayoutDashboard,
  Palette,
  Receipt,
  Settings,
  Stethoscope,
  Users,
} from "lucide-react";

export interface PermNavItem extends NavItem {
  /** Hidden unless the principal holds this permission. Display only: the API enforces it. */
  permission?: Permission;
  milestone?: string;
}

export const NAV: PermNavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  {
    label: "Appointments",
    href: "/appointments",
    icon: CalendarDays,
    section: "Front desk",
    permission: "appointment:read",
    milestone: "M2",
  },
  {
    label: "Patients",
    href: "/patients",
    icon: Users,
    section: "Front desk",
    permission: "patient:read",
  },
  {
    label: "Clinical",
    href: "/clinical",
    icon: Stethoscope,
    section: "Care",
    permission: "clinical:read",
    milestone: "M2",
  },
  {
    label: "Billing",
    href: "/billing",
    icon: Receipt,
    section: "Business",
    permission: "billing:read",
    milestone: "M3",
  },
  {
    label: "Inventory",
    href: "/inventory",
    icon: Boxes,
    section: "Business",
    permission: "inventory:read",
    milestone: "M3",
  },
  {
    label: "Reports",
    href: "/reports",
    icon: BarChart3,
    section: "Business",
    permission: "analytics:branch",
    milestone: "M4",
  },
  {
    label: "Organisation",
    href: "/settings",
    icon: Settings,
    section: "Admin",
    permission: "org:manage",
    milestone: "M1",
  },
  { label: "Design system", href: "/design", icon: Palette, section: "Developer" },
];
