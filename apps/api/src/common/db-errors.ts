/**
 * Maps database-enforced M2 rules to stable API error codes. Prisma surfaces exclusion violations
 * and trigger RAISEs as PrismaClientUnknownRequestError (no `.code`), with the Postgres SQLSTATE and
 * message embedded in `message`; raw queries surface P2010 with `meta.code`/`meta.message`. Both
 * shapes are handled by looking at the text, which is what Prisma reliably exposes.
 *
 *   try { ... } catch (e) {
 *     const c = slotConflict(e); if (c) throw new ConflictException({ error: "slot_conflict", resource: c });
 *     const g = clinicalGuardError(e); if (g) throw new ConflictException({ error: g });
 *     const m = notAMember(e); if (m) throw new BadRequestException({ error: "not_a_member", field: m });
 *     throw e;
 *   }
 */

const text = (e: unknown): string => {
  if (!e || typeof e !== "object") return "";
  const meta = (e as { meta?: { code?: unknown; message?: unknown } }).meta;
  return [
    String((e as { message?: unknown }).message ?? ""),
    String(meta?.code ?? ""),
    String(meta?.message ?? ""),
  ].join(" ");
};

/** SQLSTATE 23P01 on the appointment exclusion constraints -> which resource is double-booked. */
export function slotConflict(e: unknown): "dentist" | "chair" | null {
  const t = text(e);
  if (!t.includes("23P01") && !t.includes("exclusion constraint")) return null;
  if (t.includes("Appointment_dentist_no_overlap")) return "dentist";
  if (t.includes("Appointment_chair_no_overlap")) return "chair";
  return null;
}

/** SQLSTATE 23P01 on the WorkingHours exclusion constraints (overlapping sessions). */
export function workingHoursOverlap(e: unknown): boolean {
  return /WorkingHours_(branch|dentist|chair)_no_overlap/.test(text(e));
}

/** Stable codes raised by the 0006 triggers (message prefix), all answered as 409 except the last (400). */
export const CLINICAL_GUARD_CODES = [
  "encounter_signed",
  "encounter_not_signed",
  "tooth_record_immutable",
  "plan_item_history",
  "clinical_row_moved",
] as const;
export type ClinicalGuardCode = (typeof CLINICAL_GUARD_CODES)[number];

export function clinicalGuardError(e: unknown): ClinicalGuardCode | null {
  const t = text(e);
  if (!t.includes("P0001")) return null;
  return CLINICAL_GUARD_CODES.find((c) => t.includes(`${c}:`)) ?? null;
}

/**
 * Trigger tenant_member_guard: a dentist column was set to a user who is not a member of the tenant
 * (or was removed). Answer 400 { error: "not_a_member", field } — validate first for a clearer error.
 */
export function notAMember(e: unknown): string | null {
  const t = text(e);
  if (!t.includes("P0001")) return null;
  return /not_a_member: \w+\.(\w+)/.exec(t)?.[1] ?? null;
}

/** Unique violation (P2002) — e.g. chair code per branch, consent template code, plan version race. */
export function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "P2002" || text(e).includes("23505");
}

// ---------------------------------------------------------------------------------------------
// M3 business operations (migration 0008_m3_business_ops, docs/adr/0004-business-operations-rules.md)
// ---------------------------------------------------------------------------------------------

/**
 * Stable codes raised by the 0008 triggers (SQLSTATE P0001, message prefix `<code>:`). Answer them as
 * `{ error: <code> }` with the status from `M3_GUARD_HTTP` (409 unless noted). Validate in the service first
 * for a clearer message; the DB is the final authority under races.
 *   invoice_*          issued invoices are immutable; balance/status follow allocations and notes only
 *   payment_*          money columns frozen; allocation needs a RECORDED payment
 *   allocation_*       a payment cannot be spent twice
 *   refund_*           caps, reversal pairing, state machine
 *   credit_insufficient  patient advance would go negative
 *   credit_link_mismatch the advance ledger is tied to a payment / allocation / advance refund (amount, patient)
 *   commission_link_mismatch accrual / reversal / payout does not match its allocation, invoice line or settlement
 *   commission_rule_immutable, settlement_*  rules are closed never edited; settlement state machine
 *   insufficient_stock, stock_*  stock ledger / balance trigger
 *   notification_state outbox identity is frozen; only QUEUED moves
 *   tenant_mismatch    a SECURITY DEFINER / counter function was called for another tenant (a bug: 500)
 */
export const M3_GUARD_CODES = [
  "invoice_immutable",
  "invoice_invalid_transition",
  "invoice_not_voidable",
  "invoice_totals_mismatch",
  "invoice_not_payable",
  "invoice_not_adjustable",
  "invoice_overpaid",
  "payment_immutable",
  "payment_not_recorded",
  "allocation_exceeds_payment",
  "refund_immutable",
  "refund_exceeds_payment",
  "refund_exceeds_allocation",
  "refund_reversal_mismatch",
  "credit_insufficient",
  "credit_link_mismatch",
  "commission_link_mismatch",
  "commission_rule_immutable",
  "settlement_state",
  "settlement_total_mismatch",
  "settlement_item_mismatch",
  "insufficient_stock",
  "stock_item_missing",
  "stock_transfer_state",
  "notification_state",
  "tenant_mismatch",
] as const;
export type M3GuardCode = (typeof M3_GUARD_CODES)[number];

/** HTTP status per code: everything is a 409 conflict with current state, except these. */
export const M3_GUARD_HTTP: Readonly<Partial<Record<M3GuardCode, 400 | 500>>> = {
  stock_item_missing: 400,
  tenant_mismatch: 500,
};

/** The M3 trigger code in a database error, or null. */
export function m3GuardError(e: unknown): M3GuardCode | null {
  const t = text(e);
  if (!t.includes("P0001")) return null;
  return M3_GUARD_CODES.find((c) => t.includes(`${c}:`)) ?? null;
}

/** Name of the violated CHECK constraint (SQLSTATE 23514), e.g. "Invoice_balance_chk", or null. */
export function checkViolation(e: unknown): string | null {
  const t = text(e);
  if (!t.includes("23514") && !t.includes("check constraint")) return null;
  return /check constraint "?([A-Za-z0-9_]+)"?/.exec(t)?.[1] ?? "unknown";
}

/** Foreign-key violation (SQLSTATE 23503): the composite FKs that bind patient / branch across entities. */
export function foreignKeyViolation(e: unknown): string | null {
  const t = text(e);
  if (!t.includes("23503") && !t.includes("foreign key constraint")) return null;
  return /foreign key constraint "?([A-Za-z0-9_]+)"?/.exec(t)?.[1] ?? "unknown";
}

/** Overlapping commission-rule scope or settlement period (SQLSTATE 23P01). */
export function commissionOverlap(e: unknown): "rule" | "settlement" | null {
  const t = text(e);
  if (t.includes("CommissionRule_scope_no_overlap") || t.includes("CommissionRule_open_key"))
    return "rule";
  if (t.includes("CommissionSettlement_no_overlap")) return "settlement";
  return null;
}

/**
 * The app role lacks the privilege (SQLSTATE 42501): an append-only table was UPDATEd / DELETEd, or
 * StockBalance was written directly. Always a programming error — log and answer 500.
 */
export function privilegeDenied(e: unknown): boolean {
  const t = text(e);
  return t.includes("42501") || t.includes("permission denied for table");
}

/**
 * Serialization failure (40001) or deadlock (40P01): the whole transaction was rolled back and is safe to run again.
 * Retry the unit of work (a few attempts with jitter) and only then answer 409 `retry_later` / 503. The M3 guards lock
 * Payment, then Invoice (FOR UPDATE) consistently, so this is rare — but two writers racing for one row can still hit it.
 */
export function isRetryableTxError(e: unknown): boolean {
  const t = text(e);
  return (
    t.includes("40P01") ||
    t.includes("40001") ||
    t.includes("deadlock detected") ||
    t.includes("could not serialize access")
  );
}

// ---------------------------------------------------------------------------------------------
// M4 patient portal / AI (migration 0009_m4_portal_analytics_ai, docs/adr/0005-portal-analytics-ai-rules.md)
// ---------------------------------------------------------------------------------------------

/**
 * Stable codes raised by the 0009 triggers (SQLSTATE P0001, message prefix `<code>:`). Answer them as `{ error: <code> }`
 * with the status from `M4_GUARD_HTTP` (409 unless noted). Validate in the service first for a clearer message; the DB is
 * the final authority under races.
 *   portal_account_state / portal_identity_unverified / portal_patient_merged   account lifecycle, staff-verified identity
 *   portal_account_inactive   no session / signature for an account that is not ACTIVE (403)
 *   portal_session_revoked / portal_session_link_mismatch   a revoked session is final; rotation stays in its family
 *   portal_consent_invalid    a portal e-signature needs a GRANTED DIGITAL consent
 *   otp_state / otp_expired / otp_locked   one-time code rules (400 expired, 429 locked)
 *   ai_draft_state / ai_draft_expired   draft status machine; frozen after DRAFT; approval needs the written note
 *   ai_note_invalid           an AI-assisted note must reference a pending draft of its encounter
 */
export const M4_GUARD_CODES = [
  "portal_account_state",
  "portal_identity_unverified",
  "portal_patient_merged",
  "portal_account_inactive",
  "portal_session_revoked",
  "portal_session_link_mismatch",
  "portal_consent_invalid",
  "otp_state",
  "otp_expired",
  "otp_locked",
  "ai_draft_state",
  "ai_draft_expired",
  "ai_note_invalid",
] as const;
export type M4GuardCode = (typeof M4_GUARD_CODES)[number];

/** HTTP status per code: everything is a 409 conflict with current state, except these. */
export const M4_GUARD_HTTP: Readonly<Partial<Record<M4GuardCode, 400 | 403 | 429>>> = {
  portal_account_inactive: 403,
  portal_identity_unverified: 400,
  otp_expired: 400,
  otp_locked: 429,
};

/** The M4 trigger code in a database error, or null. */
export function m4GuardError(e: unknown): M4GuardCode | null {
  const t = text(e);
  if (!t.includes("P0001")) return null;
  return M4_GUARD_CODES.find((c) => t.includes(`${c}:`)) ?? null;
}
