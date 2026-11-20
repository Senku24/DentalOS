# ADR 0004 — Business-operations rules (billing, payments, commissions, inventory, notifications)

Status: **Proposed** (2026-11-21). **Every rule below is a proposed default — needs product sign-off.**
PRD §12.2 lists tax/GST invoice requirements, payment-gateway/refund details, dentist compensation formulas (eligible
revenue, adjustments, settlement), inventory units/valuation/procurement depth and the consent/opt-out rules as open;
§4.6 additionally forbids releasing commission calculations without an explicit configuration specification, and §12.3 leaves
the WhatsApp/SMS/e-mail/payment providers open. M3 therefore implements these as documented defaults and as configuration
knobs where cheap. Each section carries its own status line so sign-off can happen piecemeal. A rule marked **DB** needs a
migration to change; the rest are service-level and change in `packages/validation` or `apps/api`.

Source of truth in code:
- DTOs, state tables, GST / discount / numbering / commission / costing / template / consent helpers (all pure):
  `packages/validation/src/{billing,commissions,inventory,notifications}.ts`
- DB enforcement: `packages/db/prisma/migrations/0008_m3_business_ops/migration.sql` (constraints, triggers, append-only grants, RLS)
- DB error → API error mapping: `apps/api/src/common/db-errors.ts` (`m3GuardError`, `checkViolation`, `foreignKeyViolation`, `commissionOverlap`)
- Permissions: `packages/contracts/src/permissions.ts` → `docs/permissions.md` (generated)

Cross-cutting conventions (all M1/M2 conventions apply unchanged — `docs/M1-org-patients.md`, `docs/M2-clinical.md`):
integer paise, composite `(tenantId, id[, patientId[, branchId]])` FKs, FORCE RLS + `tenant_isolation` on every table, effective-dated
rows close-and-insert, **append-only ledgers (UPDATE/DELETE revoked from the app role)**, ids-only audit, user ids are IdP
subjects (never FKs; `tenant_member_guard` only where noted). Posted financial records are never mutated to conceal history
(PRD 2.5, 4.6, 7.5): invoices, payments, refunds and adjustments are distinct, auditable records.

---

## 1. Invoice lifecycle and estimates

Status: **proposed — needs product sign-off.**

### 1.1 States
`DRAFT → ISSUED → PARTIALLY_PAID → PAID`, plus terminal `VOID`.

| From \ To | ISSUED | PARTIALLY_PAID | PAID | VOID |
|---|---|---|---|---|
| **DRAFT** | ✔ issue (number assigned, lines frozen) | | ✔ (zero-total invoice) | ✔ reason |
| **ISSUED** | | auto | auto | ✔ reason, only if unpaid and un-adjusted |
| **PARTIALLY_PAID** | auto (refund reopens) | | auto | |
| **PAID** | auto | auto (refund / debit note) | | |
| **VOID** | terminal | | | |

"auto" = never set by the API: the database moves the status when allocations, refund reversals or credit/debit notes change the
balance (`invoice_recalc`). The API only asks for **issue** and **void**. Table: `INVOICE_TRANSITIONS`.

### 1.2 Rules
- **Issued invoices are immutable (DB trigger `invoice_guard`)**: lines, amounts, GST fields, patient, branch, number, discount
  and plan/encounter links never change after issue. Only `status`, the money followers (`paidPaise`, `adjustmentPaise`,
  `balancePaise` — via the recalculation function only), `dueDate`, `notes` and the void fields may change.
  Corrections are **credit notes / debit notes** (§4.5), never edits.
- **Void** is allowed only from DRAFT, or from ISSUED with `paidPaise = 0` and no credit/debit notes, with a reason (≥ 3 chars,
  CHECK) and actor. Anything with money on it is corrected with a refund + credit note. A voided number is never reused (§2).
- **Issue** checks in the DB that the header equals the sum of its lines (`invoice_totals_mismatch`) and that there is ≥ 1 line.
  Issue assigns the gap-free number, `issuedAt`, `issuedBy`, snapshots supplier GSTIN / state and place of supply.
- Lines are insert/update/delete **only while the invoice is DRAFT** (trigger `invoice_line_guard`; `invoice_immutable`).
  Invoices are never deleted (grant revoked).
- A DRAFT carries no number, no payments, no adjustments (CHECK `Invoice_status_chk`).
- Consolidated invoices: one invoice may have many lines from different procedures/sessions/encounters; each line keeps its own
  `dentistUserId`, `planItemId`, `procedureRecordId`, `encounterId`.

### 1.3 Estimates vs invoices (PRD 4.6)
- An **estimate is not a record**: it is the plan's frozen item prices (`PlanItem.estimatePricePaise`, ADR 0003 §3) at a plan
  version, shown through `GET /estimates?planId=&planVersion=` using the same GST maths (`computeInvoiceTotals`). Nothing is
  stored; the plan version is the audit trail.
- **Invoice from plan**: `POST /invoices/from-plan` takes the ACCEPTED / SCHEDULED / IN_PROGRESS / COMPLETED items (or the
  given `planItemIds`) that are not billed yet, at their **frozen estimate price** (a later catalogue change never alters it),
  records `planId` + `planVersion` on the invoice, and links each line to its `planItemId`. An item is billed at most once on a
  non-VOID invoice (service check `plan_item_already_billed`; a voided invoice releases its items).
- **Ad hoc invoice**: lines from the catalogue (priced at the branch's effective price, `catalog/pricing.ts`) or free-text lines
  (`description` + `unitPricePaise`).
- **Price override rule**: only AD HOC lines (no `serviceId`, no `planItemId`) carry a caller-set `unitPricePaise`
  (`invoiceLineInput` refuses it otherwise; on PATCH the service refuses it with `price_override_not_allowed` unless `isAdHocLine`).
  A catalogue or plan line is billed at the server's price; any reduction is a **discount** (§3.5: `discount:apply`, reason, role limit,
  audited as `invoice.discount`) — an edited unit price would be a discount with no reason, limit or `discountAppliedBy`.
- Billing from clinical data: a line may reference a COMPLETED `procedureRecordId` (same patient — composite FK); the line's
  attributed dentist defaults to the procedure's `performedBy` / the encounter's treating dentist.

### 1.4 Attribution (PRD 2.5)
`InvoiceLine.dentistUserId` is the **originating** dentist (the one who did the work: procedure → encounter → appointment) and
`Invoice.branchId` the originating branch. Both are frozen with the invoice and **never rewritten after a dentist transfer**.
The column is a text IdP subject guarded by `tenant_member_guard` on write (must be a current member). Consequence: a line
cannot be *newly written* for a member who was already removed (open question O3).

---

## 2. Gap-free per-branch, per-financial-year numbering

Status: **proposed — needs product sign-off.** **DB**

- Format: invoice `BR1/25-26/000123` = `{Branch.code}/{FY}/{6-digit seq}`; other series carry their code:
  credit note `BR1/CN/25-26/000007`, debit note `…/DN/…`, payment receipt `…/RCP/…`.
  (`formatDocumentNumber`, `parseDocumentNumber`; sequences wider than 6 digits just grow.)
- **Financial year = 1 April – 31 March in the branch time zone** (`financialYearOf(at, Branch.timezone)`), written `YY-YY`.
  The counter restarts at 1 each year.
- **Mechanism**: table `InvoiceCounter` (one row per tenant × branch × series × FY, `next` = the next number). The SQL function
  `allocate_document_seq(tenant, branch, series, fy)` inserts the row if missing, **locks it `FOR UPDATE`**, increments and returns
  the number. Call it **inside the transaction that issues the document**: concurrent issuers queue on the row lock and a rollback
  rolls the counter back, so numbers are consecutive with no gaps. Drafts have no number, so abandoned drafts never leave a gap.
- **The app role cannot touch the counter**: `allocate_document_seq` is `SECURITY DEFINER` (fixed `search_path`, pinned to
  `app_tenant_id()`), and `INSERT/UPDATE/DELETE` on `InvoiceCounter` is revoked from `dentalos_app` — the counter cannot be rewound,
  skipped or seeded by a bug or a hand-written statement. (The number *text* on `Invoice` / `InvoiceAdjustment` / `Payment` is written
  by the service from this function's result; a DB check that the text's sequence part is below the counter is not added — the unique
  indexes below turn any collision into a 23505.)
- Uniqueness: `Invoice (tenantId, number)`, `InvoiceAdjustment (tenantId, number)`, `Payment (tenantId, receiptNumber)`.
- Consequence: issuing serialises per (branch, series, FY) — fine at clinic volumes.

---

## 3. GST, tax mode and discounts

Status: **proposed — needs product sign-off.** (Rates and exemptions are the clinic's tax advisor's call; the product never
hard-codes a rate.)

### 3.1 Supply type
- Intra-state (default): **CGST + SGST**, each half of the tax. Inter-state (place of supply state ≠ supplier state): **IGST**.
- Supplier = the branch: GSTIN `Branch.settings.billing.gstin` else `Tenant.settings.gstin`; state code `Branch.settings.billing.stateCode`
  else `Tenant.settings.billing.stateCode`. Place of supply defaults to the supplier state (patients are treated in person);
  staff may set it per invoice. When either state code is unknown the supply is treated as intra-state (`isInterStateSupply`).
- Snapshotted on the invoice at issue: `supplierGstin`, `supplierStateCode`, `placeOfSupplyStateCode` (DB CHECKs on format).

### 3.2 Tax-inclusive vs exclusive
- `Invoice.taxInclusive` is frozen at creation from the knob `billing.taxInclusive` (branch override > tenant; default **exclusive**).
  It is **not** a request field (`createInvoiceRequest` / `updateInvoiceRequest` do not carry it): changing the GST treatment of one
  invoice would change its tax and total outside any permission or audit; change the knob (`billing.settings.update`) instead.
- Exclusive: GST is added to the entered prices. Inclusive: entered prices contain GST; taxable value and tax are extracted.
- DB CHECK: `total = subtotal − discount + (inclusive ? 0 : tax)`; per line `total = taxableValue + cgst + sgst + igst`.

### 3.3 HSN / SAC and rates
- `Service.hsnSac` (4–8 digits) and `Service.gstRateBp` (basis points) are optional columns (migration 0008); `Service.taxable`
  (M1) says whether GST applies at all. Dental treatment by a clinical establishment is generally GST-exempt, so the default is
  **not taxable → 0%**. A taxable service without its own rate uses the knob `billing.defaultGstRateBp` (default 1800 = 18%).
  `lineTaxRateBp(service, default)`. Lines copy `hsnSac` and `taxRateBp` (snapshot): later catalogue edits never change an invoice.
- Credit/debit notes carry `taxPaise` (the GST part of their tax-inclusive amount) for returns/reporting.

### 3.4 Rounding (the rule)
Everything is integer paise; **round half up per line, then sum the rounded lines** (never recompute from totals):
- exclusive: `net = gross − discounts`, `taxable = net`, `tax = round(net × rate / 10000)`
- inclusive: `taxable = round(net × 10000 / (10000 + rate))`, `tax = net − taxable`
- intra-state split: `cgst = floor(tax / 2)`, `sgst = tax − cgst` (the odd paisa goes to SGST; DB CHECK `sgst − cgst ∈ {0,1}`)
- BigInt arithmetic inside (₹1 crore × 10 000 does not overflow). Implementation: `computeGstLine`, `computeInvoiceTotals`.
- No separate "round-off" line in V1: totals are exact paise (open question O5).

### 3.5 Discounts
- A discount of any kind needs permission **`discount:apply`** (at the invoice's branch), a **reason** (≥ 3 chars; DB CHECK on the
  line and on the invoice level) and the actor (`discountAppliedBy`).
- **Level**: per line (`discountPaise`, `discountReason`) or invoice-level (`invoiceDiscountPaise` + `discountReason`); each as a
  **percentage (basis points) or fixed amount** (`discountInput`). A percentage is converted to paise at entry (half up) and the
  paise amount is what is stored; an invoice-level percentage applies to Σ lines after their own discounts.
- Invoice-level discount is **apportioned onto lines** (`allocatedDiscountPaise`, pro-rata, largest remainder, ties to the earlier
  line) so GST, HSN summary and commission base stay per line. Σ allocations = the invoice discount exactly.
- **Limit**: max percentage per role, `billing.discountLimitsBp` (defaults: OWNER 100%, MANAGER 20%, ACCOUNTANT 10%, RECEPTIONIST 5%,
  DENTIST 0%), overridable per branch; a user with several roles gets the highest. The limit applies to the discount as a
  percentage of the amount it reduces (`checkDiscount`, compared exactly in integers: `amount × 10000 ≤ maxBp × base`). Errors: `discount_not_permitted`, `discount_reason_required`,
  `discount_exceeds_limit`, `discount_exceeds_base`.
- Discounts only exist on DRAFT invoices; after issue a price reduction is a credit note (§4.5).

---

## 4. Payments, allocations, advance, refunds, adjustments, ledgers

Status: **proposed — needs product sign-off.**

### 4.1 Payments (append-only)
- A `Payment` is money received at a branch for a patient: method `CASH | UPI | CARD | BANK_TRANSFER | CHEQUE | WALLET | OTHER`,
  `amountPaise > 0`, `reference` (txn id / cheque no. / card last-4 + auth code — **never a full card number**), `receivedAt`,
  `receivedBy`, `branchId`, gateway fields, `receiptNumber` (gap-free, series RCP, assigned when RECORDED).
  `recordPaymentRequest` rejects a `reference` that looks like a full card number (12-19 digits passing Luhn), and `receivedAt` more
  than 5 minutes in the future or older than 400 days (it drives the receipt's financial year; the service also refuses a closed
  period). **The payment receipt is the print view of `paymentDetailResponse`** (payment + allocations + receipt number, numbered
  from the RCP series); there is no separate receipt document.
- **Idempotency key is required on every payment and refund request** (`idempotencyKey`, unique per tenant). A replay with the
  same key and same body returns the original row; the same key with a different body is `409 idempotency_conflict`.
- **Retry safety for every other append-only write** (credit/debit notes, advance apply/adjust, allocations of an existing payment,
  commission adjustments and settlements, stock receive/consume/adjust/waste/transfer-send): the DTO carries a required `idempotencyKey`
  and the service inserts a `RequestDedupe (tenantId, scope, idempotencyKey, requestHash, refType, refId)` row **first, in the same
  transaction** (refId = the id it pre-generated for the result). A unique violation (23505) = replay: return the stored result, write
  nothing; a different `requestHash` = `409 idempotency_conflict`. Without it a double-click would issue a debit note twice or spend an
  advance twice.
- Money columns are immutable. The only UPDATE the app role may do (column-level grant + trigger `payment_guard`): a `PENDING`
  gateway payment becomes `RECORDED` (receipt number, gateway ref) or `FAILED`. Manual payments are born `RECORDED`
  (CHECK `Payment_manual_recorded_chk`). A payment is **never reversed or edited** (`payment_reversal_not_allowed`): a mistake is
  corrected with a refund (§4.4), a wrong amount of advance with a credit adjustment (§4.3).
- Branch rule: a payment belongs to the branch where the money was received; it can be allocated only to invoices of the **same
  branch and patient** (composite FKs `(tenantId, id, patientId, branchId)`).

### 4.2 Allocations (append-only)
- `PaymentAllocation` applies part of a payment to one invoice; a payment may span several invoices; an invoice may be paid by
  several payments (split payments, instalments, advances). `amountPaise > 0` applies; **`< 0` is the reversal written when a refund
  is processed against that invoice** (`refundId` set, CHECK).
- Invariant (trigger `allocation_guard`, payment row locked `FOR UPDATE`):
  `unallocated = amount − Σ PROCESSED refunds − Σ allocations (net of reversals) ≥ 0`
  (`allocation_exceeds_payment`); only `RECORDED` payments can be allocated (`payment_not_recorded`); only ISSUED / PARTIALLY_PAID /
  PAID invoices accept allocations (`invoice_not_payable`).
- **Over-payment**: when the money exceeds the invoice balance the remainder simply stays unallocated and becomes **patient advance**
  (§4.3) if `allowAdvancePayments` (default true); otherwise the request is refused. The DB refuses to over-allocate an invoice
  (`invoice_overpaid`).
- Instalments / payment plans (PRD 4.6) in M3 = several payments against one invoice with the invoice's `dueDate`; a scheduled
  instalment *schedule* object (per-instalment due date and amount, overdue tracking, reminders) is **not modelled**.
  **This is a deliberate PRD 4.6 deviation that needs the product owner's written acceptance** (open question O6, tracked in
  docs/M3-business-ops.md "Not done"): without it PRD 4.6 is under-delivered. Adding it later is additive (a table + a reminder job
  type), no change to payments or allocations.

### 4.3 Patient advance (credit ledger)
- `PatientCreditEntry` is an append-only signed ledger: `ADVANCE +` (unallocated money of a payment), `APPLIED −` (spent on an invoice
  through an allocation), `REFUNDED −` (advance refunded), `ADJUSTMENT ±` (reason required, `invoice:adjust`/finance level, audited).
  Balance = Σ amount per patient, **never negative** (trigger `patient_credit_guard`, advisory-lock serialised per patient;
  `credit_insufficient`). **The ledger is tied to money** (trigger `patient_credit_link_guard`, `credit_link_mismatch`): `ADVANCE`
  needs a RECORDED payment of the same patient and branch and cannot exceed what that payment still has unallocated (held advance
  `Σ ADVANCE − Σ APPLIED − Σ REFUNDED` of one payment never exceeds its unallocated amount, never goes below zero); `APPLIED` must
  equal the (positive, non-refund) allocation it names, once (unique `allocationId`); `REFUNDED` must equal the advance refund
  (`invoiceId` NULL, APPROVED/PROCESSED, same patient) it names, once (unique `refundId`). Only `ADJUSTMENT` is free-standing.
- Using advance on an invoice = allocations from the patient's oldest payments with unallocated money (service picks them) plus
  `APPLIED` entries. Advance is tenant-wide per patient but, because allocations are same-branch, it can only be spent on invoices
  of the branch that took the money (open question O7).

### 4.4 Refunds
- A `Refund` links to **one payment** (`paymentId`), optionally to the invoice whose allocation it comes out of (`invoiceId`).
  States `REQUESTED → APPROVED → PROCESSED`, or `REJECTED` (from REQUESTED/APPROVED) — table `REFUND_TRANSITIONS`, trigger `refund_guard`.
- Permission **`refund:issue`** (request + process; ACCOUNTANT, OWNER). Reason required (≥ 3 chars) and recorded. Receptionists and
  dentists cannot refund.
- **Approval threshold** `billing.refundApprovalThresholdPaise` (default ₹5,000): at or below it the refund is auto-approved by the
  requester; above it a **different** user with **`refund:approve`** (MANAGER, OWNER) must approve (`refund_approval_required`,
  `refund_self_approval`; knob `separateApprover`, default true).
- **A pending advance refund reserves its money**: REQUESTED/APPROVED refunds with `invoiceId` NULL are subtracted from what can be
  allocated (`allocation_guard`) and an advance refund must fit in the unallocated amount net of other pending ones, so the same rupees
  cannot be both refunded and spent (`unallocatedPaise(..., pendingAdvanceRefundsPaise)`).
- **Never exceeds the refundable amount**: Σ non-rejected refunds of a payment ≤ payment amount (checked on request, reserves the
  amount — `refund_exceeds_payment`); an invoice-linked refund ≤ what the payment allocated to that invoice
  (`refund_exceeds_allocation`); at processing time `unallocated ≥ 0` again.
- **Processing** (`refundable → money returned`) in one transaction: (1) invoice-linked: insert the negative allocation → the DB
  recalculates paid/balance/status (invoice reopens); advance-linked: insert a `REFUNDED` credit entry; (2) set status `PROCESSED`
  (the trigger verifies the reversal allocations equal the refund amount — `refund_reversal_mismatch`); (3) write the `REFUND`
  ledger entry and reverse commission (§7.4). Gateway refunds are confirmed by the gateway webhook, never by the client.
- A refund of a payment that funded a later-voided invoice: void is impossible once paid (§1.2), so refund first, then void.

### 4.5 Credit and debit notes (`InvoiceAdjustment`, append-only)
- The only correction of an issued invoice: **credit note** (reduces what the patient owes) and **debit note** (increases it, e.g.
  a missed charge), permission **`invoice:adjust`** (ACCOUNTANT, MANAGER, OWNER), reason required, gap-free numbers (series CN / DN).
- `amountPaise` is tax-inclusive, `taxPaise` its GST part. Insert recalculates the invoice (`adjustmentPaise = Σ debit − Σ credit`,
  `balance = total + adjustment − paid`); a credit note cannot exceed the current balance (`invoice_overpaid`) — to credit a fully
  paid invoice, refund first (reopens the balance), then issue the credit note. Allowed on ISSUED / PARTIALLY_PAID / PAID invoices
  only (`invoice_not_adjustable`). The original invoice document is never altered.

### 4.6 Balance consistency (decision)
Chosen: **`invoice_recalc()` is the single writer of `paidPaise`, `adjustmentPaise`, `balancePaise` and the money-driven status — enforced
by privileges, not by a flag the caller can set.** `invoice_recalc` runs `AFTER INSERT` on `PaymentAllocation` and `InvoiceAdjustment`, is
`SECURITY DEFINER` (fixed `search_path`, pinned to `app_tenant_id()`), locks the invoice row `FOR UPDATE`, recomputes from the ledgers and
rejects negative balances. `dentalos_app` has **no column-level UPDATE** on `paidPaise` / `adjustmentPaise` / `balancePaise`
(`REVOKE UPDATE` + `GRANT UPDATE (other columns)`), and `invoice_guard` recognises the recalculation by `current_user` (the definer),
never by a session variable: an earlier `app.invoice_recalc` GUC could be set by any caller and was removed.
(The app role name `dentalos_app` is wired into the guard and the grants of migration 0008, like 0002's default privileges; a deployment with another
app role must change both together.)
The guard also fixes the ways in: a new invoice is DRAFT with no money; a draft's balance is derived (= total); **DRAFT → ISSUED**
requires paid = 0 and adjustments = 0 with balance = total (and header = Σ lines); **DRAFT → PAID is only for a zero-total invoice** (the
status CHECK gives a zero balance PAID); ISSUED ⇄ PARTIALLY_PAID ⇄ PAID happens only inside the recalculation. Together with the CHECKs
(`balance = total + adjustment − paid`, `balance ≥ 0`, status shape) the invoice cannot drift from its ledgers even under concurrent
requests or a buggy service. The service layer still pre-validates for good error messages.
**Lock order everywhere: Payment row → Invoice row, and the Invoice is locked `FOR UPDATE` from the first statement** (allocation and
adjustment guards) — a `FOR SHARE` that is later upgraded by the recalculation deadlocks two concurrent writers (40P01). Services should
still retry the unit of work on `isRetryableTxError(e)` (40P01 / 40001) before answering 409/503.

### 4.7 Ledgers for reporting and statements
`FinanceLedgerEntry` (append-only) records, in the same transaction as the source row, the effect on what the patient owes:
`INVOICE +total` (on issue), `INVOICE_VOID −total`, `PAYMENT −amount`, `REFUND +amount`, `CREDIT_NOTE −`, `DEBIT_NOTE +`. Σ per patient =
account balance (negative = advance); it drives patient statements and branch/org revenue reports (billed, collected, refunded,
outstanding by branch / dentist (via lines) / method / day). Revenue is attributed to the **invoice's branch and the line's dentist**,
cash to the **payment's branch**.

---

## 5. Payment gateway

Status: **proposed — needs product sign-off** (provider selection is PRD §12.3).

- **Pluggable interface** (service-level, Wave 1 B1): `createCheckout({ amount, patient, reference, idempotencyKey, returnUrl })`,
  `parseWebhook(rawBody, headers)`, `refund({ gatewayRef, amount, idempotencyKey })`. Providers: **`MANUAL`** (staff record payments;
  no checkout) and **`STUB`** (returns a fake checkout URL and lets a developer fire the signed webhook locally). A real gateway is
  one more implementation; `Payment.gateway` is text so adding it needs no migration. Knob `billing.gatewayProvider`.
- **Checkout**: creates a `Payment` with `status = PENDING`, `gateway`, `gatewayRef` and the request's idempotency key; it returns the
  checkout. **A client-side "success" is never trusted** (PRD 4.6): only the webhook moves PENDING → RECORDED / FAILED.
- **Webhook** `POST /webhooks/payments/:gateway/:tenantId` (no staff auth; the tenant comes from the path and selects the signing
  secret — per-tenant secrets live in the secret manager/env, never in `Tenant.settings`; **convention**
  `WEBHOOK_SECRET_<GATEWAY>_<TENANT_UUID_UPPER_UNDERSCORES>` then `WEBHOOK_SECRET_<GATEWAY>`, comma-separated for rotation:
  `webhookSecrets(gateway, tenantId)` in `@dentalos/config`, documented in `.env.example`; none configured ⇒ 401, never accept unsigned).
  **The API keeps the exact request bytes** (`NestFactory.create(..., { rawBody: true })`, read `req.rawBody` via `RawBodyRequest<Request>`):
  verify the HMAC over those bytes, never over a re-serialised JSON body:
  1. verify the signature over the **raw body**: header `X-DentalOS-Signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "t.body")>` with
     constant-time compare, several `v1` allowed for rotation, timestamp within 5 minutes (`parseWebhookSignatureHeader`,
     `isWebhookTimestampFresh`) → else `401 webhook_signature_invalid`;
  2. **idempotent processing, atomically**: the `PaymentGatewayEvent (tenantId, gateway, eventId)` insert and ALL effects of step 3 run in
     **the same `withTenant` transaction**. A unique violation on the event means "already processed" → answer 200 without side effects
     (the table stores the SHA-256 of the body, never the body). Any failure rolls the event row back and answers 5xx, so the provider's
     retry is processed again — committing the event first and the effects later would lose the payment on a crash;
  3. in that transaction: look up the payment by `gatewayRef`, **check the amount** (`payment.succeeded` / `refund.processed` payloads
     require `amountPaise` — `gatewayWebhookPayload` is a discriminated union; a mismatch is 4xx and nothing is written), flip
     PENDING → RECORDED (receipt number from `allocate_document_seq`) or FAILED (`failureCode` required), allocate to the invoices
     recorded at checkout, write ledger/commission side effects; enqueue the receipt notification job **after commit**.
  Always answer 2xx for valid-and-processed or valid-and-duplicate events, 4xx only for bad signature/shape/amount, 5xx to be retried.
  Checkout `returnUrl` must be https (http only for localhost in development) and the service also checks its origin against config.
- Reconciliation/chargebacks are not in M3 (open question O8).

---

## 6. Audit (ids only — never note text, addresses, message bodies or card data)

Every sensitive operation writes an `AuditEvent` through `AuditService` (resource + id, actor, action, branch, outcome, source):
`invoice.create|update|issue|void|discount`, `invoice.print`, `payment.record|allocate|gateway.pending|gateway.recorded|gateway.failed`,
`refund.request|approve|reject|process`, `adjustment.issue`, `credit.adjust`, `commission.rule.create|close`,
`commission.entry.adjust`, `settlement.create|approve|pay|delete`, `stock.receive|consume|adjust|waste|transfer.send|transfer.receive`,
`notification.template.create|publish`, `notification.send_test`, `notification.settings.update`, `billing.settings.update`,
`service.tax_profile.update` (hsnSac, gstRateBp — pricing/tax changes, PRD 7.5), `supplier.create|update`, `stock.item.create|update|deactivate`,
`recall.settings.update`, `advance.apply` (spending patient advance on an invoice), `refund.gateway.confirm` (webhook-driven refund
confirmation, `source = "webhook:<gateway>"`),
financial reads (`statement.read`, `report.revenue`). Webhook events are audited as `source = "webhook:<gateway>"` with the
event id only.

---

## 7. Dentist compensation

Status: **proposed — needs product sign-off.** **The PRD requires an explicit configuration specification before commission is
released; this section is that proposal and nothing accrues until a rule exists** (no rule ⇒ no commission).

### 7.1 Rules (`CommissionRule`)
- Types: **`PERCENT_OF_COLLECTED`** (default) — a percentage of cash actually collected, net of tax; **`PERCENT_OF_BILLED`** — a percentage of
  the line's billed value (before discounts, net of tax), recognised in proportion as the line is collected (so a clinic discount does not
  reduce the dentist's share); **`FIXED_PER_PROCEDURE`** — a fixed amount per procedure unit (× line quantity), recognised in proportion as
  collected.
- Scope: `dentistUserId` (NULL = default for everyone), optional `serviceCategoryId` filter. **Precedence:** dentist+category >
  dentist > default+category > default (`selectCommissionRule`). No match ⇒ no commission.
- **Effective dating** (`effectiveFrom` inclusive, `effectiveTo` exclusive, NULL = open) with **no overlap per scope** (DB: partial unique
  index for the open row + `btree_gist` exclusion constraint) and **immutability** (trigger `commission_rule_immutable`: only closing
  is possible). Changing a percentage = close the old rule and insert the new one (`supersede`). Rules are never back-dated and never
  deleted.
- **Which rule applies**: the one in force on the **invoice's issue date** — late collection does not change the basis the work was billed
  under. The chosen `ruleId` is stored on every ledger entry, so history is reproducible.

### 7.2 Eligible revenue
- Commission accrues **on payment allocation** (collected money), not on invoicing: every allocation row is split over the invoice's lines
  pro-rata to line totals (`splitAllocationOverLines`), and each line's share is turned into the rule's amount (`computeLineCommission`):
  `collected net of tax = share × taxable / total`. Tax is never commissionable. Advance money earns nothing until it is allocated.
- **Cumulative, not per-row** (`computeLineCommission`): each allocation row adds `target(cumulative position) − what the line's entries
  already hold`, where the position is the line's total tax-inclusive share over ALL allocation rows (reversals negative). So
  - instalments, however small, earn exactly what one payment would (no per-row rounding loss; 118 × 1 paise earns the same as 118);
  - a full refund reversal returns the position to 0 and the entries of the line net to exactly 0;
  - `FIXED_PER_PROCEDURE` and `PERCENT_OF_BILLED` use `min(collected, adjusted line total) / adjusted line total`, where the adjusted line
    total is the line total scaled by (invoice total + net credit/debit notes) / invoice total (`adjustedLineTotal`): a **debit note never
    pushes them above the contractual fixed fee / billed percentage**, and a **credit note lowers the amount that has to be collected**
    instead of leaving the line short (resolves the commission part of O11 for adjustments);
  - `PERCENT_OF_COLLECTED` earns on every collected rupee (a debit note's cash included; a credit note collects nothing).
- Dentist attribution = `InvoiceLine.dentistUserId`; a line without a dentist earns no commission. **Attribution is never rewritten after a
  dentist transfer (PRD 2.5).**

### 7.3 Ledger (`CommissionEntry`, append-only)
- `ACCRUAL +` (positive allocation), `REVERSAL −` (negative allocation from a processed refund — same maths, negative share), `ADJUSTMENT ±`
  (manual, reason required, `compensation:manage`), `SETTLEMENT −` (payout). Idempotent per `(allocation row, invoice line)` (unique partial
  index) so a retried job never double-accrues. A positive delta is an `ACCRUAL`, a negative one a `REVERSAL` (zero writes nothing).
  **The DB binds each row to its source** (trigger `commission_entry_guard`, `commission_link_mismatch`): an accrual/reversal sits on an
  allocation of its own invoice and branch (positive allocation ⇒ ACCRUAL, negative ⇒ REVERSAL), for the dentist of that invoice line,
  with a rule of that dentist or the default; a `SETTLEMENT` payout belongs to an APPROVED settlement of that dentist for exactly its total.
- Each ACCRUAL/REVERSAL stores `baseAmountPaise`, `ruleId`, `invoiceId`, `invoiceLineId`, `paymentAllocationId`, `encounterId`, branch.
- Credit/debit notes: a **credit note does not itself reverse commission** (the refund/allocation reversal does; a pure discount credit note
  on an unpaid invoice changes nothing because nothing was collected). A debit note changes what can be collected and therefore accrues as
  it is paid. Reasoned manual adjustments cover the rest.
- Refund of an invoice-linked payment ⇒ negative allocation ⇒ `REVERSAL` entries per affected line, in the same transaction. A refund taken from
  unallocated advance has no commission effect.

### 7.4 Settlement (`CommissionSettlement` + items)
- A run is **per dentist per period** `[periodStart, periodEnd)`; no overlapping periods per dentist (DB exclusion). Creating it collects every
  **unsettled** ledger entry created before `periodEnd` (earlier carry-overs and late reversals included) into items and stores the total.
- States `DRAFT → APPROVED → PAID` (`SETTLEMENT_TRANSITIONS`, trigger `settlement_guard`): items and total are frozen at approval
  (`settlement_total_mismatch`), a settled entry belongs to exactly one settlement (unique), only a DRAFT may be deleted.
- Permissions: create / pay = **`compensation:manage`** (ACCOUNTANT, OWNER), approve = **`compensation:settle`** (OWNER); knob `separateApprover`
  forbids approving one's own run (`settlement_self_approval`). **Pay** = the payout was made outside the app (payroll is out of scope, PRD
  4.6): it writes the `SETTLEMENT −total` entry and sets `paidAt` / reference.
- Reversals after payout are new negative entries and net into the next settlement (carry-forward; the dentist's balance can be negative).
- Statements: `compensation:read` is **self-scoped** for dentists (their own ledger only); `compensation:manage`/OWNER see everyone.

---

## 8. Inventory

Status: **proposed — needs product sign-off.**

- **Items** (`InventoryItem`): `sku` (upper-case, unique per tenant), name, category text, **unit** from a small enum
  `PIECE, BOX, PACK, SET, VIAL, CARTRIDGE, GRAM, KILOGRAM, MILLILITRE, LITRE`, `reorderLevel`, `tracksBatches`, `allowOverdraw`, `active`,
  `costingMethod = WEIGHTED_AVERAGE` (the only method; the enum leaves room). Items are deactivated, never deleted. No unit conversion.
- **Suppliers** (`Supplier`) and simple **purchase receipts** (`StockReceipt` header + `RECEIPT` movements): no purchase orders, no
  supplier invoices/payments, no GRN matching (procurement depth is a PRD §12.2 open item; this is the minimum for stock-in).
- **Stock ledger** (`StockMovement`, append-only): kinds `RECEIPT +`, `CONSUMPTION −`, `ADJUSTMENT ±`, `TRANSFER_OUT −`, `TRANSFER_IN +`,
  `WASTE −`; `quantity numeric(14,3)` signed (CHECK per kind), `unitCostPaise numeric(14,4)`, optional `batchNo` + `expiryDate`,
  optional links (`receiptId`, `transferId`, `procedureRecordId`), `reason` (**required** for ADJUSTMENT and WASTE) and actor.
- **Balance** (`StockBalance`, per branch × item) is maintained **atomically by a `BEFORE INSERT` trigger on StockMovement** (SECURITY
  DEFINER; the app role has no write access to the table): locks the balance row, refuses a **negative balance unless
  `InventoryItem.allowOverdraw`** (`insufficient_stock`), and for batch consumption refuses to take more than the batch holds, updates the
  **weighted-average cost**, stamps the movement with its cost (outflows at the current average) and `balanceAfter`.
  Averaging: on a receipt `avg' = (qty × avg + in × cost) / (qty + in)`; a non-positive balance restarts the average at the incoming cost;
  outflows never change it. Valuation = `quantity × avgUnitCostPaise` (`stockValuePaise`). (Knob for FIFO/other methods = later; open question O9.)
- **Batches / expiry**: optional per item. **FEFO consumption**: without an explicit batch the service consumes first-expiry-first-out
  (`planFefoConsumption`; batches without expiry last), one movement per batch; batch balances are derived from the ledger grouped by
  `batchNo`. Expired batches can still be consumed (the UI warns; `isExpired`); write them off with WASTE.
- **Consumption** may link a `procedureRecordId` (composite FK, same tenant) so usage can be reported per procedure; the link is optional
  (PRD 4.8 asks only for usage records).
- **Transfers** (`inventory:transfer`): `StockTransfer` (+ lines) `IN_TRANSIT → RECEIVED`. **Send** writes `TRANSFER_OUT` rows at the source
  (with the source's average cost on the line); **receive** writes `TRANSFER_IN` rows at the destination at that cost, sets each line's
  `receivedQuantity` and the transfer to RECEIVED. Two ledger rows per line, one per direction, unique per (transfer, item, batch, kind).
  **Reconciled by the DB** (trigger `stock_movement_transfer_guard`, fires before the balance trigger): an OUT never exceeds the line it
  ships and only while IN_TRANSIT at the source branch; an IN needs a matching OUT, never exceeds what was sent, is booked at the
  destination branch and **carries the OUT's unit cost** (a caller-supplied cost is overwritten) — stock cannot be minted or revalued
  by a transfer.
  A short receipt records the shortfall on the line; booking the difference as WASTE/ADJUSTMENT at the source is a manual follow-up (open
  question O10). A transfer cannot be cancelled in M3.
- **Low-stock alert** = balance ≤ `reorderLevel` (`isLowStock`); computed on read (`GET /inventory/low-stock`); no scheduled alert, event or
  notification type in M3 — PRD 4.8 "low-stock alerts" is delivered as the on-read list (a recorded scope decision; a daily sweep job + a
  `LOW_STOCK` notification type is the additive follow-up).
- Permissions: `inventory:read`; `inventory:write` (items, receipts, consumption — DENTIST has it); `inventory:adjust` (adjustments and waste —
  MANAGER, OWNER); `inventory:transfer`.

---

## 9. Notifications

Status: **proposed — needs product sign-off.**

### 9.1 Channels, templates, outbox
- Channels **WHATSAPP, EMAIL, SMS** (M1's `CommChannel` also lists VOICE — not used). WhatsApp is **transactional/reminder only**: no
  two-way inbox, no marketing sends in V1 (PRD 4.7); the `MARKETING` purpose exists for the consent model but no M3 flow sends it.
- **Templates** (`NotificationTemplate` = code + channel + language + purpose; text in append-only `NotificationTemplateVersion`, `{{placeholder}}`
  bodies, optional `providerTemplateRef` for pre-approved WhatsApp templates). System codes and their placeholders are fixed in
  `SYSTEM_TEMPLATES` (`APPT_CONFIRMATION`, `APPT_REMINDER_24H`, `APPT_REMINDER_2H`, `APPT_CHANGED`, `INVOICE_ISSUED`, `PAYMENT_RECEIPT`,
  `REFUND_PROCESSED`, `RECALL_REMINDER`, `PLAN_CONSENT_REQUEST`, `TEST_MESSAGE`); a body may use only its code's placeholders; per-channel length
  limits. Message text **never contains clinical content** (diagnoses, notes, plan item names): clinical messages need authorised review (PRD 4.7).
  Template management = `comms:templates` (org). **`POST /notifications/test` (`sendTestNotificationRequest`, arbitrary `toAddress`) requires
  `comms:templates` only** — never `comms:send`, which receptionists hold: it would be an open message relay once a real provider exists. A published version is immutable; an outbox row pins the exact version.
- **Outbox** (`NotificationOutbox`): `channel`, `purpose`, `templateCode` + `templateVersionId`, `toAddress`, `variables`, `status`
  (`QUEUED | SENT | FAILED | SKIPPED_NO_CONSENT | OPTED_OUT`), `attempts`, `scheduledFor`, `nextAttemptAt`, **`idempotencyKey` (unique per
  tenant)**, provider + `providerMessageId`, `deliveryStatus` / `deliveredAt`, `lastError` (code or short text, **no personal data**, ≤ 500 chars),
  `source`, `refType/refId`, actor (`system` for automated sends). Identity/content columns are frozen by a trigger; only status/attempt/provider
  columns advance; only QUEUED can change status.
- **PII note**: `toAddress` (normalised E.164 phone / e-mail, CHECK) and the placeholder `variables` (display strings such as first name, date,
  amount) are personal data kept in the outbox because they are needed to send. They are protected by RLS and **never** copied into job
  payloads, logs, audit events or the API responses (staff screens get `toAddressMasked`). Rendered bodies are not stored.

### 9.2 Providers
Provider interface: `send({ channel, to, subject?, body, providerTemplateRef?, idempotencyKey }) → { providerMessageId }` (throws on failure),
one implementation per channel. M3 ships a **console/dev sender** (`CONSOLE`: logs a masked line, returns a synthetic message id — no external
account, no network). A real provider is a new implementation; selection by `provider` per channel. A **delivery-receipt webhook**
`POST /webhooks/notifications/:provider/:tenantId` (same signature scheme as §5; idempotent per `eventId`) updates `deliveryStatus`,
`deliveredAt`, appends a `NotificationDeliveryEvent`, and may turn a SENT message FAILED — it never edits content. As in §5 the event insert and
its effects are **one transaction** (5xx on failure so the event row rolls back and the provider's retry reprocesses it); the raw body is
verified (`rawBody: true`) with the same `webhookSecrets()` convention.

### 9.3 Consent and opt-out (the rule)
`CommunicationPreference` rows (patient, channel, purpose) → `optIn` already exist (M1). **A message is sent only if the rules resolve to SEND**
(`resolveConsent`, evaluated at enqueue **and again at send time**, because preferences change):
1. A `TRANSACTIONAL` row with `optIn = false` is the patient's **channel opt-out** → `OPTED_OUT` for every purpose on that channel (transactional
   messages never bypass an explicit channel opt-out).
2. A row for the message's own purpose decides: opted in → send, opted out → `OPTED_OUT`.
3. No row for the purpose: `TRANSACTIONAL` → send only if the knob `implicitConsent.transactional` is on (default **off**), else
   `SKIPPED_NO_CONSENT`; `REMINDER` → inherits an opted-in `TRANSACTIONAL` row, else `implicitConsent.reminder` (default off), else
   `SKIPPED_NO_CONSENT`; `MARKETING` → never implied, `SKIPPED_NO_CONSENT`.
4. A `MARKETING` opt-out never blocks transactional or reminder messages.
A skipped/opted-out message is still written to the outbox (auditable) with that status and is never retried.
(The defaults are the strictest reading of "sends only if opted in"; a clinic that collects consent at registration flips the knobs.)

### 9.4 Quiet hours and reminder timing
- Knob `notifications.quietHours { enabled, start, end, timeZone, exemptPurposes }` (default off; when on, `exemptPurposes` defaults to
  `TRANSACTIONAL` — receipts and confirmations go out immediately). A non-exempt message due inside the window gets `scheduledFor` /
  `nextAttemptAt = nextAllowedSendTime(...)` (`isWithinQuietHours`, wraps midnight).
- **Appointment reminders**: knob `reminderOffsetsMinutes` (default **[1440, 120]** = T-24h and T-2h), `reminderSendTimes(startsAt, offsets, now)`
  drops offsets already in the past. One delayed job per offset, enqueued when the appointment is booked/confirmed (pg-boss `startAfter`);
  the handler **re-reads the appointment** and skips (writes nothing) when it is CANCELLED / RESCHEDULED / NO_SHOW or its start moved. A
  reschedule is a new appointment row (ADR 0003 §1.1), so it gets its own jobs; the old ones no-op. Channel choice: `reminderChannelOrder`
  (default WhatsApp → SMS → e-mail), first channel that is enabled, consented and has an address.
- **Recall reminders**: `RecallSetting (serviceId, intervalDays)`; a daily sweep job finds patients whose last COMPLETED procedure of a service
  with a setting was `intervalDays` ago (minus `recallLeadDays`, default 7), who have no future appointment and no recall sent for that
  procedure; one `RECALL_REMINDER` per (patient, service, due date). `recallDueOn(lastCompletedOn, intervalDays)`.
- **Invoice / payment receipt**: enqueued by billing when an invoice is issued / a payment is RECORDED / a refund is PROCESSED.
- **Plan-consent request**: enqueued when a plan version is presented and consent is outstanding (message carries a link, never plan content).

### 9.5 Background jobs (pg-boss, PRD 6.6)
Queues and ids-only payloads: `NOTIFICATION_QUEUES` + the zod job schemas in `notifications.ts`. Every job uses the envelope of
`apps/worker/src/jobs.ts` (`tenantId, actorId, source, idempotencyKey, data`) and runs through `registerTenantJob` (tenant RLS context,
trace continuation). **Idempotent enqueue**: `idempotencyKey` → pg-boss `singletonKey` (queue policy `short`) *and* the outbox's unique
`idempotencyKey` (delivery is at-least-once, so the handler must tolerate duplicates). **Retries**: `retryLimit = NOTIFICATION_MAX_ATTEMPTS` (5),
exponential backoff from 30 s capped at 1 h (`retryDelaySeconds`); the handler increments `attempts`, stores `lastError`, and ends `FAILED` when
exhausted (alert on FAILED). Sending happens **outside any DB transaction** (no network I/O inside `withTenant`): load/lock the row → claim →
send → record the result in a second short transaction, using the outbox idempotency key as the provider's dedupe key.
Producers (billing, scheduling, plans) enqueue by queue name only and never import from `notifications/`.

---

## 10. Configuration knobs

Status: **proposed — needs product sign-off.** All zod-validated, unknown keys rejected, resolved with `resolveBillingSettings` /
`resolveNotificationSettings` (missing/invalid → defaults, never thrown). PATCH requests carry no defaults.

### `Tenant.settings.billing` (`tenantBillingSettings`) — branch override in `Branch.settings.billing` (`branchBillingSettings`) where marked ◆
| Knob | Default | Meaning |
|---|---|---|
| `taxInclusive` ◆ | false | Entered prices include GST (frozen per invoice) |
| `stateCode` ◆ | none | Supplier GST state code (place-of-supply default) |
| `gstin` (branch only; tenant: `Tenant.settings.gstin`) | none | Supplier GSTIN snapshot |
| `defaultGstRateBp` | 1800 | Rate for taxable services without their own `gstRateBp` |
| `invoiceDueDays` ◆ | 0 | Due date = issue date + N days |
| `discountLimitsBp` ◆ | owner 10000, manager 2000, accountant 1000, receptionist 500, dentist 0 | Max discount % (basis points) by role |
| `refundApprovalThresholdPaise` ◆ | 500000 | Refunds above this need a second approver |
| `separateApprover` | true | Refund / settlement approver ≠ requester / creator |
| `allowAdvancePayments` | true | Over-payments become patient advance |
| `allowedPaymentMethods` ◆ | all seven | Methods the front desk may record |
| `gatewayProvider` | `MANUAL` | `MANUAL` or `STUB` |

### `Tenant.settings.notifications` (`notificationSettings`)
| Knob | Default | Meaning |
|---|---|---|
| `enabledChannels` | all three | Channels in use |
| `reminderChannelOrder` | WHATSAPP, SMS, EMAIL | Reminder channel preference |
| `reminderOffsetsMinutes` | [1440, 120] | Minutes before the appointment |
| `quietHours` | off | `{ enabled, start, end, timeZone, exemptPurposes }` |
| `implicitConsent` | transactional off, reminder off | Treat "no preference row" as opted in |
| `recallLeadDays` | 7 | Send recall this many days before due |
| `senderName` | none | E-mail display name |

Commission rules are data (`CommissionRule`), not knobs; inventory knobs are per item (`allowOverdraw`, `tracksBatches`, `reorderLevel`).

---

## 11. Error codes (stable)

DB trigger codes → `{ error: <code> }`, 409 unless noted (`apps/api/src/common/db-errors.ts`, `M3_GUARD_CODES`):
`invoice_immutable`, `invoice_invalid_transition`, `invoice_not_voidable`, `invoice_totals_mismatch`, `invoice_not_payable`,
`invoice_not_adjustable`, `invoice_overpaid`, `payment_immutable`, `payment_not_recorded`, `allocation_exceeds_payment`, `refund_immutable`,
`refund_exceeds_payment`, `refund_exceeds_allocation`, `refund_reversal_mismatch`, `credit_insufficient`, `credit_link_mismatch`,
`commission_link_mismatch`, `commission_rule_immutable`,
`settlement_state`, `settlement_total_mismatch`, `settlement_item_mismatch`, `insufficient_stock`, `stock_transfer_state`,
`notification_state`; `stock_item_missing` → 400; `tenant_mismatch` → 500 (a bug).
Deadlock / serialization failure (40P01, 40001): `isRetryableTxError(e)` — retry the unit of work, then 409/503.
Constraint/FK/exclusion violations: `checkViolation(e)` (CHECK name), `foreignKeyViolation(e)` (composite FK = wrong patient/branch),
`commissionOverlap(e)`, `isUniqueViolation(e)` (idempotency key / document number race). Permission-denied (42501) on an append-only
table is a programming error → log + 500. API-level codes (not DB): `BILLING_ERROR_CODES`, `COMMISSION_ERROR_CODES`,
`INVENTORY_ERROR_CODES`, `NOTIFICATION_ERROR_CODES` in `@dentalos/validation`.

---

## 12. Permissions (additions to `docs/permissions.md`)

| Permission | Scope | Who | Covers |
|---|---|---|---|
| `invoice:adjust` | branch | OWNER, MANAGER, ACCOUNTANT | credit/debit notes |
| `refund:approve` | branch | OWNER, MANAGER | approve/reject refunds above the threshold |
| `compensation:settle` | org | OWNER | approve a settlement run |
| `inventory:adjust` | branch | OWNER, MANAGER | adjustments, waste |
| `comms:read` | branch | OWNER, MANAGER, RECEPTIONIST | outbox, delivery status |
| `comms:templates` | org | OWNER | templates, settings **and `POST /notifications/test`** (not `comms:send`) |
Existing and unchanged: receptionist = invoices + payments (no refunds, no credit notes, no discounts); accountant = finance + refunds +
compensation manage; dentist = `compensation:read` (self) + inventory read/write; manager = inventory + discounts + approvals.

---

## Open questions (need product / legal input)

- **O1** GST: which services are taxable, at what rates and HSN/SAC; whether e-invoicing (IRN/QR) or GSTR exports are needed; B2B invoices (recipient GSTIN); round-off line.
- **O2** Financial-year rule and numbering per branch vs per GSTIN (a legal entity with several branches may need one series per GSTIN).
- **O3** Billing late work of a dentist who has since left (the member guard blocks writing a removed member onto a new line).
- **O4** Credit note on a paid invoice: refund-first (proposed) vs automatic conversion of the excess into patient advance.
- **O5** Round-off to the nearest rupee as a visible line; cash rounding.
- **O6** Instalment / payment-plan schedules as first-class objects (due dates, reminders) vs plain partial payments.
- **O7** Advance usable across branches (needs a branch-attribution rule for the money) and expiry/refund policy for advances.
- **O8** Gateway selection, reconciliation, chargebacks, partial captures, refunds to source via the gateway, settlement/fee accounting.
- **O9** Costing: FIFO or standard cost instead of weighted average; valuation reporting period; negative-stock policy default.
- **O10** Transfer shortages/damage handling, cancelling an in-transit transfer, inter-branch transfer pricing.
- **O11** Commission: eligible-revenue definition (net of tax proposed; lab/consumable cost deductions?), treatment of discounts/cash discounts, instalment timing, clawback horizon after payout, who may approve (maker-checker), per-branch vs org settlement, tax (TDS) on payouts.
- **O12** Consent defaults (implicit transactional/reminder consent), DLT registration for SMS, WhatsApp template approval flow, quiet-hours legal limits, retention of notification logs.
- **O13** Plan-consent request link: patient-facing signing page belongs to the patient portal (M4).
- **O14** Procurement depth (purchase orders, supplier payments), units-of-measure conversion, serial-tracked equipment.
