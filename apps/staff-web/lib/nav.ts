import type { Permission } from "@dentalos/contracts";
import type { NavItem } from "@dentalos/ui";
import {
  BarChart3,
  Boxes,
  Building2,
  CalendarDays,
  ClipboardList,
  CopyCheck,
  IndianRupee,
  Inbox,
  LayoutDashboard,
  Palette,
  Receipt,
  Settings,
  Stethoscope,
  UserCog,
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
    label: "Enquiries",
    href: "/enquiries",
    icon: Inbox,
    section: "Front desk",
    permission: "patient:read",
  },
  {
    label: "Duplicate review",
    href: "/patients/duplicates",
    icon: CopyCheck,
    section: "Front desk",
    permission: "patient:merge",
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
    href: "/admin/organisation",
    icon: Settings,
    section: "Administration",
    permission: "org:manage",
  },
  {
    label: "Branches",
    href: "/admin/branches",
    icon: Building2,
    section: "Administration",
    permission: "branch:read",
  },
  {
    label: "Staff",
    href: "/admin/staff",
    icon: UserCog,
    section: "Administration",
    permission: "staff:read",
  },
  {
    label: "Dentist assignments",
    href: "/admin/dentists",
    icon: Stethoscope,
    section: "Administration",
    permission: "staff:read",
  },
  {
    label: "Service catalogue",
    href: "/admin/catalogue",
    icon: ClipboardList,
    section: "Administration",
    permission: "catalog:read",
  },
  {
    label: "Branch pricing",
    href: "/admin/pricing",
    icon: IndianRupee,
    section: "Administration",
    permission: "catalog:read",
  },
  { label: "Design system", href: "/design", icon: Palette, section: "Developer" },
];
