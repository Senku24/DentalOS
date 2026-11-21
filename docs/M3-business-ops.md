# M3 — Business operations status

Scope (PRD 4.6–4.8, 2.5, 6.6, 7.5, 9.2, 11): estimates/invoices, payments, refunds, credit/debit notes, patient advance,
dentist commissions and settlements, inventory (items, suppliers, receipts, usage, transfers), WhatsApp / e-mail / SMS notifications
and the background jobs that send them. Domain rules: **`docs/adr/0004-business-operations-rules.md` — proposed defaults, pending
product sign-off.** Permission matrix: `docs/permissions.md` (generated).

> **No automated tests exist in this project right now** (deliberately removed). Do not write test files, scripts or test
> dependencies. The quality gate is `bun run lint`, `bun run typecheck`, `bun run build`; behaviour is verified with ad-hoc probes
> (psql via `docker exec infra-postgres-1 psql -U postgres dentalos`, `bun -e`, curl against a locally started API) that are deleted
> afterwards. Local run setup: `docs/LOCAL-SETUP.md` (root `.env`; never print or commit secrets).

## Done (foundation, Phase 0)
- [x] ADR 0004: invoice lifecycle, gap-free numbering, GST (CGST+SGST / IGST, inclusive / exclusive, HSN/SAC, rounding), discounts,
      payments / allocations / advance / refunds / credit & debit notes, gateway + signed idempotent webhook, commission rules / ledger /
      settlement, inventory (FEFO, weighted-average cost, transfers), notifications (consent rule, quiet hours, reminders, recall, jobs),
      knobs, error codes, audit list, 14 open questions.
- [x] Migration `0008_m3_business_ops` (26 tables, hand-written constraints/triggers/grants/RLS — see "Database" below); schema.prisma models;
      `Service.hsnSac` / `Service.gstRateBp`; `ProcedureRecord` gained `(tenantId, id[, patientId])` unique keys. No Prisma drift
      (`prisma migrate diff` from the migrated DB → schema is empty). RLS verified: every table has FORCE RLS + `tenant_isolation`.
- [x] `@dentalos/validation`: `billing.ts`, `commissions.ts`, `inventory.ts`, `notifications.ts` — request/response DTOs, state tables and the
      pure helpers (GST, FY + numbering, discounts, commission calculation, weighted-average cost, FEFO, template rendering, consent
      resolution, quiet hours, reminder times, recall, retry backoff). `tenantSettings` gained `billing` + `notifications`;
      `branchSettings` gained `billing`. All PATCH/update schemas have no zod defaults (`parse({})` is `{}`).
- [x] Permissions: new `invoice:adjust`, `refund:approve`, `compensation:settle`, `inventory:adjust`, `comms:read` (see ADR §12); `docs/permissions.md` regenerated.
- [x] API: stub `BillingModule`, `CommissionsModule`, `InventoryModule`, `NotificationsModule` registered in `AppModule`;
      `common/db-errors.ts` gained `m3GuardError`, `checkViolation`, `foreignKeyViolation`, `commissionOverlap`, `privilegeDenied`.
- [x] Worker: `apps/worker/src/handlers/index.ts` registry wired from `main.ts` (pg-boss starts only when a registrar exists). The worker
      starts pg-boss as the schema owner (`PGBOSS_DATABASE_URL`, else `ADMIN_DATABASE_URL`) and grants `dentalos_app` access to `pgboss.*`
      (`startBoss` → `grantAppRole`); `apps/worker/package.json` now depends on `@dentalos/validation`.
- [x] API job enqueue: global `JobQueueService` (`apps/api/src/common/job-queue.service.ts`, `enqueue(queue, envelope, { startAfter })`;
      send-only pg-boss as the app role, singletonKey = `tenant:idempotencyKey`, trace context injected). Enqueue AFTER the business commit.
- [x] Webhooks: API runs with `rawBody: true` (`req.rawBody`); signing secrets via `webhookSecrets(gateway, tenantId)` (`@dentalos/config`,
      env convention in `.env.example`). The event insert and ALL effects are ONE transaction (ADR 0004 §5).

## Not done
- [ ] Wave 1 — B1 billing API, C1 commissions + inventory API, N1 notifications API + worker handlers (ownership below).
- [ ] Wave 2 — U1 billing UI, U2 inventory + compensation UI, U3 notifications/settings UI.
- [ ] Wave 3 — integration (cross-module jobs: invoice → receipt notification, allocation → commission accrual, appointment → reminders),
      OpenAPI ↔ `routes.ts` contract check, end-to-end pass, gateway webhook walk-through with the stub provider.
- [ ] ADR 0004 product sign-off (all sections; see its "Open questions").
- [ ] **Product-owner acceptance of two PRD deviations**: instalment *schedules* (PRD 4.6; M3 = several payments per invoice, O6) and scheduled
      low-stock *alerts* (PRD 4.8; M3 = on-read list). Until accepted these are under-delivered, not silently dropped.

## Ownership map
Frozen after Phase 0 (changes go through the commander / integration agent): `packages/db/**`, `packages/validation/**`,
`packages/contracts/**`, `apps/api/src/{app.module.ts,common/**}`, `package.json`, `bun.lock`, `docs/**`.
Workers never commit and never `git stash`. If a worker needs a DTO, permission, column or error code that is missing, it reports the
request to the commander instead of editing frozen files. The worker already depends on `@dentalos/validation` and the API has `JobQueueService`; request anything else from the commander.

| Wave | Worker | Owns |
|---|---|---|
| 1 | **B1 Billing** | `apps/api/src/billing/**` |
| 1 | **C1 Commissions + inventory** | `apps/api/src/commissions/**`, `apps/api/src/inventory/**` |
| 1 | **N1 Notifications** | `apps/api/src/notifications/**`, `apps/worker/src/handlers/**` |
| 2 | **U1 Billing UI** | `apps/staff-web/app/{billing,invoices,payments}/**`, `apps/staff-web/lib/api/billing*.ts` |
| 2 | **U2 Inventory + compensation UI** | `apps/staff-web/app/{inventory,compensation}/**`, `apps/staff-web/lib/api/{inventory,compensation}*.ts` |
| 2 | **U3 Notifications / settings UI** | `apps/staff-web/app/{notifications,admin/messaging}/**`, `apps/staff-web/lib/api/notifications*.ts` |

U1–U3 must not edit `lib/session.ts`, `nav.ts` or `lib/api/routes.ts`; send route/nav additions to the commander. Cross-module rule for
Wave 1: **no imports between `billing/`, `commissions/`, `inventory/`, `notifications/`** (link by id / FK; cross-module effects go through
pg-boss jobs by queue name or through reads of the shared tables). Shared reads import from earlier modules' pure helpers
(`catalog/pricing.ts`, `patients/patient-common.ts`).

## Database (migration 0008) — what is enforced, so services can lean on it
| Area | Tables | Enforced by the DB |
|---|---|---|
| Numbering | `InvoiceCounter` | `allocate_document_seq(tenant, branch, series, fy)` (SECURITY DEFINER) locks the counter row `FOR UPDATE` (gap-free inside the issuing txn); the app role has SELECT only on the counter table (no rewind / skip / seed) |
| Retry safety | `RequestDedupe` | `(tenantId, scope, idempotencyKey)` unique, append-only: insert FIRST in the transaction of every append-only write that has no natural key (debit/credit notes, advance apply/adjust, commission adjust/settlement, stock receive/consume/adjust/waste/transfer-send); 23505 = replay |
| Invoices | `Invoice`, `InvoiceLine` | status/amount CHECKs; **issued invoice frozen** (`invoice_guard`); lines only while DRAFT (`invoice_line_guard`); header = Σ lines at issue; DRAFT → ISSUED only unpaid/unadjusted (DRAFT → PAID only for a zero total); `paid/adjustment/balance` written only by `invoice_recalc()` (SECURITY DEFINER, AFTER INSERT on allocation / adjustment) — the app role has **no UPDATE privilege** on those three columns and the guard identifies the recalculation by `current_user`, not by a session variable; balance ≥ 0; `tenant_member_guard` on `InvoiceLine.dentistUserId`; no DELETE |
| Money in | `Payment`, `PaymentAllocation`, `PaymentGatewayEvent` | Payment money columns frozen, column-level UPDATE grant (`status, gatewayRef, reference, receiptNumber, receivedAt, failureCode`) + `payment_guard` (PENDING → RECORDED/FAILED only); allocation append-only, same patient AND branch (composite FKs), `unallocated ≥ 0` (pending advance refunds reserve their amount), RECORDED payments only; Invoice locked `FOR UPDATE` from the first statement (no 40P01 between concurrent allocations); `(tenantId, idempotencyKey)` and `(tenantId, receiptNumber)` unique; webhook events unique per `(gateway, eventId)` |
| Money out | `Refund`, `InvoiceAdjustment`, `PatientCreditEntry`, `FinanceLedgerEntry` | refund caps + state machine + reversal pairing (`refund_guard`), column-level UPDATE grant; adjustments, credit and finance ledgers append-only; advance balance ≥ 0 (`patient_credit_guard`); advance ledger tied to its payment / allocation / advance refund with equal amounts, once each (`patient_credit_link_guard`); ledger sign/source CHECKs |
| Compensation | `CommissionRule`, `CommissionEntry`, `CommissionSettlement`, `CommissionSettlementItem` | rules closed-never-edited (`commission_rule_guard`, column grant) + one open rule per scope + no overlapping periods (exclusion); entries append-only, idempotent per `(allocation, line)`, bound to their allocation / invoice line dentist / APPROVED settlement (`commission_entry_guard`); settlement state machine + frozen items/total, no overlapping periods per dentist, an entry settles once |
| Inventory | `InventoryItem`, `Supplier`, `StockReceipt`, `StockMovement`, `StockBalance`, `StockTransfer`, `StockTransferLine` | `StockMovement` append-only; **`stock_movement_apply` (SECURITY DEFINER) maintains `StockBalance`** (no negative unless `allowOverdraw`, batch check, weighted-average cost, `balanceAfter`); the app role cannot write `StockBalance`; transfer movements reconciled: OUT ≤ line quantity, IN needs an OUT, IN ≤ OUT, IN cost = OUT cost (`stock_movement_transfer_guard`); each (transfer, item, batch, kind) once |
| Notifications | `NotificationTemplate(+Version)`, `NotificationOutbox`, `NotificationDeliveryEvent`, `RecallSetting` | versions + delivery events append-only; outbox identity frozen, only QUEUED changes status, `(tenantId, idempotencyKey)` unique, address-format CHECK, `lastError` ≤ 500 chars |
| All 26 tables | | FORCE RLS + `tenant_isolation` (`app_tenant_id()`), composite `(tenantId, …)` FKs binding patient / branch wherever a link crosses entities |

Append-only for `dentalos_app` (no UPDATE/DELETE): `PaymentAllocation`, `PaymentGatewayEvent`, `InvoiceAdjustment`, `FinanceLedgerEntry`,
`PatientCreditEntry`, `CommissionEntry`, `StockMovement`, `StockReceipt`, `NotificationTemplateVersion`, `NotificationDeliveryEvent`
(plus `StockBalance`: no writes at all). No DELETE: `Invoice`, `InvoiceCounter`, `Payment`, `Refund`, `CommissionRule`, `InventoryItem`, `Supplier`,
`StockTransfer`, `StockTransferLine`, `NotificationTemplate`, `NotificationOutbox`, `RecallSetting`. DELETE only while DRAFT (trigger):
`InvoiceLine`, `CommissionSettlement`, `CommissionSettlementItem`.

## Suggested routes (Wave 1 may refine; report the final list)
Permissions per ADR 0004 §12 and `docs/permissions.md`; branch-scoped permissions are checked against the resource's branch.

| Area | Routes | DTOs (`@dentalos/validation`) | Permission |
|---|---|---|---|
| Settings | `GET/PATCH /billing/settings?branchId=`, `PUT /services/:id/tax-profile` | `billingSettingsQuery/Response`, `update{Tenant,Branch}BillingSettingsRequest`, `updateServiceTaxProfileRequest`, `serviceTaxProfileResponse` | `billing:read` / `org:manage` (tenant) · `branch:manage` (branch) · `catalog:manage` |
| Estimates | `GET /estimates?planId=&planVersion=` | `estimateQuery`, `estimateResponse` | `billing:read` + `plan:read` |
| Invoices | `GET/POST /invoices`, `POST /invoices/from-plan`, `GET/PATCH /invoices/:id`, `POST /invoices/:id/{issue,void}`, `PUT /invoices/:id/discount`, `GET /invoices/:id/print` | `listInvoicesQuery`, `createInvoiceRequest`, `createInvoiceFromPlanRequest`, `updateInvoiceRequest`, `setInvoiceDiscountRequest`, `issueInvoiceRequest`, `voidInvoiceRequest`, `invoiceSummary`, `invoiceResponse`, `invoiceDetailResponse`, `invoicePrintResponse` | `billing:read` / `invoice:write` (+ `discount:apply`) |
| Lines | `POST /invoices/:id/lines`, `PATCH/DELETE /invoices/:id/lines/:lineId` | `invoiceLineInput`, `updateInvoiceLineRequest`, `invoiceLineResponse` | `invoice:write` (+ `discount:apply` for discounts) |
| Payments | `GET/POST /payments`, `GET /payments/:id`, `POST /payments/:id/allocate`, `POST /patients/:id/advance/apply` | `listPaymentsQuery`, `recordPaymentRequest`, `allocatePaymentRequest`, `applyAdvanceRequest`, `paymentResponse`, `paymentDetailResponse` | `billing:read` / `payment:record` |
| Gateway | `POST /payments/gateway/checkout`, `POST /webhooks/payments/:gateway/:tenantId` (no staff auth; signed) | `createGatewayCheckoutRequest`, `gatewayCheckoutResponse`, `gatewayWebhookPayload`, `GATEWAY_SIGNATURE_HEADER` | `payment:record` / webhook signature |
| Refunds | `GET/POST /refunds`, `POST /refunds/:id/{approve,reject,process}` | `listRefundsQuery`, `requestRefundRequest`, `approveRefundRequest`, `rejectRefundRequest`, `processRefundRequest`, `refundResponse` | `refund:issue` (request, process) / `refund:approve` |
| Notes | `GET /adjustments`, `POST /invoices/:id/adjustments` | `listAdjustmentsQuery`, `issueAdjustmentRequest`, `adjustmentResponse` | `billing:read` / `invoice:adjust` |
| Patient account | `GET /patients/:id/credit`, `POST /patients/:id/credit/adjust`, `GET /patients/:id/statement` | `patientCreditResponse`, `adjustPatientCreditRequest`, `patientStatementQuery/Response` | `billing:read` / `finance:report` |
| Reports | `GET /reports/revenue` | `revenueReportQuery`, `revenueReportResponse` | `finance:report` |
| Commission rules | `GET/POST /commission-rules`, `POST /commission-rules/:id/{supersede,close}` | `listCommissionRulesQuery`, `createCommissionRuleRequest`, `supersede/closeCommissionRuleRequest`, `commissionRuleResponse` | `compensation:manage` (read: + `compensation:read`) |
| Commission ledger | `GET /commission-entries`, `POST /commission-entries/adjustments` | `listCommissionEntriesQuery`, `commissionEntryResponse`, `createCommissionAdjustmentRequest` | `compensation:read` (self) / `compensation:manage` |
| Settlements | `GET/POST /commission-settlements`, `GET/DELETE /commission-settlements/:id`, `POST /commission-settlements/:id/{approve,pay}` | `createSettlementRequest`, `approve/paySettlementRequest`, `listSettlementsQuery`, `settlementResponse`, `settlementDetailResponse` | `compensation:manage` / `compensation:settle` (approve) |
| Statement | `GET /compensation/statement` | `dentistStatementQuery`, `dentistStatementResponse` | `compensation:read` (self for dentists) |
| Items / suppliers | `GET/POST /inventory/items`, `GET/PATCH /inventory/items/:id`, `GET/POST /inventory/suppliers`, `PATCH /inventory/suppliers/:id` | `createInventoryItemRequest`, `updateInventoryItemRequest`, `listInventoryItemsQuery`, `inventoryItemResponse`, supplier DTOs | `inventory:read` / `inventory:write` |
| Stock movements | `POST /inventory/receipts`, `GET /inventory/receipts`, `POST /inventory/consumption`, `POST /inventory/adjustments`, `POST /inventory/waste`, `GET /inventory/movements` | `receiveStockRequest`, `stockReceiptResponse`, `consumeStockRequest`, `adjustStockRequest`, `recordWasteRequest`, `listStockMovementsQuery`, `stockMovementResponse` | `inventory:write` / `inventory:adjust` |
| Transfers | `GET/POST /inventory/transfers`, `POST /inventory/transfers/:id/receive` | `sendTransferRequest`, `receiveTransferRequest`, `listTransfersQuery`, `stockTransferResponse` | `inventory:transfer` |
| Balances | `GET /inventory/balances`, `GET /inventory/low-stock`, `GET /inventory/batches`, `GET /inventory/valuation` | `stockBalancesQuery`, `stockBalanceResponse`, `stockBatchesQuery`, `stockBatchResponse`, `stockValuation*` | `inventory:read` |
| Templates | `GET/POST /notification-templates`, `GET/PATCH /notification-templates/:id`, `POST /notification-templates/:id/versions`, `POST /notification-templates/preview` | `createNotificationTemplateRequest`, `updateNotificationTemplateRequest`, `publishNotificationTemplateVersionRequest`, `notificationTemplateResponse`, `previewNotificationTemplate*` | `comms:read` (list) / `comms:templates` |
| Outbox | `GET /notifications/outbox`, `POST /notifications/test`, `GET /notifications/preferences/check` | `listOutboxQuery`, `outboxResponse`, `sendTestNotificationRequest/Response`, `checkPreferencesQuery`, `preferenceCheckResponse` | `comms:read` / `comms:send` / `comms:templates` |
| Settings | `GET/PATCH /notifications/settings`, `GET/PUT /notifications/recall-settings` | `updateNotificationSettingsRequest`, `upsertRecallSettingRequest`, `listRecallSettingsQuery`, `recallSettingResponse` | `comms:templates` |
| Delivery webhook | `POST /webhooks/notifications/:provider/:tenantId` (signed) | `deliveryReceiptPayload` | webhook signature |

## Conventions (M3 additions)
All M1 + M2 conventions apply unchanged — see `docs/M1-org-patients.md` § "Conventions workers must follow" and `docs/M2-clinical.md`
(`withTenant` + actorId, `@Can` / `assertCan` / `branchWhere`, `ZodPipe`, composite FKs with both `tenantId` and the id, effective dating,
ids-only audit, no network I/O inside a transaction, user ids are IdP subjects). New in M3:

- **Idempotency keys**: every payment, refund and gateway-checkout request carries `idempotencyKey` (unique per tenant — `Payment`,
  `Refund`; outbox rows too). Look up first (`findUnique tenantId_idempotencyKey`): same key + same body → return the original (200/201 with
  the existing row); same key + different body → 409 `idempotency_conflict`; on the insert race catch `isUniqueViolation` and re-read. Jobs:
  `idempotencyKey` → pg-boss `singletonKey` and the outbox key. Webhooks: `PaymentGatewayEvent` / delivery event dedupe on provider `eventId`.
- **Append-only ledgers** (no UPDATE/DELETE for the app role, the DB refuses): `PaymentAllocation`, `InvoiceAdjustment`, `FinanceLedgerEntry`,
  `PatientCreditEntry`, `CommissionEntry`, `StockMovement`, `StockReceipt`, `NotificationTemplateVersion`, `NotificationDeliveryEvent`,
  `PaymentGatewayEvent`. Never "fix" a row: add the reversing / correcting row. **Never write `StockBalance`** — insert a `StockMovement`.
- **Issued-invoice immutability**: only the DB's `invoice_recalc()` moves `paid/adjustment/balance/status`; the API issues, voids, allocates, adjusts.
  Create the invoice as DRAFT with lines; issuing = one transaction: lock + validate → `allocate_document_seq` → compute `number` →
  `UPDATE Invoice SET status = 'ISSUED', number, issuedAt, issuedBy, supplier* , dueDate` (header already equals Σ lines) → `FinanceLedgerEntry(INVOICE)`
  → audit → afterwards enqueue the receipt/notification job. Void: reason + actor, only DRAFT / unpaid un-adjusted ISSUED.
- **Money maths** only through the pure helpers (`computeInvoiceTotals`, `computeGstLine`, `allocateInvoiceDiscount`, `mulDivRound*`); integer paise,
  half up per line, never floats. Price from `catalog/pricing.ts` (`overridesFor` + `effectivePrice`) at the branch, or the plan item's frozen estimate.
- **Allocation flow** (one transaction per payment): insert `Payment` (RECORDED, receipt number from `allocate_document_seq(…, 'RCP', fy)`) →
  allocations (the trigger recalculates invoices) → `PatientCreditEntry(ADVANCE)` for any unallocated remainder → `FinanceLedgerEntry(PAYMENT)` →
  commission accrual (C1 reads the new allocations: idempotent unique `(allocation, line)`) → audit → enqueue the receipt job.
- **Refund processing**: negative `PaymentAllocation` (when invoice-linked) *before* flipping the refund to PROCESSED, then `FinanceLedgerEntry(REFUND)`,
  commission `REVERSAL`s, audit. Payments are never reversed or edited (`payment_reversal_not_allowed`).
- **Commission**: accrue on allocation only; rule = the one in force on the invoice issue date (`selectCommissionRule`); amounts from
  `splitAllocationOverLines` + `computeLineCommission`; a missing rule or missing line dentist ⇒ no entry. Attribution comes from `InvoiceLine.dentistUserId` and is never rewritten.
- **Settlement**: create collects unsettled entries into items (total stored), approve (`compensation:settle`, different user when `separateApprover`),
  pay writes the `SETTLEMENT` entry then flips PAID (`settlement_guard` checks it exists).
- **Stock**: movements with signs per kind (DB CHECK); receipts need `unitCostPaise`; adjustments/waste need a reason; FEFO via `planFefoConsumption` over
  batch balances derived from the ledger (`SUM(quantity) GROUP BY batchNo, expiryDate`); transfers = TRANSFER_OUT rows at send, TRANSFER_IN rows +
  `receivedQuantity` + status flip at receive. Map `insufficient_stock` to 409.
- **Notifications**: always enqueue through the outbox service (decide consent with `resolveConsent`, quiet hours with `nextAllowedSendTime`, render with
  `renderTemplate` at send time) and a pg-boss job carrying **ids only**. Re-check consent at send time. `toAddress` and `variables` are personal data: never in
  job payloads, logs, audit or API responses (`maskAddress`). Console sender only; no external accounts.
- **Webhooks** (payments, delivery receipts): verify the HMAC signature on the raw body first (`parseWebhookSignatureHeader`, `isWebhookTimestampFresh`,
  constant-time compare; secret from env/secret store per tenant+provider, never `Tenant.settings`), then dedupe by event id, then act in `withTenant`.
- **Error codes to define in the API layer** (DB codes are mapped by `m3GuardError`): `BILLING_ERROR_CODES`, `COMMISSION_ERROR_CODES`, `INVENTORY_ERROR_CODES`,
  `NOTIFICATION_ERROR_CODES` (e.g. `idempotency_conflict`, `refund_approval_required`, `refund_self_approval`, `discount_*`, `plan_item_already_billed`,
  `settlement_self_approval`, `batch_required`, `template_placeholder_unknown`, `webhook_signature_invalid`). Validation errors stay 400 `validation_failed`.
- **Realtime**: optional `EventBus` events (ids/status only) for invoice/payment/refund changes and low stock; keep payloads id-only.
- **Audit**: every write and sensitive read (ADR 0004 §6) — ids only, never amounts' payer details, note text, addresses, message bodies or card data.
- **Settings**: read with `resolveBillingSettings(tenant.settings, branch.settings)` / `resolveNotificationSettings(tenant.settings)`; write
  `Tenant.settings` / `Branch.settings` only as `{ ...existing, billing | notifications }` validated by `tenantSettings` / `branchSettings`.

## Verification notes (Phase 0)
- Applied locally: `cd packages/db && DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dentalos bunx prisma migrate deploy && bunx prisma generate`.
- Ad-hoc behaviour probes (psql as `dentalos_app` against a scratch database, then deleted): numbering, issue-time totals check, immutability, allocation /
  refund / credit-note arithmetic and guards, advance floor, commission rule and settlement guards, stock balance + FEFO batch guard + transfers, outbox guards,
  append-only grants, cross-tenant RLS and the `tenant_mismatch` guard — all behaved as specified above.
