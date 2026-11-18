import type { BadgeTone } from "@dentalos/ui";

/** Display formatting. Money is integer paise everywhere; only this file turns it into rupees. */

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const inrExact = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 125050 → "₹1,250.50"; 150000 → "₹1,500" (Indian digit grouping: ₹1,50,000). */
export function formatPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return "—";
  const rupees = paise / 100;
  return paise % 100 === 0 ? inr.format(rupees) : inrExact.format(rupees);
}

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

/** "2026-11-19" or ISO datetime → "19 Nov 2026". Date-only strings are not shifted by time zone. */
export function formatDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00+05:30`) : new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}
export function formatDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

/** Whole years between dob and `on` (default today). */
export function ageFrom(dob: string | null | undefined, on: Date = new Date()): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number) as [number, number, number];
  if (!y || !m || !d) return null;
  let age = on.getFullYear() - y;
  const beforeBirthday = on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

/** "+919000010037" → "+91 90000 10037". Other formats returned unchanged. */
export function formatPhone(v: string | null | undefined): string {
  if (!v) return "—";
  const m = /^\+91(\d{5})(\d{5})$/.exec(v);
  return m ? `+91 ${m[1]} ${m[2]}` : v;
}

/** "IN_TREATMENT" → "In treatment". */
export function humanize(v: string | null | undefined): string {
  if (!v) return "—";
  const s = v.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function patientName(p: {
  firstName: string;
  lastName: string | null;
  preferredName?: string | null;
}): string {
  return [p.firstName, p.lastName].filter(Boolean).join(" ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function lifecycleTone(stage: string): BadgeTone {
  switch (stage) {
    case "IN_TREATMENT":
      return "brand";
    case "ACTIVE":
      return "success";
    case "FOLLOW_UP":
    case "RECALL":
      return "info";
    case "INACTIVE":
      return "neutral";
    default:
      return "neutral";
  }
}

export function severityTone(sev: string): BadgeTone {
  switch (sev) {
    case "CRITICAL":
    case "HIGH":
      return "danger";
    case "MODERATE":
      return "warning";
    default:
      return "info";
  }
}

export function todayISO(): string {
  // Local calendar date in IST (the clinic's zone), not UTC.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
