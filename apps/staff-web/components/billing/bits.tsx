"use client";
import "./billing.css";
import { Badge, SelectField, useLink } from "@dentalos/ui";
import type {
  BranchResponse,
  InvoiceStatus,
  PaymentStatus,
  RefundStatus,
} from "@dentalos/validation";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  invoiceStatusLabel,
  invoiceTone,
  paymentStatusLabel,
  paymentTone,
  refundStatusLabel,
  refundTone,
} from "../../lib/api/billing-rules";
import { formatPaise } from "../../lib/format";
import { canDo } from "../../lib/session";

export const InvoiceStatusBadge = ({ status }: { status: InvoiceStatus }) => (
  <Badge tone={invoiceTone(status)}>{invoiceStatusLabel(status)}</Badge>
);
export const PaymentStatusBadge = ({ status }: { status: PaymentStatus }) => (
  <Badge tone={paymentTone(status)}>{paymentStatusLabel(status)}</Badge>
);
export const RefundStatusBadge = ({ status }: { status: RefundStatus }) => (
  <Badge tone={refundTone(status)}>{refundStatusLabel(status)}</Badge>
);

/** Right-aligned paise (₹, Indian grouping). Negative amounts keep their sign and are flagged. */
export function Money({ paise, bold }: { paise: number | null | undefined; bold?: boolean }) {
  return (
    <span
      className="bil-money"
      data-negative={typeof paise === "number" && paise < 0 ? "true" : undefined}
      style={bold ? { fontWeight: 600 } : undefined}
    >
      {formatPaise(paise)}
    </span>
  );
}

/** "" = every branch the user can see. */
export function BranchFilter({
  branches,
  value,
  onChange,
  label = "Branch",
  allLabel = "All my branches",
  required,
}: {
  branches: BranchResponse[];
  value: string;
  onChange: (v: string) => void;
  label?: string;
  allLabel?: string;
  required?: boolean;
}) {
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {required ? null : <option value="">{allLabel}</option>}
      {branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </SelectField>
  );
}

/** Invoices · Payments · Refunds section switcher (links, current page marked). */
export function BillingSubnav() {
  const Link = useLink();
  const path = usePathname() ?? "";
  const items: { href: string; label: string; show: boolean; match: (p: string) => boolean }[] = [
    { href: "/billing", label: "Overview", show: true, match: (p) => p === "/billing" },
    {
      href: "/invoices",
      label: "Invoices",
      show: true,
      match: (p) => p.startsWith("/invoices"),
    },
    {
      href: "/payments",
      label: "Payments",
      show: true,
      match: (p) =>
        p === "/payments" || (p.startsWith("/payments/") && !p.startsWith("/payments/refunds")),
    },
    {
      href: "/payments/refunds",
      label: "Refunds",
      show: true,
      match: (p) => p.startsWith("/payments/refunds"),
    },
    {
      href: "/billing/reports",
      label: "Reports",
      show: canDo("finance:report"),
      match: (p) => p.startsWith("/billing/reports"),
    },
    {
      href: "/billing/settings",
      label: "Settings",
      show: canDo("billing:read"),
      match: (p) => p.startsWith("/billing/settings"),
    },
  ];
  return (
    <nav className="bil-subnav bil-no-print" aria-label="Billing sections">
      {items
        .filter((i) => i.show)
        .map((i) => (
          <Link key={i.href} href={i.href} aria-current={i.match(path) ? "page" : undefined}>
            {i.label}
          </Link>
        ))}
    </nav>
  );
}

/** Totals block shared by the invoice form preview and the invoice page. */
export function TotalsList({
  rows,
  className,
}: {
  rows: { label: ReactNode; paise: number; strong?: boolean; hide?: boolean }[];
  className?: string;
}) {
  return (
    <dl className={`bil-totals ${className ?? ""}`}>
      {rows
        .filter((r) => !r.hide)
        .map((r, i) => (
          <div key={`${i}-${String(r.label)}`} style={{ display: "contents" }}>
            <dt className={r.strong ? "bil-total-row" : undefined}>{r.label}</dt>
            <dd className={r.strong ? "bil-total-row" : undefined}>{formatPaise(r.paise)}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Segmented control (aria-pressed toggle buttons). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="bil-seg" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/** A link that looks like a button (a real anchor, so no button-inside-link nesting). */
export function LinkButton({
  href,
  children,
  variant = "secondary",
  size = "md",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "sm";
}) {
  const Link = useLink();
  return (
    <Link href={href} className="dos-btn" data-variant={variant} data-size={size}>
      {children}
    </Link>
  );
}
