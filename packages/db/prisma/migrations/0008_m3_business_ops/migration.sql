-- M3: business operations — billing (invoices, payments, refunds, adjustments, ledgers), dentist
-- compensation (commission rules, ledger, settlements), inventory (items, suppliers, receipts, stock
-- ledger + balance, transfers) and notifications (templates, outbox, delivery events, recall settings)
-- (PRD 4.6–4.8, 2.5, 7.5, 9.2, 11). Domain rules are the PROPOSED defaults of
-- docs/adr/0004-business-operations-rules.md (pending product sign-off).
-- Prisma-generated DDL below is followed by hand-written constraints, exclusion constraints, triggers,
-- append-only grants and RLS — same conventions as 0004/0006 (docs/M1-org-patients.md, docs/M2-clinical.md).
--
-- Trigger errors are raised with SQLSTATE P0001 and a message prefixed by a stable code
-- (apps/api/src/common/db-errors.ts maps them): invoice_immutable, invoice_invalid_transition,
-- invoice_not_voidable, invoice_totals_mismatch, invoice_not_payable, invoice_not_adjustable,
-- invoice_overpaid, payment_immutable, payment_not_recorded, allocation_exceeds_payment,
-- refund_immutable, refund_exceeds_payment, refund_exceeds_allocation, refund_reversal_mismatch,
-- credit_insufficient, commission_rule_immutable, settlement_state, settlement_total_mismatch,
-- settlement_item_mismatch, insufficient_stock, stock_item_missing, stock_transfer_state,
-- notification_state, tenant_mismatch, credit_link_mismatch, commission_link_mismatch.

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'WALLET', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'PENDING', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AdjustmentKind" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "LedgerEntryKind" AS ENUM ('INVOICE', 'INVOICE_VOID', 'PAYMENT', 'REFUND', 'CREDIT_NOTE', 'DEBIT_NOTE');

-- CreateEnum
CREATE TYPE "CreditEntryKind" AS ENUM ('ADVANCE', 'APPLIED', 'REFUNDED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CommissionRuleType" AS ENUM ('PERCENT_OF_COLLECTED', 'PERCENT_OF_BILLED', 'FIXED_PER_PROCEDURE');

-- CreateEnum
CREATE TYPE "CommissionEntryKind" AS ENUM ('ACCRUAL', 'REVERSAL', 'ADJUSTMENT', 'SETTLEMENT');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');

-- CreateEnum
CREATE TYPE "InventoryUnit" AS ENUM ('PIECE', 'BOX', 'PACK', 'SET', 'VIAL', 'CARTRIDGE', 'GRAM', 'KILOGRAM', 'MILLILITRE', 'LITRE');

-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('WEIGHTED_AVERAGE');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('RECEIPT', 'CONSUMPTION', 'ADJUSTMENT', 'TRANSFER_OUT', 'TRANSFER_IN', 'WASTE');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('IN_TRANSIT', 'RECEIVED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED_NO_CONSENT', 'OPTED_OUT');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "gstRateBp" INTEGER,
ADD COLUMN     "hsnSac" TEXT;

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'INV',
    "financialYear" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestDedupe" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestDedupe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "number" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMPTZ(3),
    "issuedBy" TEXT,
    "dueDate" DATE,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "taxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "supplierGstin" TEXT,
    "supplierStateCode" TEXT,
    "placeOfSupplyStateCode" TEXT,
    "subtotalPaise" INTEGER NOT NULL,
    "discountPaise" INTEGER NOT NULL DEFAULT 0,
    "taxPaise" INTEGER NOT NULL DEFAULT 0,
    "totalPaise" INTEGER NOT NULL,
    "invoiceDiscountPaise" INTEGER NOT NULL DEFAULT 0,
    "invoiceDiscountPercentBp" INTEGER,
    "discountReason" TEXT,
    "discountAppliedBy" TEXT,
    "adjustmentPaise" INTEGER NOT NULL DEFAULT 0,
    "paidPaise" INTEGER NOT NULL DEFAULT 0,
    "balancePaise" INTEGER NOT NULL,
    "planId" UUID,
    "planVersion" INTEGER,
    "encounterId" UUID,
    "notes" TEXT,
    "voidReason" TEXT,
    "voidedBy" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "serviceId" UUID,
    "serviceCategoryId" UUID,
    "description" TEXT NOT NULL,
    "hsnSac" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPricePaise" INTEGER NOT NULL,
    "grossPaise" INTEGER NOT NULL,
    "discountPaise" INTEGER NOT NULL DEFAULT 0,
    "discountReason" TEXT,
    "allocatedDiscountPaise" INTEGER NOT NULL DEFAULT 0,
    "taxableValuePaise" INTEGER NOT NULL,
    "taxRateBp" INTEGER NOT NULL DEFAULT 0,
    "cgstPaise" INTEGER NOT NULL DEFAULT 0,
    "sgstPaise" INTEGER NOT NULL DEFAULT 0,
    "igstPaise" INTEGER NOT NULL DEFAULT 0,
    "totalPaise" INTEGER NOT NULL,
    "planItemId" UUID,
    "procedureRecordId" UUID,
    "encounterId" UUID,
    "dentistUserId" TEXT,
    "toothCode" SMALLINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "reference" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'MANUAL',
    "gatewayRef" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "receiptNumber" TEXT,
    "failureCode" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "refundId" UUID,
    "allocatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentGatewayEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "gateway" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentGatewayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID,
    "amountPaise" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectionReason" TEXT,
    "processedBy" TEXT,
    "processedAt" TIMESTAMPTZ(3),
    "idempotencyKey" TEXT NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'MANUAL',
    "gatewayRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceAdjustment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "kind" "AdjustmentKind" NOT NULL,
    "number" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "taxPaise" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceLedgerEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" "LedgerEntryKind" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "invoiceId" UUID,
    "paymentId" UUID,
    "refundId" UUID,
    "adjustmentId" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "FinanceLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientCreditEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "kind" "CreditEntryKind" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "paymentId" UUID,
    "allocationId" UUID,
    "refundId" UUID,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientCreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "dentistUserId" TEXT,
    "type" "CommissionRuleType" NOT NULL DEFAULT 'PERCENT_OF_COLLECTED',
    "percentBp" INTEGER,
    "fixedPaise" INTEGER,
    "serviceCategoryId" UUID,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedBy" TEXT,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "dentistUserId" TEXT NOT NULL,
    "kind" "CommissionEntryKind" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "baseAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "ruleId" UUID,
    "invoiceId" UUID,
    "invoiceLineId" UUID,
    "paymentAllocationId" UUID,
    "encounterId" UUID,
    "settlementId" UUID,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionSettlement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "dentistUserId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "totalPaise" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "paidBy" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "paymentReference" TEXT,
    "notes" TEXT,

    CONSTRAINT "CommissionSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionSettlementItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "amountPaise" INTEGER NOT NULL,

    CONSTRAINT "CommissionSettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "unit" "InventoryUnit" NOT NULL DEFAULT 'PIECE',
    "reorderLevel" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "costingMethod" "CostingMethod" NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
    "tracksBatches" BOOLEAN NOT NULL DEFAULT false,
    "allowOverdraw" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "supplierId" UUID,
    "reference" TEXT,
    "receivedOn" DATE NOT NULL,
    "totalCostPaise" INTEGER,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unitCostPaise" DECIMAL(14,4),
    "batchNo" TEXT,
    "expiryDate" DATE,
    "receiptId" UUID,
    "transferId" UUID,
    "procedureRecordId" UUID,
    "refType" TEXT,
    "refId" TEXT,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "balanceAfter" DECIMAL(14,3),

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "avgUnitCostPaise" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fromBranchId" UUID NOT NULL,
    "toBranchId" UUID NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "notes" TEXT,
    "sentBy" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "batchNo" TEXT,
    "expiryDate" DATE,
    "unitCostPaise" DECIMAL(14,4),
    "receivedQuantity" DECIMAL(14,3),

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "channel" "CommChannel" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "purpose" "CommPurpose" NOT NULL DEFAULT 'TRANSACTIONAL',
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "currentVersion" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplateVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "providerTemplateRef" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "patientId" UUID,
    "channel" "CommChannel" NOT NULL,
    "purpose" "CommPurpose" NOT NULL,
    "templateCode" TEXT NOT NULL,
    "templateVersionId" UUID NOT NULL,
    "toAddress" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "idempotencyKey" TEXT NOT NULL,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "deliveryStatus" TEXT,
    "deliveredAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "source" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDeliveryEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "outboxId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecallSetting" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecallSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceCounter_tenantId_idx" ON "InvoiceCounter"("tenantId");

-- CreateIndex
CREATE INDEX "RequestDedupe_tenantId_idx" ON "RequestDedupe"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RequestDedupe_tenantId_scope_idempotencyKey_key" ON "RequestDedupe"("tenantId", "scope", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCounter_tenantId_branchId_series_financialYear_key" ON "InvoiceCounter"("tenantId", "branchId", "series", "financialYear");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_idx" ON "Invoice"("tenantId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_branchId_status_idx" ON "Invoice"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_patientId_createdAt_idx" ON "Invoice"("tenantId", "patientId", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_status_dueDate_idx" ON "Invoice"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_planId_idx" ON "Invoice"("tenantId", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_id_key" ON "Invoice"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_id_patientId_key" ON "Invoice"("tenantId", "id", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_id_patientId_branchId_key" ON "Invoice"("tenantId", "id", "patientId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_idx" ON "InvoiceLine"("tenantId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_invoiceId_idx" ON "InvoiceLine"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_dentistUserId_idx" ON "InvoiceLine"("tenantId", "dentistUserId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_planItemId_idx" ON "InvoiceLine"("tenantId", "planItemId");

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_procedureRecordId_idx" ON "InvoiceLine"("tenantId", "procedureRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_tenantId_id_key" ON "InvoiceLine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_tenantId_invoiceId_id_key" ON "InvoiceLine"("tenantId", "invoiceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_tenantId_invoiceId_lineNo_key" ON "InvoiceLine"("tenantId", "invoiceId", "lineNo");

-- CreateIndex
CREATE INDEX "Payment_tenantId_idx" ON "Payment"("tenantId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_branchId_receivedAt_idx" ON "Payment"("tenantId", "branchId", "receivedAt");

-- CreateIndex
CREATE INDEX "Payment_tenantId_patientId_receivedAt_idx" ON "Payment"("tenantId", "patientId", "receivedAt");

-- CreateIndex
CREATE INDEX "Payment_tenantId_gateway_gatewayRef_idx" ON "Payment"("tenantId", "gateway", "gatewayRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_id_key" ON "Payment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_id_patientId_key" ON "Payment"("tenantId", "id", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_id_patientId_branchId_key" ON "Payment"("tenantId", "id", "patientId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_idempotencyKey_key" ON "Payment"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_receiptNumber_key" ON "Payment"("tenantId", "receiptNumber");

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_idx" ON "PaymentAllocation"("tenantId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_paymentId_idx" ON "PaymentAllocation"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_tenantId_invoiceId_idx" ON "PaymentAllocation"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_tenantId_id_key" ON "PaymentAllocation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PaymentGatewayEvent_tenantId_idx" ON "PaymentGatewayEvent"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentGatewayEvent_tenantId_gateway_eventId_key" ON "PaymentGatewayEvent"("tenantId", "gateway", "eventId");

-- CreateIndex
CREATE INDEX "Refund_tenantId_idx" ON "Refund"("tenantId");

-- CreateIndex
CREATE INDEX "Refund_tenantId_paymentId_idx" ON "Refund"("tenantId", "paymentId");

-- CreateIndex
CREATE INDEX "Refund_tenantId_branchId_status_idx" ON "Refund"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "Refund_tenantId_patientId_idx" ON "Refund"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_id_key" ON "Refund"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_id_paymentId_key" ON "Refund"("tenantId", "id", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_idempotencyKey_key" ON "Refund"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "InvoiceAdjustment_tenantId_idx" ON "InvoiceAdjustment"("tenantId");

-- CreateIndex
CREATE INDEX "InvoiceAdjustment_tenantId_invoiceId_idx" ON "InvoiceAdjustment"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceAdjustment_tenantId_branchId_issuedAt_idx" ON "InvoiceAdjustment"("tenantId", "branchId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceAdjustment_tenantId_id_key" ON "InvoiceAdjustment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceAdjustment_tenantId_number_key" ON "InvoiceAdjustment"("tenantId", "number");

-- CreateIndex
CREATE INDEX "FinanceLedgerEntry_tenantId_idx" ON "FinanceLedgerEntry"("tenantId");

-- CreateIndex
CREATE INDEX "FinanceLedgerEntry_tenantId_patientId_occurredAt_idx" ON "FinanceLedgerEntry"("tenantId", "patientId", "occurredAt");

-- CreateIndex
CREATE INDEX "FinanceLedgerEntry_tenantId_branchId_occurredAt_idx" ON "FinanceLedgerEntry"("tenantId", "branchId", "occurredAt");

-- CreateIndex
CREATE INDEX "FinanceLedgerEntry_tenantId_invoiceId_idx" ON "FinanceLedgerEntry"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "PatientCreditEntry_tenantId_idx" ON "PatientCreditEntry"("tenantId");

-- CreateIndex
CREATE INDEX "PatientCreditEntry_tenantId_patientId_createdAt_idx" ON "PatientCreditEntry"("tenantId", "patientId", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionRule_tenantId_idx" ON "CommissionRule"("tenantId");

-- CreateIndex
CREATE INDEX "CommissionRule_tenantId_dentistUserId_idx" ON "CommissionRule"("tenantId", "dentistUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionRule_tenantId_id_key" ON "CommissionRule"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CommissionEntry_tenantId_idx" ON "CommissionEntry"("tenantId");

-- CreateIndex
CREATE INDEX "CommissionEntry_tenantId_dentistUserId_createdAt_idx" ON "CommissionEntry"("tenantId", "dentistUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionEntry_tenantId_branchId_createdAt_idx" ON "CommissionEntry"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "CommissionEntry_tenantId_invoiceId_idx" ON "CommissionEntry"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "CommissionEntry_tenantId_paymentAllocationId_idx" ON "CommissionEntry"("tenantId", "paymentAllocationId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionEntry_tenantId_id_key" ON "CommissionEntry"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CommissionSettlement_tenantId_idx" ON "CommissionSettlement"("tenantId");

-- CreateIndex
CREATE INDEX "CommissionSettlement_tenantId_dentistUserId_status_idx" ON "CommissionSettlement"("tenantId", "dentistUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionSettlement_tenantId_id_key" ON "CommissionSettlement"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CommissionSettlementItem_tenantId_idx" ON "CommissionSettlementItem"("tenantId");

-- CreateIndex
CREATE INDEX "CommissionSettlementItem_tenantId_settlementId_idx" ON "CommissionSettlementItem"("tenantId", "settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionSettlementItem_tenantId_entryId_key" ON "CommissionSettlementItem"("tenantId", "entryId");

-- CreateIndex
CREATE INDEX "InventoryItem_tenantId_idx" ON "InventoryItem"("tenantId");

-- CreateIndex
CREATE INDEX "InventoryItem_tenantId_active_idx" ON "InventoryItem"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_tenantId_id_key" ON "InventoryItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_tenantId_sku_key" ON "InventoryItem"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "Supplier_tenantId_idx" ON "Supplier"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_id_key" ON "Supplier"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_name_key" ON "Supplier"("tenantId", "name");

-- CreateIndex
CREATE INDEX "StockReceipt_tenantId_idx" ON "StockReceipt"("tenantId");

-- CreateIndex
CREATE INDEX "StockReceipt_tenantId_branchId_receivedOn_idx" ON "StockReceipt"("tenantId", "branchId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "StockReceipt_tenantId_id_key" ON "StockReceipt"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockReceipt_tenantId_branchId_id_key" ON "StockReceipt"("tenantId", "branchId", "id");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_idx" ON "StockMovement"("tenantId");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_branchId_itemId_createdAt_idx" ON "StockMovement"("tenantId", "branchId", "itemId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_branchId_itemId_expiryDate_idx" ON "StockMovement"("tenantId", "branchId", "itemId", "expiryDate");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_procedureRecordId_idx" ON "StockMovement"("tenantId", "procedureRecordId");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_transferId_idx" ON "StockMovement"("tenantId", "transferId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_tenantId_id_key" ON "StockMovement"("tenantId", "id");

-- CreateIndex
CREATE INDEX "StockBalance_tenantId_idx" ON "StockBalance"("tenantId");

-- CreateIndex
CREATE INDEX "StockBalance_tenantId_itemId_idx" ON "StockBalance"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_tenantId_branchId_itemId_key" ON "StockBalance"("tenantId", "branchId", "itemId");

-- CreateIndex
CREATE INDEX "StockTransfer_tenantId_idx" ON "StockTransfer"("tenantId");

-- CreateIndex
CREATE INDEX "StockTransfer_tenantId_fromBranchId_status_idx" ON "StockTransfer"("tenantId", "fromBranchId", "status");

-- CreateIndex
CREATE INDEX "StockTransfer_tenantId_toBranchId_status_idx" ON "StockTransfer"("tenantId", "toBranchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_tenantId_id_key" ON "StockTransfer"("tenantId", "id");

-- CreateIndex
CREATE INDEX "StockTransferLine_tenantId_idx" ON "StockTransferLine"("tenantId");

-- CreateIndex
CREATE INDEX "StockTransferLine_tenantId_transferId_idx" ON "StockTransferLine"("tenantId", "transferId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferLine_tenantId_id_key" ON "StockTransferLine"("tenantId", "id");

-- CreateIndex
CREATE INDEX "NotificationTemplate_tenantId_idx" ON "NotificationTemplate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_tenantId_id_key" ON "NotificationTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_tenantId_code_channel_language_key" ON "NotificationTemplate"("tenantId", "code", "channel", "language");

-- CreateIndex
CREATE INDEX "NotificationTemplateVersion_tenantId_idx" ON "NotificationTemplateVersion"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplateVersion_tenantId_id_key" ON "NotificationTemplateVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplateVersion_tenantId_templateId_version_key" ON "NotificationTemplateVersion"("tenantId", "templateId", "version");

-- CreateIndex
CREATE INDEX "NotificationOutbox_tenantId_idx" ON "NotificationOutbox"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationOutbox_tenantId_status_scheduledFor_idx" ON "NotificationOutbox"("tenantId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "NotificationOutbox_tenantId_patientId_createdAt_idx" ON "NotificationOutbox"("tenantId", "patientId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationOutbox_tenantId_provider_providerMessageId_idx" ON "NotificationOutbox"("tenantId", "provider", "providerMessageId");

-- CreateIndex
CREATE INDEX "NotificationOutbox_tenantId_refType_refId_idx" ON "NotificationOutbox"("tenantId", "refType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_tenantId_id_key" ON "NotificationOutbox"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationOutbox_tenantId_idempotencyKey_key" ON "NotificationOutbox"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "NotificationDeliveryEvent_tenantId_idx" ON "NotificationDeliveryEvent"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationDeliveryEvent_tenantId_outboxId_occurredAt_idx" ON "NotificationDeliveryEvent"("tenantId", "outboxId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecallSetting_tenantId_idx" ON "RecallSetting"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecallSetting_tenantId_serviceId_key" ON "RecallSetting"("tenantId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcedureRecord_tenantId_id_key" ON "ProcedureRecord"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProcedureRecord_tenantId_id_patientId_key" ON "ProcedureRecord"("tenantId", "id", "patientId");

-- AddForeignKey
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_planId_patientId_fkey" FOREIGN KEY ("tenantId", "planId", "patientId") REFERENCES "TreatmentPlan"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_invoiceId_patientId_fkey" FOREIGN KEY ("tenantId", "invoiceId", "patientId") REFERENCES "Invoice"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_serviceId_fkey" FOREIGN KEY ("tenantId", "serviceId") REFERENCES "Service"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_serviceCategoryId_fkey" FOREIGN KEY ("tenantId", "serviceCategoryId") REFERENCES "ServiceCategory"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_planItemId_patientId_fkey" FOREIGN KEY ("tenantId", "planItemId", "patientId") REFERENCES "PlanItem"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_procedureRecordId_patientId_fkey" FOREIGN KEY ("tenantId", "procedureRecordId", "patientId") REFERENCES "ProcedureRecord"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_encounterId_patientId_fkey" FOREIGN KEY ("tenantId", "encounterId", "patientId") REFERENCES "Encounter"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_paymentId_patientId_branchId_fkey" FOREIGN KEY ("tenantId", "paymentId", "patientId", "branchId") REFERENCES "Payment"("tenantId", "id", "patientId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_invoiceId_patientId_branchId_fkey" FOREIGN KEY ("tenantId", "invoiceId", "patientId", "branchId") REFERENCES "Invoice"("tenantId", "id", "patientId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_refundId_paymentId_fkey" FOREIGN KEY ("tenantId", "refundId", "paymentId") REFERENCES "Refund"("tenantId", "id", "paymentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_paymentId_patientId_branchId_fkey" FOREIGN KEY ("tenantId", "paymentId", "patientId", "branchId") REFERENCES "Payment"("tenantId", "id", "patientId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_invoiceId_patientId_branchId_fkey" FOREIGN KEY ("tenantId", "invoiceId", "patientId", "branchId") REFERENCES "Invoice"("tenantId", "id", "patientId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_tenantId_invoiceId_patientId_branchId_fkey" FOREIGN KEY ("tenantId", "invoiceId", "patientId", "branchId") REFERENCES "Invoice"("tenantId", "id", "patientId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_tenantId_invoiceId_patientId_fkey" FOREIGN KEY ("tenantId", "invoiceId", "patientId") REFERENCES "Invoice"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_tenantId_paymentId_patientId_fkey" FOREIGN KEY ("tenantId", "paymentId", "patientId") REFERENCES "Payment"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_tenantId_refundId_fkey" FOREIGN KEY ("tenantId", "refundId") REFERENCES "Refund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_tenantId_adjustmentId_fkey" FOREIGN KEY ("tenantId", "adjustmentId") REFERENCES "InvoiceAdjustment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCreditEntry" ADD CONSTRAINT "PatientCreditEntry_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCreditEntry" ADD CONSTRAINT "PatientCreditEntry_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCreditEntry" ADD CONSTRAINT "PatientCreditEntry_tenantId_paymentId_patientId_fkey" FOREIGN KEY ("tenantId", "paymentId", "patientId") REFERENCES "Payment"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCreditEntry" ADD CONSTRAINT "PatientCreditEntry_tenantId_allocationId_fkey" FOREIGN KEY ("tenantId", "allocationId") REFERENCES "PaymentAllocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCreditEntry" ADD CONSTRAINT "PatientCreditEntry_tenantId_refundId_fkey" FOREIGN KEY ("tenantId", "refundId") REFERENCES "Refund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_tenantId_serviceCategoryId_fkey" FOREIGN KEY ("tenantId", "serviceCategoryId") REFERENCES "ServiceCategory"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_tenantId_ruleId_fkey" FOREIGN KEY ("tenantId", "ruleId") REFERENCES "CommissionRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_tenantId_invoiceId_invoiceLineId_fkey" FOREIGN KEY ("tenantId", "invoiceId", "invoiceLineId") REFERENCES "InvoiceLine"("tenantId", "invoiceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_tenantId_paymentAllocationId_fkey" FOREIGN KEY ("tenantId", "paymentAllocationId") REFERENCES "PaymentAllocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_tenantId_encounterId_fkey" FOREIGN KEY ("tenantId", "encounterId") REFERENCES "Encounter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_tenantId_settlementId_fkey" FOREIGN KEY ("tenantId", "settlementId") REFERENCES "CommissionSettlement"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSettlement" ADD CONSTRAINT "CommissionSettlement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSettlementItem" ADD CONSTRAINT "CommissionSettlementItem_tenantId_settlementId_fkey" FOREIGN KEY ("tenantId", "settlementId") REFERENCES "CommissionSettlement"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionSettlementItem" ADD CONSTRAINT "CommissionSettlementItem_tenantId_entryId_fkey" FOREIGN KEY ("tenantId", "entryId") REFERENCES "CommissionEntry"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "InventoryItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_branchId_receiptId_fkey" FOREIGN KEY ("tenantId", "branchId", "receiptId") REFERENCES "StockReceipt"("tenantId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "StockTransfer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_procedureRecordId_fkey" FOREIGN KEY ("tenantId", "procedureRecordId") REFERENCES "ProcedureRecord"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "InventoryItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_tenantId_fromBranchId_fkey" FOREIGN KEY ("tenantId", "fromBranchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_tenantId_toBranchId_fkey" FOREIGN KEY ("tenantId", "toBranchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "StockTransfer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "InventoryItem"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTemplateVersion" ADD CONSTRAINT "NotificationTemplateVersion_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "NotificationTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_tenantId_templateVersionId_fkey" FOREIGN KEY ("tenantId", "templateVersionId") REFERENCES "NotificationTemplateVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_tenantId_outboxId_fkey" FOREIGN KEY ("tenantId", "outboxId") REFERENCES "NotificationOutbox"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecallSetting" ADD CONSTRAINT "RecallSetting_tenantId_serviceId_fkey" FOREIGN KEY ("tenantId", "serviceId") REFERENCES "Service"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Integrity constraints Prisma cannot express
-- ---------------------------------------------------------------------------------------------

-- Service: GST classification (both optional).
ALTER TABLE "Service" ADD CONSTRAINT "Service_hsn_sac_chk" CHECK ("hsnSac" IS NULL OR "hsnSac" ~ '^[0-9]{4,8}$');
ALTER TABLE "Service" ADD CONSTRAINT "Service_gst_rate_chk" CHECK ("gstRateBp" IS NULL OR "gstRateBp" BETWEEN 0 AND 10000);

-- Document counters (gap-free numbering; see allocate_document_seq below).
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_series_chk" CHECK ("series" IN ('INV', 'CN', 'DN', 'RCP'));
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_fy_chk" CHECK ("financialYear" ~ '^[0-9]{2}-[0-9]{2}$');
ALTER TABLE "InvoiceCounter" ADD CONSTRAINT "InvoiceCounter_next_chk" CHECK ("next" >= 1);

-- Invoice. Amounts: total = subtotal − discount (+ GST when prices are tax-exclusive);
-- balance = total + adjustments − paid and never negative (an over-payment / over-large credit note fails).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_currency_chk" CHECK ("currency" = 'INR');
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_number_chk" CHECK ("number" IS NULL OR length(btrim("number")) > 0);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_issue_pair_chk"
  CHECK (("number" IS NULL) = ("issuedAt" IS NULL) AND ("issuedAt" IS NULL) = ("issuedBy" IS NULL));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_amounts_chk" CHECK (
      "subtotalPaise" >= 0 AND "discountPaise" >= 0 AND "taxPaise" >= 0 AND "totalPaise" >= 0
  AND "discountPaise" <= "subtotalPaise"
  AND "invoiceDiscountPaise" >= 0 AND "invoiceDiscountPaise" <= "discountPaise"
  AND ("invoiceDiscountPercentBp" IS NULL OR "invoiceDiscountPercentBp" BETWEEN 0 AND 10000));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_total_chk" CHECK (
  "totalPaise" = "subtotalPaise" - "discountPaise" + (CASE WHEN "taxInclusive" THEN 0 ELSE "taxPaise" END));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paid_chk" CHECK ("paidPaise" >= 0);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_balance_chk"
  CHECK ("balancePaise" = "totalPaise" + "adjustmentPaise" - "paidPaise" AND "balancePaise" >= 0);
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_discount_reason_chk" CHECK (
  "invoiceDiscountPaise" = 0 OR (length(btrim(coalesce("discountReason", ''))) > 0 AND "discountAppliedBy" IS NOT NULL));
-- Status shape: DRAFT and VOID hold no money; ISSUED is unpaid with a balance; PARTIALLY_PAID is mid-way;
-- PAID has a zero balance (a zero-total or fully credited invoice is PAID).
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_status_chk" CHECK (
     ("status" = 'DRAFT' AND "number" IS NULL AND "paidPaise" = 0 AND "adjustmentPaise" = 0)
  OR ("status" = 'VOID' AND "paidPaise" = 0 AND "adjustmentPaise" = 0)
  OR ("status" = 'ISSUED' AND "number" IS NOT NULL AND "paidPaise" = 0 AND "balancePaise" > 0)
  OR ("status" = 'PARTIALLY_PAID' AND "number" IS NOT NULL AND "paidPaise" > 0 AND "balancePaise" > 0)
  OR ("status" = 'PAID' AND "number" IS NOT NULL AND "balancePaise" = 0));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_void_chk" CHECK (
     ("status" = 'VOID' AND length(btrim(coalesce("voidReason", ''))) > 0
        AND "voidedBy" IS NOT NULL AND "voidedAt" IS NOT NULL)
  OR ("status" <> 'VOID' AND "voidReason" IS NULL AND "voidedBy" IS NULL AND "voidedAt" IS NULL));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_gst_chk" CHECK (
      ("supplierGstin" IS NULL OR "supplierGstin" ~ '^[0-9]{2}[A-Z0-9]{13}$')
  AND ("supplierStateCode" IS NULL OR "supplierStateCode" ~ '^[0-9]{2}$')
  AND ("placeOfSupplyStateCode" IS NULL OR "placeOfSupplyStateCode" ~ '^[0-9]{2}$'));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_plan_version_chk"
  CHECK ("planVersion" IS NULL OR ("planId" IS NOT NULL AND "planVersion" >= 1));

-- Invoice lines.
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_no_chk" CHECK ("lineNo" >= 1);
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_description_chk" CHECK (length(btrim("description")) > 0);
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_quantity_chk" CHECK ("quantity" BETWEEN 1 AND 10000);
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_gross_chk"
  CHECK ("unitPricePaise" >= 0 AND "grossPaise"::bigint = "quantity"::bigint * "unitPricePaise"::bigint);
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_discount_chk" CHECK (
      "discountPaise" >= 0 AND "allocatedDiscountPaise" >= 0
  AND "discountPaise" + "allocatedDiscountPaise" <= "grossPaise"
  AND ("discountPaise" = 0 OR length(btrim(coalesce("discountReason", ''))) > 0));
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tax_chk" CHECK (
      "taxRateBp" BETWEEN 0 AND 10000
  AND "taxableValuePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0
  AND ("igstPaise" = 0 OR ("cgstPaise" = 0 AND "sgstPaise" = 0))
  AND "sgstPaise" - "cgstPaise" IN (0, 1)
  AND ("taxRateBp" > 0 OR "cgstPaise" + "sgstPaise" + "igstPaise" = 0));
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_total_chk"
  CHECK ("totalPaise" = "taxableValuePaise" + "cgstPaise" + "sgstPaise" + "igstPaise");
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_hsn_chk" CHECK ("hsnSac" IS NULL OR "hsnSac" ~ '^[0-9]{4,8}$');
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tooth_chk" CHECK ("toothCode" IS NULL OR fdi_valid_tooth("toothCode"));

-- Payments. Manual payments are born RECORDED; only gateway payments can be PENDING / FAILED.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_chk" CHECK ("amountPaise" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_idem_chk" CHECK (length(btrim("idempotencyKey")) > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_gateway_chk" CHECK (length(btrim("gateway")) > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_manual_recorded_chk" CHECK ("gateway" <> 'MANUAL' OR "status" = 'RECORDED');
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_receipt_chk" CHECK (("status" = 'RECORDED') = ("receiptNumber" IS NOT NULL));
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_failure_chk" CHECK ("failureCode" IS NULL OR "status" = 'FAILED');

-- Allocations: > 0 applies money, < 0 reverses it for a refund (refundId) — never zero.
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_amount_chk"
  CHECK ("amountPaise" <> 0 AND (("amountPaise" > 0) = ("refundId" IS NULL)));

ALTER TABLE "PaymentGatewayEvent" ADD CONSTRAINT "PaymentGatewayEvent_text_chk"
  CHECK (length(btrim("gateway")) > 0 AND length(btrim("eventId")) > 0);

-- Refunds: money columns are frozen by trigger; status shape here.
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_chk" CHECK ("amountPaise" > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_reason_chk" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_idem_chk" CHECK (length(btrim("idempotencyKey")) > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_status_chk" CHECK (
     ("status" = 'REQUESTED' AND "approvedBy" IS NULL AND "approvedAt" IS NULL
        AND "rejectedBy" IS NULL AND "processedBy" IS NULL AND "processedAt" IS NULL)
  OR ("status" = 'APPROVED' AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL
        AND "rejectedBy" IS NULL AND "processedBy" IS NULL AND "processedAt" IS NULL)
  OR ("status" = 'PROCESSED' AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL
        AND "processedBy" IS NOT NULL AND "processedAt" IS NOT NULL AND "rejectedBy" IS NULL)
  OR ("status" = 'REJECTED' AND "rejectedBy" IS NOT NULL AND "rejectedAt" IS NOT NULL
        AND length(btrim(coalesce("rejectionReason", ''))) > 0
        AND "processedBy" IS NULL AND "processedAt" IS NULL));

-- Credit / debit notes.
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_amount_chk"
  CHECK ("amountPaise" > 0 AND "taxPaise" >= 0 AND "taxPaise" <= "amountPaise");
ALTER TABLE "InvoiceAdjustment" ADD CONSTRAINT "InvoiceAdjustment_text_chk"
  CHECK (length(btrim("reason")) > 0 AND length(btrim("number")) > 0);

-- Finance ledger: sign and source reference per kind.
ALTER TABLE "FinanceLedgerEntry" ADD CONSTRAINT "FinanceLedgerEntry_kind_chk" CHECK (
     ("kind" = 'INVOICE' AND "amountPaise" >= 0 AND "invoiceId" IS NOT NULL)
  OR ("kind" = 'INVOICE_VOID' AND "amountPaise" <= 0 AND "invoiceId" IS NOT NULL)
  OR ("kind" = 'PAYMENT' AND "amountPaise" < 0 AND "paymentId" IS NOT NULL)
  OR ("kind" = 'REFUND' AND "amountPaise" > 0 AND "refundId" IS NOT NULL)
  OR ("kind" = 'CREDIT_NOTE' AND "amountPaise" < 0 AND "adjustmentId" IS NOT NULL)
  OR ("kind" = 'DEBIT_NOTE' AND "amountPaise" > 0 AND "adjustmentId" IS NOT NULL));

-- Patient credit (advance) ledger.
ALTER TABLE "PatientCreditEntry" ADD CONSTRAINT "PatientCreditEntry_kind_chk" CHECK (
     ("kind" = 'ADVANCE' AND "amountPaise" > 0 AND "paymentId" IS NOT NULL)
  OR ("kind" = 'APPLIED' AND "amountPaise" < 0 AND "allocationId" IS NOT NULL)
  OR ("kind" = 'REFUNDED' AND "amountPaise" < 0 AND "refundId" IS NOT NULL)
  OR ("kind" = 'ADJUSTMENT' AND "amountPaise" <> 0 AND length(btrim(coalesce("reason", ''))) > 0));

-- Commission rules.
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_shape_chk" CHECK (
     ("type" IN ('PERCENT_OF_COLLECTED', 'PERCENT_OF_BILLED')
        AND "percentBp" BETWEEN 0 AND 10000 AND "fixedPaise" IS NULL)
  OR ("type" = 'FIXED_PER_PROCEDURE' AND "fixedPaise" >= 0 AND "percentBp" IS NULL));
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_period_chk"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_end_pair_chk"
  CHECK (("effectiveTo" IS NULL) = ("endedBy" IS NULL));

-- Commission ledger: sign and references per kind.
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_kind_chk" CHECK (
     ("kind" = 'ACCRUAL' AND "amountPaise" > 0 AND "baseAmountPaise" >= 0 AND "ruleId" IS NOT NULL
        AND "invoiceId" IS NOT NULL AND "invoiceLineId" IS NOT NULL AND "paymentAllocationId" IS NOT NULL
        AND "settlementId" IS NULL)
  OR ("kind" = 'REVERSAL' AND "amountPaise" < 0 AND "baseAmountPaise" <= 0
        AND "invoiceId" IS NOT NULL AND "invoiceLineId" IS NOT NULL AND "paymentAllocationId" IS NOT NULL
        AND "settlementId" IS NULL)
  OR ("kind" = 'ADJUSTMENT' AND "amountPaise" <> 0 AND length(btrim(coalesce("reason", ''))) > 0
        AND "settlementId" IS NULL)
  OR ("kind" = 'SETTLEMENT' AND "amountPaise" < 0 AND "settlementId" IS NOT NULL));
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_line_invoice_chk"
  CHECK ("invoiceLineId" IS NULL OR "invoiceId" IS NOT NULL);
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_dentist_chk" CHECK (length(btrim("dentistUserId")) > 0);

-- Settlements.
ALTER TABLE "CommissionSettlement" ADD CONSTRAINT "CommissionSettlement_period_chk" CHECK ("periodEnd" > "periodStart");
ALTER TABLE "CommissionSettlement" ADD CONSTRAINT "CommissionSettlement_status_chk" CHECK (
     ("status" = 'DRAFT' AND "approvedBy" IS NULL AND "approvedAt" IS NULL AND "paidBy" IS NULL AND "paidAt" IS NULL)
  OR ("status" = 'APPROVED' AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL
        AND "paidBy" IS NULL AND "paidAt" IS NULL)
  OR ("status" = 'PAID' AND "approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL
        AND "paidBy" IS NOT NULL AND "paidAt" IS NOT NULL));

-- Inventory.
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_sku_upper_chk" CHECK ("sku" = upper("sku") AND length("sku") > 0);
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_name_chk" CHECK (length(btrim("name")) > 0);
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_reorder_chk" CHECK ("reorderLevel" >= 0);
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_name_chk" CHECK (length(btrim("name")) > 0);
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_gstin_chk" CHECK ("gstin" IS NULL OR "gstin" ~ '^[0-9]{2}[A-Z0-9]{13}$');
ALTER TABLE "StockReceipt" ADD CONSTRAINT "StockReceipt_total_chk" CHECK ("totalCostPaise" IS NULL OR "totalCostPaise" >= 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_sign_chk" CHECK (
     "quantity" <> 0
  AND ("kind" NOT IN ('RECEIPT', 'TRANSFER_IN') OR "quantity" > 0)
  AND ("kind" NOT IN ('CONSUMPTION', 'TRANSFER_OUT', 'WASTE') OR "quantity" < 0));
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reason_chk"
  CHECK ("kind" NOT IN ('ADJUSTMENT', 'WASTE') OR length(btrim(coalesce("reason", ''))) > 0);
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_cost_chk"
  CHECK (("unitCostPaise" IS NULL OR "unitCostPaise" >= 0) AND ("kind" <> 'RECEIPT' OR "unitCostPaise" IS NOT NULL));
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_links_chk" CHECK (
      (("kind" IN ('TRANSFER_OUT', 'TRANSFER_IN')) = ("transferId" IS NOT NULL))
  AND ("receiptId" IS NULL OR "kind" = 'RECEIPT')
  AND ("procedureRecordId" IS NULL OR "kind" = 'CONSUMPTION')
  AND ("batchNo" IS NULL OR length(btrim("batchNo")) > 0));
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_branches_chk" CHECK ("fromBranchId" <> "toBranchId");
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_status_chk" CHECK (
     ("status" = 'IN_TRANSIT' AND "receivedBy" IS NULL AND "receivedAt" IS NULL)
  OR ("status" = 'RECEIVED' AND "receivedBy" IS NOT NULL AND "receivedAt" IS NOT NULL));
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_qty_chk"
  CHECK ("quantity" > 0 AND ("receivedQuantity" IS NULL OR "receivedQuantity" >= 0)
         AND ("unitCostPaise" IS NULL OR "unitCostPaise" >= 0));

-- Notifications.
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_code_upper_chk"
  CHECK ("code" = upper("code") AND length("code") > 0);
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_language_chk"
  CHECK ("language" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$');
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_name_chk" CHECK (length(btrim("name")) > 0);
ALTER TABLE "NotificationTemplateVersion" ADD CONSTRAINT "NotificationTemplateVersion_chk"
  CHECK ("version" >= 1 AND length(btrim("body")) > 0);
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_address_chk" CHECK (
     ("channel" = 'EMAIL' AND "toAddress" LIKE '%@%')
  OR ("channel" <> 'EMAIL' AND "toAddress" ~ '^\+[0-9]{8,15}$'));
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_attempts_chk" CHECK ("attempts" >= 0);
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_error_chk"
  CHECK ("lastError" IS NULL OR length("lastError") <= 500);
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_idem_chk" CHECK (length(btrim("idempotencyKey")) > 0);
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_sent_chk"
  CHECK ("status" <> 'SENT' OR "sentAt" IS NOT NULL);
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_status_chk"
  CHECK (length(btrim("status")) > 0);
ALTER TABLE "RecallSetting" ADD CONSTRAINT "RecallSetting_interval_chk" CHECK ("intervalDays" BETWEEN 1 AND 3650);

-- ---------------------------------------------------------------------------------------------
-- Partial unique + exclusion constraints (one open row at a time; no overlapping periods)
-- ---------------------------------------------------------------------------------------------
-- One OPEN commission rule per scope (dentist or default × category or any); history is closed rows.
CREATE UNIQUE INDEX "CommissionRule_open_key" ON "CommissionRule"
  ("tenantId", (COALESCE("dentistUserId", '')), (COALESCE("serviceCategoryId", '00000000-0000-0000-0000-000000000000'::uuid)))
  WHERE "effectiveTo" IS NULL;
ALTER TABLE "CommissionRule" ADD CONSTRAINT "CommissionRule_scope_no_overlap"
  EXCLUDE USING gist ("tenantId" WITH =, (COALESCE("dentistUserId", '')) WITH =,
    (COALESCE("serviceCategoryId", '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange("effectiveFrom", "effectiveTo") WITH &&);
-- A dentist's settlement periods never overlap (a mistaken DRAFT is deleted, not left behind).
ALTER TABLE "CommissionSettlement" ADD CONSTRAINT "CommissionSettlement_no_overlap"
  EXCLUDE USING gist ("tenantId" WITH =, "dentistUserId" WITH =, daterange("periodStart", "periodEnd") WITH &&);
-- Idempotent accrual / reversal: one ledger row per (allocation row, invoice line); one payout per settlement.
CREATE UNIQUE INDEX "CommissionEntry_alloc_line_key" ON "CommissionEntry"("tenantId", "paymentAllocationId", "invoiceLineId")
  WHERE "kind" IN ('ACCRUAL', 'REVERSAL');
CREATE UNIQUE INDEX "CommissionEntry_payout_key" ON "CommissionEntry"("tenantId", "settlementId")
  WHERE "kind" = 'SETTLEMENT';
-- Retry safety for append-only writes that have no natural unique key (debit/credit notes, advance
-- application, credit / commission adjustments, settlements, stock receipts / consumption / transfers):
-- the service inserts a RequestDedupe row (refId = the id it pre-generated for the result) FIRST in the same
-- transaction; a unique violation (23505) means "replay: answer with the stored refId, write nothing".
ALTER TABLE "RequestDedupe" ADD CONSTRAINT "RequestDedupe_text_chk" CHECK (
  length(btrim("scope")) > 0 AND length(btrim("idempotencyKey")) > 0
  AND ("requestHash" IS NULL OR length("requestHash") <= 128));
-- Ledger integrity: an advance spent / refunded is tied to exactly one allocation / refund.
CREATE UNIQUE INDEX "PatientCreditEntry_allocation_once_key" ON "PatientCreditEntry"("tenantId", "allocationId")
  WHERE "allocationId" IS NOT NULL;
CREATE UNIQUE INDEX "PatientCreditEntry_refund_once_key" ON "PatientCreditEntry"("tenantId", "refundId")
  WHERE "refundId" IS NOT NULL;
-- FK columns the guards and reports filter on (the allocation / ledger tables grow without bound).
CREATE INDEX "PaymentAllocation_refund_idx" ON "PaymentAllocation"("tenantId", "refundId") WHERE "refundId" IS NOT NULL;
CREATE INDEX "PatientCreditEntry_payment_idx" ON "PatientCreditEntry"("tenantId", "paymentId") WHERE "paymentId" IS NOT NULL;
CREATE INDEX "FinanceLedgerEntry_payment_idx" ON "FinanceLedgerEntry"("tenantId", "paymentId") WHERE "paymentId" IS NOT NULL;
CREATE INDEX "FinanceLedgerEntry_refund_idx" ON "FinanceLedgerEntry"("tenantId", "refundId") WHERE "refundId" IS NOT NULL;
CREATE INDEX "FinanceLedgerEntry_adjustment_idx" ON "FinanceLedgerEntry"("tenantId", "adjustmentId") WHERE "adjustmentId" IS NOT NULL;
-- A transfer writes each (item, batch) once per direction.
CREATE UNIQUE INDEX "StockMovement_transfer_once_key" ON "StockMovement"
  ("tenantId", "transferId", "itemId", (COALESCE("batchNo", '')), "kind")
  WHERE "transferId" IS NOT NULL;
-- Worker poll: due, still-queued messages.
CREATE INDEX "NotificationOutbox_due_idx" ON "NotificationOutbox"("tenantId", "scheduledFor") WHERE "status" = 'QUEUED';

-- ---------------------------------------------------------------------------------------------
-- Gap-free document numbers. Call inside the issuing transaction: the counter row is locked FOR UPDATE
-- until commit, so concurrent issuers serialise and a rollback hands the number back (no gaps).
--   SELECT allocate_document_seq(:tenant, :branch, 'INV', '25-26');
-- Series: INV invoice, CN credit note, DN debit note, RCP payment receipt. SECURITY DEFINER (pinned to the
-- caller's tenant, fixed search_path): the app role can only read counters, so a counter can never be
-- rewound, skipped or seeded by hand (grants at the end of this file).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION allocate_document_seq(p_tenant uuid, p_branch uuid, p_series text, p_fy text)
RETURNS integer LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF p_tenant IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant_mismatch: counter requested for another tenant';
  END IF;
  -- The branch must belong to the caller's tenant (the composite FK enforces it too).
  INSERT INTO "InvoiceCounter" ("id", "tenantId", "branchId", "series", "financialYear", "next")
  VALUES (gen_random_uuid(), p_tenant, p_branch, p_series, p_fy, 1)
  ON CONFLICT ("tenantId", "branchId", "series", "financialYear") DO NOTHING;
  SELECT c."next" INTO n FROM "InvoiceCounter" c
   WHERE c."tenantId" = p_tenant AND c."branchId" = p_branch AND c."series" = p_series AND c."financialYear" = p_fy
   FOR UPDATE;
  UPDATE "InvoiceCounter" SET "next" = n + 1, "updatedAt" = now()
   WHERE "tenantId" = p_tenant AND "branchId" = p_branch AND "series" = p_series AND "financialYear" = p_fy;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Staff references: must be a CURRENT member when written (0007 tenant_member_guard). Commission and
-- settlement dentists are deliberately NOT guarded: a removed dentist still earns on old work.
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER tenant_member_guard_biu BEFORE INSERT OR UPDATE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('dentistUserId');
CREATE TRIGGER tenant_member_guard_biu BEFORE INSERT OR UPDATE ON "CommissionRule"
  FOR EACH ROW EXECUTE FUNCTION tenant_member_guard('dentistUserId');

-- ---------------------------------------------------------------------------------------------
-- Invoice integrity (PRD 2.5, 4.6, 7.5): issued invoices are immutable. Balance, paid amount, adjustments
-- and status follow ONLY from PaymentAllocation / InvoiceAdjustment inserts (invoice_recalc below).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n bigint; s_gross bigint; s_disc bigint; s_alloc bigint; s_tax bigint; s_total bigint;
  -- True only inside invoice_recalc (SECURITY DEFINER, so current_user is its owner, never the app role). A
  -- caller-settable session variable is NOT trusted: the app role also has no UPDATE privilege on the money
  -- columns (column grants at the end of this file), so paid / adjustments / balance cannot be forged.
  recalc boolean := current_user IS DISTINCT FROM 'dentalos_app';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'invoice_invalid_transition: an invoice is created as DRAFT';
    END IF;
    IF NEW."paidPaise" <> 0 OR NEW."adjustmentPaise" <> 0 THEN
      RAISE EXCEPTION 'invoice_invalid_transition: a new invoice has no payments or adjustments';
    END IF;
    NEW."balancePaise" := NEW."totalPaise"; -- derived: the app role cannot write the balance column on update
    RETURN NEW;
  END IF;

  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION 'invoice_immutable: invoice % cannot change tenant', OLD."id";
  END IF;

  IF OLD."status" = 'VOID' THEN
    RAISE EXCEPTION 'invoice_immutable: invoice % is void', OLD."id";
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' THEN
      NEW."balancePaise" := NEW."totalPaise"; -- a draft owes its total (derived, never written by the app)
      RETURN NEW;
    END IF;
    IF NEW."status" = 'VOID' THEN RETURN NEW; END IF;
    -- Issuing: DRAFT -> ISSUED, or DRAFT -> PAID only for a zero-total invoice (Invoice_status_chk gives a
    -- zero balance the PAID status). Never any other way into the paid states.
    IF NEW."status" NOT IN ('ISSUED', 'PAID') THEN
      RAISE EXCEPTION 'invoice_invalid_transition: DRAFT -> % is not allowed', NEW."status";
    END IF;
    -- The money followers start empty: nothing is paid or adjusted at issue; the balance is the total.
    IF NEW."paidPaise" <> 0 OR NEW."adjustmentPaise" <> 0 THEN
      RAISE EXCEPTION 'invoice_invalid_transition: an invoice is issued unpaid and unadjusted (paid %, adjustments %)',
        NEW."paidPaise", NEW."adjustmentPaise";
    END IF;
    NEW."balancePaise" := NEW."totalPaise";
    IF NEW."status" = 'PAID' AND NEW."totalPaise" <> 0 THEN
      RAISE EXCEPTION 'invoice_invalid_transition: DRAFT -> PAID is only for a zero-total invoice';
    END IF;
    -- Issuing: the header must equal the sum of its lines (the lines are frozen from here on).
    SELECT count(*), coalesce(sum(l."grossPaise"), 0), coalesce(sum(l."discountPaise" + l."allocatedDiscountPaise"), 0),
           coalesce(sum(l."allocatedDiscountPaise"), 0),
           coalesce(sum(l."cgstPaise" + l."sgstPaise" + l."igstPaise"), 0), coalesce(sum(l."totalPaise"), 0)
      INTO n, s_gross, s_disc, s_alloc, s_tax, s_total
      FROM "InvoiceLine" l WHERE l."tenantId" = OLD."tenantId" AND l."invoiceId" = OLD."id";
    IF n = 0 THEN
      RAISE EXCEPTION 'invoice_totals_mismatch: invoice % has no lines', OLD."id";
    END IF;
    IF s_gross <> NEW."subtotalPaise" OR s_disc <> NEW."discountPaise" OR s_alloc <> NEW."invoiceDiscountPaise"
       OR s_tax <> NEW."taxPaise" OR s_total <> NEW."totalPaise" THEN
      RAISE EXCEPTION 'invoice_totals_mismatch: invoice % header does not match its lines', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  -- OLD is ISSUED / PARTIALLY_PAID / PAID: only status, money followers, dueDate, notes and the void
  -- fields may change.
  IF (NEW."branchId", NEW."patientId", NEW."number", NEW."issuedAt", NEW."issuedBy", NEW."currency",
      NEW."taxInclusive", NEW."supplierGstin", NEW."supplierStateCode", NEW."placeOfSupplyStateCode",
      NEW."subtotalPaise", NEW."discountPaise", NEW."taxPaise", NEW."totalPaise", NEW."invoiceDiscountPaise",
      NEW."invoiceDiscountPercentBp", NEW."discountReason", NEW."discountAppliedBy", NEW."planId",
      NEW."planVersion", NEW."encounterId", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."branchId", OLD."patientId", OLD."number", OLD."issuedAt", OLD."issuedBy", OLD."currency",
      OLD."taxInclusive", OLD."supplierGstin", OLD."supplierStateCode", OLD."placeOfSupplyStateCode",
      OLD."subtotalPaise", OLD."discountPaise", OLD."taxPaise", OLD."totalPaise", OLD."invoiceDiscountPaise",
      OLD."invoiceDiscountPercentBp", OLD."discountReason", OLD."discountAppliedBy", OLD."planId",
      OLD."planVersion", OLD."encounterId", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'invoice_immutable: issued invoice % cannot be edited; issue a credit/debit note', OLD."id";
  END IF;
  IF (NEW."paidPaise", NEW."adjustmentPaise", NEW."balancePaise")
     IS DISTINCT FROM (OLD."paidPaise", OLD."adjustmentPaise", OLD."balancePaise") AND NOT recalc THEN
    RAISE EXCEPTION 'invoice_immutable: paid/balance of invoice % follow allocations and adjustments only', OLD."id";
  END IF;
  IF NEW."status" = 'VOID' THEN
    IF OLD."status" <> 'ISSUED' OR OLD."paidPaise" <> 0 OR OLD."adjustmentPaise" <> 0 THEN
      RAISE EXCEPTION 'invoice_not_voidable: invoice % has payments or adjustments; correct it with credit notes', OLD."id";
    END IF;
    RETURN NEW;
  END IF;
  -- Moving between the paid states is the recalculation's job alone (status follows the money).
  IF NEW."status" <> OLD."status" AND NOT recalc THEN
    RAISE EXCEPTION 'invoice_invalid_transition: % -> % follows allocations and adjustments only', OLD."status", NEW."status";
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'ISSUED' AND NEW."status" IN ('PARTIALLY_PAID', 'PAID'))
    OR (OLD."status" = 'PARTIALLY_PAID' AND NEW."status" IN ('ISSUED', 'PAID'))
    OR (OLD."status" = 'PAID' AND NEW."status" IN ('PARTIALLY_PAID', 'ISSUED'))) THEN
    RAISE EXCEPTION 'invoice_invalid_transition: % -> % is not allowed', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_guard_biu BEFORE INSERT OR UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION invoice_guard();

-- Lines exist only to describe a DRAFT: insert / update / delete while the invoice is DRAFT.
CREATE OR REPLACE FUNCTION invoice_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv_tenant uuid; inv_id uuid; st "InvoiceStatus";
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
                           OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId") THEN
    RAISE EXCEPTION 'invoice_immutable: line % cannot move to another invoice', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    inv_tenant := NEW."tenantId"; inv_id := NEW."invoiceId";
  ELSE
    inv_tenant := OLD."tenantId"; inv_id := OLD."invoiceId";
  END IF;
  SELECT i."status" INTO st FROM "Invoice" i WHERE i."tenantId" = inv_tenant AND i."id" = inv_id FOR SHARE;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'invoice_immutable: lines of % invoice % cannot change', coalesce(st::text, 'missing'), inv_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_guard_biud BEFORE INSERT OR UPDATE OR DELETE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION invoice_line_guard();

-- Recomputes paid / adjustments / balance / status of an invoice from its allocations and adjustments
-- (locks the invoice row). The only path that can change those columns: SECURITY DEFINER with a fixed
-- search_path and pinned to the caller's tenant; invoice_guard recognises it by current_user (not by a
-- session variable the caller could set) and the app role has no column-level UPDATE on the money columns.
CREATE OR REPLACE FUNCTION invoice_recalc(p_tenant uuid, p_invoice uuid) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv RECORD; v_paid bigint; v_adj bigint; v_bal bigint; v_status "InvoiceStatus";
BEGIN
  IF p_tenant IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant_mismatch: invoice recalculation requested for another tenant';
  END IF;
  SELECT i."id", i."status", i."totalPaise" INTO inv FROM "Invoice" i
   WHERE i."tenantId" = p_tenant AND i."id" = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_payable: invoice % not found', p_invoice;
  END IF;
  IF inv."status" IN ('DRAFT', 'VOID') THEN
    RAISE EXCEPTION 'invoice_not_payable: invoice % is %', p_invoice, inv."status";
  END IF;
  SELECT coalesce(sum(a."amountPaise"), 0) INTO v_paid FROM "PaymentAllocation" a
   WHERE a."tenantId" = p_tenant AND a."invoiceId" = p_invoice;
  SELECT coalesce(sum(CASE x."kind" WHEN 'DEBIT' THEN x."amountPaise" ELSE -x."amountPaise" END), 0) INTO v_adj
    FROM "InvoiceAdjustment" x WHERE x."tenantId" = p_tenant AND x."invoiceId" = p_invoice;
  v_bal := inv."totalPaise" + v_adj - v_paid;
  IF v_bal < 0 THEN
    RAISE EXCEPTION 'invoice_overpaid: invoice % would have balance % paise', p_invoice, v_bal;
  END IF;
  v_status := CASE WHEN v_bal = 0 THEN 'PAID' WHEN v_paid > 0 THEN 'PARTIALLY_PAID' ELSE 'ISSUED' END;
  UPDATE "Invoice" SET "paidPaise" = v_paid, "adjustmentPaise" = v_adj, "balancePaise" = v_bal,
         "status" = v_status, "updatedAt" = now()
   WHERE "tenantId" = p_tenant AND "id" = p_invoice;
END $$;

-- Credit / debit notes only on issued invoices. The invoice row is locked FOR UPDATE from the start (the AFTER
-- trigger's invoice_recalc needs it): a FOR SHARE here would deadlock two concurrent writers (40P01).
CREATE OR REPLACE FUNCTION adjustment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "InvoiceStatus";
BEGIN
  SELECT i."status" INTO st FROM "Invoice" i
   WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId" FOR UPDATE;
  IF st IS NULL OR st NOT IN ('ISSUED', 'PARTIALLY_PAID', 'PAID') THEN
    RAISE EXCEPTION 'invoice_not_adjustable: invoice % is %', NEW."invoiceId", coalesce(st::text, 'missing');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER adjustment_guard_bi BEFORE INSERT ON "InvoiceAdjustment"
  FOR EACH ROW EXECUTE FUNCTION adjustment_guard();
CREATE OR REPLACE FUNCTION adjustment_recalc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM invoice_recalc(NEW."tenantId", NEW."invoiceId");
  RETURN NULL;
END $$;
CREATE TRIGGER adjustment_recalc_ai AFTER INSERT ON "InvoiceAdjustment"
  FOR EACH ROW EXECUTE FUNCTION adjustment_recalc();

-- ---------------------------------------------------------------------------------------------
-- Payments, allocations, refunds (PRD 4.6). Lock order everywhere: Payment row, then Invoice row.
--   unallocated(payment) = amount − Σ PROCESSED refunds − Σ allocations (reversals are negative) >= 0
-- ---------------------------------------------------------------------------------------------

-- Payment: money columns never change; a PENDING gateway payment may become RECORDED or FAILED.
CREATE OR REPLACE FUNCTION payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'payment_immutable: payment % is % and cannot change', OLD."id", OLD."status";
  END IF;
  IF (NEW."tenantId", NEW."branchId", NEW."patientId", NEW."method", NEW."amountPaise", NEW."receivedBy",
      NEW."idempotencyKey", NEW."gateway", NEW."notes", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."branchId", OLD."patientId", OLD."method", OLD."amountPaise", OLD."receivedBy",
      OLD."idempotencyKey", OLD."gateway", OLD."notes", OLD."createdAt") THEN
    RAISE EXCEPTION 'payment_immutable: money columns of payment % cannot change', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_guard_bu BEFORE UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION payment_guard();

CREATE OR REPLACE FUNCTION allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pay RECORD; inv_status "InvoiceStatus"; refunded bigint; reserved bigint; allocated bigint; pair_net bigint;
  rf RECORD; rev bigint;
BEGIN
  SELECT p."amountPaise", p."status" INTO pay FROM "Payment" p
   WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId" FOR UPDATE;
  IF NOT FOUND OR pay."status" <> 'RECORDED' THEN
    RAISE EXCEPTION 'payment_not_recorded: payment % is not RECORDED', NEW."paymentId";
  END IF;
  SELECT coalesce(sum(r."amountPaise"), 0) INTO refunded FROM "Refund" r
   WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."status" = 'PROCESSED';
  -- A pending (REQUESTED / APPROVED) advance refund reserves its amount: that money can no longer be spent.
  SELECT coalesce(sum(r."amountPaise"), 0) INTO reserved FROM "Refund" r
   WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."invoiceId" IS NULL
     AND r."status" IN ('REQUESTED', 'APPROVED');
  SELECT coalesce(sum(a."amountPaise"), 0) + NEW."amountPaise" INTO allocated FROM "PaymentAllocation" a
   WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId";
  IF pay."amountPaise" - refunded - reserved - allocated < 0 THEN
    RAISE EXCEPTION 'allocation_exceeds_payment: payment % has only % paise unallocated',
      NEW."paymentId", pay."amountPaise" - refunded - reserved - (allocated - NEW."amountPaise");
  END IF;
  -- Locked FOR UPDATE (not SHARE): the AFTER trigger's invoice_recalc upgrades to it, and two concurrent
  -- allocations to one invoice must queue rather than deadlock. Lock order stays Payment, then Invoice.
  SELECT i."status" INTO inv_status FROM "Invoice" i
   WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId" FOR UPDATE;
  IF inv_status IS NULL OR inv_status IN ('DRAFT', 'VOID') THEN
    RAISE EXCEPTION 'invoice_not_payable: invoice % is %', NEW."invoiceId", coalesce(inv_status::text, 'missing');
  END IF;
  IF NEW."amountPaise" < 0 THEN
    SELECT coalesce(sum(a."amountPaise"), 0) + NEW."amountPaise" INTO pair_net FROM "PaymentAllocation" a
     WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId" AND a."invoiceId" = NEW."invoiceId";
    IF pair_net < 0 THEN
      RAISE EXCEPTION 'refund_reversal_mismatch: reversal exceeds what payment % allocated to invoice %',
        NEW."paymentId", NEW."invoiceId";
    END IF;
    SELECT r."status", r."invoiceId", r."amountPaise" INTO rf FROM "Refund" r
     WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."refundId" FOR SHARE;
    IF NOT FOUND OR rf."status" NOT IN ('APPROVED', 'PROCESSED') OR rf."invoiceId" IS DISTINCT FROM NEW."invoiceId" THEN
      RAISE EXCEPTION 'refund_reversal_mismatch: refund % does not authorise a reversal on invoice %',
        NEW."refundId", NEW."invoiceId";
    END IF;
    SELECT coalesce(sum(-a."amountPaise"), 0) - NEW."amountPaise" INTO rev FROM "PaymentAllocation" a
     WHERE a."tenantId" = NEW."tenantId" AND a."refundId" = NEW."refundId";
    IF rev > rf."amountPaise" THEN
      RAISE EXCEPTION 'refund_reversal_mismatch: reversals of refund % exceed its amount', NEW."refundId";
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_guard_bi BEFORE INSERT ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION allocation_guard();
CREATE OR REPLACE FUNCTION allocation_recalc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM invoice_recalc(NEW."tenantId", NEW."invoiceId");
  RETURN NULL;
END $$;
CREATE TRIGGER allocation_recalc_ai AFTER INSERT ON "PaymentAllocation"
  FOR EACH ROW EXECUTE FUNCTION allocation_recalc();

CREATE OR REPLACE FUNCTION refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pay RECORD; requested bigint; processed bigint; allocated bigint; pair_alloc bigint; pair_refunds bigint; rev bigint;
  need_rev bigint;
BEGIN
  SELECT p."amountPaise", p."status" INTO pay FROM "Payment" p
   WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId" FOR UPDATE;
  IF NOT FOUND OR pay."status" <> 'RECORDED' THEN
    RAISE EXCEPTION 'payment_not_recorded: payment % is not RECORDED', NEW."paymentId";
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('REQUESTED', 'APPROVED') THEN
      RAISE EXCEPTION 'refund_immutable: a refund is created REQUESTED (or APPROVED when below the threshold)';
    END IF;
    SELECT coalesce(sum(r."amountPaise"), 0) + NEW."amountPaise" INTO requested FROM "Refund" r
     WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."status" <> 'REJECTED';
    IF requested > pay."amountPaise" THEN
      RAISE EXCEPTION 'refund_exceeds_payment: refunds of payment % would total % of % paise',
        NEW."paymentId", requested, pay."amountPaise";
    END IF;
    IF NEW."invoiceId" IS NULL THEN
      -- Advance refund: must fit in what is still unallocated after other processed / pending advance refunds.
      SELECT coalesce(sum(r."amountPaise") FILTER (WHERE r."status" = 'PROCESSED'), 0)
             + coalesce(sum(r."amountPaise") FILTER (WHERE r."invoiceId" IS NULL AND r."status" IN ('REQUESTED', 'APPROVED')), 0)
        INTO processed FROM "Refund" r
       WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId";
      SELECT coalesce(sum(a."amountPaise"), 0) INTO allocated FROM "PaymentAllocation" a
       WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId";
      IF pay."amountPaise" - processed - allocated - NEW."amountPaise" < 0 THEN
        RAISE EXCEPTION 'refund_exceeds_payment: payment % has only % paise unallocated for an advance refund',
          NEW."paymentId", pay."amountPaise" - processed - allocated;
      END IF;
    END IF;
    IF NEW."invoiceId" IS NOT NULL THEN
      SELECT coalesce(sum(a."amountPaise") FILTER (WHERE a."amountPaise" > 0), 0) INTO pair_alloc
        FROM "PaymentAllocation" a
       WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId" AND a."invoiceId" = NEW."invoiceId";
      SELECT coalesce(sum(r."amountPaise"), 0) + NEW."amountPaise" INTO pair_refunds FROM "Refund" r
       WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."invoiceId" = NEW."invoiceId"
         AND r."status" <> 'REJECTED';
      IF pair_refunds > pair_alloc THEN
        RAISE EXCEPTION 'refund_exceeds_allocation: payment % allocated only % paise to invoice %',
          NEW."paymentId", pair_alloc, NEW."invoiceId";
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: identity and money are frozen; reference / gateway fields may be filled in.
  IF (NEW."tenantId", NEW."branchId", NEW."patientId", NEW."paymentId", NEW."invoiceId", NEW."amountPaise",
      NEW."method", NEW."reason", NEW."requestedBy", NEW."requestedAt", NEW."idempotencyKey", NEW."gateway",
      NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."branchId", OLD."patientId", OLD."paymentId", OLD."invoiceId", OLD."amountPaise",
      OLD."method", OLD."reason", OLD."requestedBy", OLD."requestedAt", OLD."idempotencyKey", OLD."gateway",
      OLD."createdAt") THEN
    RAISE EXCEPTION 'refund_immutable: identity and money columns of refund % cannot change', OLD."id";
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'REJECTED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('PROCESSED', 'REJECTED'))) THEN
    RAISE EXCEPTION 'refund_immutable: % -> % is not allowed', OLD."status", NEW."status";
  END IF;
  IF OLD."status" IN ('PROCESSED', 'REJECTED') THEN
    RAISE EXCEPTION 'refund_immutable: refund % is %', OLD."id", OLD."status";
  END IF;
  IF NEW."status" = 'PROCESSED' THEN
    SELECT coalesce(sum(r."amountPaise"), 0) + NEW."amountPaise" INTO processed FROM "Refund" r
     WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = NEW."paymentId" AND r."status" = 'PROCESSED'
       AND r."id" <> NEW."id";
    SELECT coalesce(sum(a."amountPaise"), 0) INTO allocated FROM "PaymentAllocation" a
     WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = NEW."paymentId";
    SELECT coalesce(sum(-a."amountPaise"), 0) INTO rev FROM "PaymentAllocation" a
     WHERE a."tenantId" = NEW."tenantId" AND a."refundId" = NEW."id";
    need_rev := CASE WHEN NEW."invoiceId" IS NULL THEN 0 ELSE NEW."amountPaise" END;
    IF rev <> need_rev THEN
      RAISE EXCEPTION 'refund_reversal_mismatch: refund % needs reversal allocations of % paise, found %',
        NEW."id", need_rev, rev;
    END IF;
    IF processed > pay."amountPaise" OR pay."amountPaise" - processed - allocated < 0 THEN
      RAISE EXCEPTION 'refund_exceeds_payment: payment % cannot refund % paise (processed %, allocated %)',
        NEW."paymentId", NEW."amountPaise", processed - NEW."amountPaise", allocated;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_guard_biu BEFORE INSERT OR UPDATE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION refund_guard();

-- Patient advance balance never goes negative; writers for one patient are serialised.
CREATE OR REPLACE FUNCTION patient_credit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bal bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('patient_credit:' || NEW."tenantId"::text || NEW."patientId"::text, 0));
  SELECT coalesce(sum(c."amountPaise"), 0) INTO bal FROM "PatientCreditEntry" c
   WHERE c."tenantId" = NEW."tenantId" AND c."patientId" = NEW."patientId";
  IF bal < 0 THEN
    RAISE EXCEPTION 'credit_insufficient: patient % advance balance would be % paise', NEW."patientId", bal;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER patient_credit_guard_ai AFTER INSERT ON "PatientCreditEntry"
  FOR EACH ROW EXECUTE FUNCTION patient_credit_guard();

-- Advance held for one payment = Σ ADVANCE − Σ spent on invoices (APPLIED, through the payment's allocations)
-- − Σ refunded (REFUNDED, through the payment's refunds). It can never exceed what the payment still has
-- unallocated, and never go below zero.
CREATE OR REPLACE FUNCTION payment_advance_held(p_tenant uuid, p_payment uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT sum(c."amountPaise") FROM "PatientCreditEntry" c
                    WHERE c."tenantId" = p_tenant AND c."kind" = 'ADVANCE' AND c."paymentId" = p_payment), 0)
       + coalesce((SELECT sum(c."amountPaise") FROM "PatientCreditEntry" c
                     JOIN "PaymentAllocation" a ON a."tenantId" = c."tenantId" AND a."id" = c."allocationId"
                    WHERE c."tenantId" = p_tenant AND c."kind" = 'APPLIED' AND a."paymentId" = p_payment), 0)
       + coalesce((SELECT sum(c."amountPaise") FROM "PatientCreditEntry" c
                     JOIN "Refund" r ON r."tenantId" = c."tenantId" AND r."id" = c."refundId"
                    WHERE c."tenantId" = p_tenant AND c."kind" = 'REFUNDED' AND r."paymentId" = p_payment), 0)
$$;

-- The advance ledger is tied to money: ADVANCE to a RECORDED payment of the same patient and branch (within its
-- unallocated amount), APPLIED to the allocation that spent it (same amount), REFUNDED to the advance refund of
-- the same patient (same amount). ADJUSTMENT (reason required) is the only free-standing kind.
CREATE OR REPLACE FUNCTION patient_credit_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pay RECORD; al RECORD; rf RECORD; pay_id uuid; held bigint; reserved bigint; processed bigint; allocated bigint;
BEGIN
  IF NEW."kind" = 'ADJUSTMENT' THEN RETURN NEW; END IF;

  IF NEW."kind" = 'ADVANCE' THEN
    pay_id := NEW."paymentId";
  ELSIF NEW."kind" = 'APPLIED' THEN
    SELECT a."paymentId", a."patientId", a."amountPaise", a."refundId" INTO al FROM "PaymentAllocation" a
     WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."allocationId";
    IF NOT FOUND OR al."patientId" <> NEW."patientId" OR al."amountPaise" <= 0 OR al."refundId" IS NOT NULL
       OR NEW."amountPaise" <> -al."amountPaise" OR (NEW."paymentId" IS NOT NULL AND NEW."paymentId" <> al."paymentId") THEN
      RAISE EXCEPTION 'credit_link_mismatch: APPLIED entry does not match allocation %', NEW."allocationId";
    END IF;
    pay_id := al."paymentId";
  ELSE
    SELECT r."paymentId", r."patientId", r."amountPaise", r."invoiceId", r."status" INTO rf FROM "Refund" r
     WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."refundId";
    IF NOT FOUND OR rf."patientId" <> NEW."patientId" OR rf."invoiceId" IS NOT NULL
       OR rf."status" NOT IN ('APPROVED', 'PROCESSED') OR NEW."amountPaise" <> -rf."amountPaise"
       OR (NEW."paymentId" IS NOT NULL AND NEW."paymentId" <> rf."paymentId") THEN
      RAISE EXCEPTION 'credit_link_mismatch: REFUNDED entry does not match advance refund %', NEW."refundId";
    END IF;
    pay_id := rf."paymentId";
  END IF;

  -- Payment first (the lock order everywhere is Payment, then Invoice).
  SELECT p."amountPaise", p."status", p."patientId", p."branchId" INTO pay FROM "Payment" p
   WHERE p."tenantId" = NEW."tenantId" AND p."id" = pay_id FOR UPDATE;
  IF NOT FOUND OR pay."status" <> 'RECORDED' OR pay."patientId" <> NEW."patientId" THEN
    RAISE EXCEPTION 'credit_link_mismatch: payment % is not a RECORDED payment of patient %', pay_id, NEW."patientId";
  END IF;

  held := payment_advance_held(NEW."tenantId", pay_id) + NEW."amountPaise";
  IF held < 0 THEN
    RAISE EXCEPTION 'credit_link_mismatch: % would take payment % advance below zero (% paise)', NEW."kind", pay_id, held;
  END IF;
  IF NEW."kind" = 'ADVANCE' THEN
    IF pay."branchId" <> NEW."branchId" THEN
      RAISE EXCEPTION 'credit_link_mismatch: advance branch differs from payment % branch', pay_id;
    END IF;
    SELECT coalesce(sum(r."amountPaise") FILTER (WHERE r."status" = 'PROCESSED'), 0)
           + coalesce(sum(r."amountPaise") FILTER (WHERE r."invoiceId" IS NULL AND r."status" IN ('REQUESTED', 'APPROVED')), 0)
      INTO processed FROM "Refund" r WHERE r."tenantId" = NEW."tenantId" AND r."paymentId" = pay_id;
    SELECT coalesce(sum(a."amountPaise"), 0) INTO allocated FROM "PaymentAllocation" a
     WHERE a."tenantId" = NEW."tenantId" AND a."paymentId" = pay_id;
    IF held > pay."amountPaise" - processed - allocated THEN
      RAISE EXCEPTION 'credit_link_mismatch: advance of % paise exceeds the % paise payment % has unallocated',
        NEW."amountPaise", pay."amountPaise" - processed - allocated, pay_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_credit_link_guard_bi BEFORE INSERT ON "PatientCreditEntry"
  FOR EACH ROW EXECUTE FUNCTION patient_credit_link_guard();

-- ---------------------------------------------------------------------------------------------
-- Dentist compensation (PRD 2.5, 4.6): a rule's basis never changes after creation (only closed);
-- settlements move DRAFT -> APPROVED -> PAID and freeze their items.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commission_rule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."tenantId", NEW."dentistUserId", NEW."type", NEW."percentBp", NEW."fixedPaise",
      NEW."serviceCategoryId", NEW."effectiveFrom", NEW."note", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."dentistUserId", OLD."type", OLD."percentBp", OLD."fixedPaise",
      OLD."serviceCategoryId", OLD."effectiveFrom", OLD."note", OLD."createdBy", OLD."createdAt")
     OR (OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo") THEN
    RAISE EXCEPTION 'commission_rule_immutable: rule % can only be closed, never changed', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_rule_guard_bu BEFORE UPDATE ON "CommissionRule"
  FOR EACH ROW EXECUTE FUNCTION commission_rule_guard();

-- The ledger rows are bound to their sources: an accrual / reversal sits on an allocation of ITS invoice and
-- branch, for the dentist of that invoice line (and a rule of that dentist or the default); a payout belongs to
-- an APPROVED settlement of that dentist for exactly its total. ADJUSTMENT (reason required) is free-standing.
CREATE OR REPLACE FUNCTION commission_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE al RECORD; ln RECORD; ru RECORD; st RECORD;
BEGIN
  IF NEW."kind" IN ('ACCRUAL', 'REVERSAL') THEN
    SELECT a."invoiceId", a."branchId", a."amountPaise" INTO al FROM "PaymentAllocation" a
     WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."paymentAllocationId";
    IF NOT FOUND OR al."invoiceId" <> NEW."invoiceId" OR al."branchId" <> NEW."branchId"
       OR (NEW."kind" = 'ACCRUAL' AND al."amountPaise" <= 0) OR (NEW."kind" = 'REVERSAL' AND al."amountPaise" >= 0) THEN
      RAISE EXCEPTION 'commission_link_mismatch: allocation % does not support a % on invoice %',
        NEW."paymentAllocationId", NEW."kind", NEW."invoiceId";
    END IF;
    SELECT l."dentistUserId" INTO ln FROM "InvoiceLine" l
     WHERE l."tenantId" = NEW."tenantId" AND l."invoiceId" = NEW."invoiceId" AND l."id" = NEW."invoiceLineId";
    IF NOT FOUND OR ln."dentistUserId" IS DISTINCT FROM NEW."dentistUserId" THEN
      RAISE EXCEPTION 'commission_link_mismatch: invoice line % is not attributed to dentist %',
        NEW."invoiceLineId", NEW."dentistUserId";
    END IF;
    IF NEW."ruleId" IS NOT NULL THEN
      SELECT r."dentistUserId" INTO ru FROM "CommissionRule" r WHERE r."tenantId" = NEW."tenantId" AND r."id" = NEW."ruleId";
      IF NOT FOUND OR (ru."dentistUserId" IS NOT NULL AND ru."dentistUserId" <> NEW."dentistUserId") THEN
        RAISE EXCEPTION 'commission_link_mismatch: rule % does not apply to dentist %', NEW."ruleId", NEW."dentistUserId";
      END IF;
    END IF;
  ELSIF NEW."kind" = 'SETTLEMENT' THEN
    SELECT s."dentistUserId", s."status", s."totalPaise" INTO st FROM "CommissionSettlement" s
     WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."settlementId" FOR SHARE;
    IF NOT FOUND OR st."status" <> 'APPROVED' OR st."dentistUserId" <> NEW."dentistUserId"
       OR NEW."amountPaise" <> -st."totalPaise" THEN
      RAISE EXCEPTION 'commission_link_mismatch: payout does not match the APPROVED settlement %', NEW."settlementId";
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_entry_guard_bi BEFORE INSERT ON "CommissionEntry"
  FOR EACH ROW EXECUTE FUNCTION commission_entry_guard();

CREATE OR REPLACE FUNCTION settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE items bigint; payout bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'settlement_state: settlement % is % and cannot be deleted', OLD."id", OLD."status";
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."tenantId", NEW."dentistUserId", NEW."periodStart", NEW."periodEnd", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."dentistUserId", OLD."periodStart", OLD."periodEnd", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'settlement_state: dentist and period of settlement % cannot change', OLD."id";
  END IF;
  IF OLD."status" <> 'DRAFT' AND NEW."totalPaise" <> OLD."totalPaise" THEN
    RAISE EXCEPTION 'settlement_state: total of % settlement % is frozen', OLD."status", OLD."id";
  END IF;
  IF NEW."status" <> OLD."status" THEN
    IF NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'APPROVED')
         OR (OLD."status" = 'APPROVED' AND NEW."status" = 'PAID')) THEN
      RAISE EXCEPTION 'settlement_state: % -> % is not allowed', OLD."status", NEW."status";
    END IF;
    IF NEW."status" = 'APPROVED' THEN
      SELECT coalesce(sum(i."amountPaise"), 0) INTO items FROM "CommissionSettlementItem" i
       WHERE i."tenantId" = NEW."tenantId" AND i."settlementId" = NEW."id";
      IF items <> NEW."totalPaise" THEN
        RAISE EXCEPTION 'settlement_total_mismatch: settlement % total % <> items %', NEW."id", NEW."totalPaise", items;
      END IF;
    ELSE
      SELECT coalesce(sum(e."amountPaise"), 0) INTO payout FROM "CommissionEntry" e
       WHERE e."tenantId" = NEW."tenantId" AND e."settlementId" = NEW."id" AND e."kind" = 'SETTLEMENT';
      IF payout <> -NEW."totalPaise" THEN
        RAISE EXCEPTION 'settlement_state: settlement % has no matching SETTLEMENT ledger entry', NEW."id";
      END IF;
    END IF;
  ELSIF OLD."status" <> 'DRAFT' AND (NEW."approvedBy", NEW."approvedAt", NEW."notes")
        IS DISTINCT FROM (OLD."approvedBy", OLD."approvedAt", OLD."notes") THEN
    RAISE EXCEPTION 'settlement_state: approved settlement % cannot be edited', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_guard_bud BEFORE UPDATE OR DELETE ON "CommissionSettlement"
  FOR EACH ROW EXECUTE FUNCTION settlement_guard();

CREATE OR REPLACE FUNCTION settlement_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "SettlementStatus"; dentist text; e RECORD;
BEGIN
  SELECT s."status", s."dentistUserId" INTO st, dentist FROM "CommissionSettlement" s
   WHERE s."tenantId" = coalesce(NEW."tenantId", OLD."tenantId")
     AND s."id" = coalesce(NEW."settlementId", OLD."settlementId") FOR SHARE;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'settlement_state: items of % settlement can no longer change', coalesce(st::text, 'missing');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'settlement_item_mismatch: settlement items are written once';
  END IF;
  SELECT c."dentistUserId", c."kind", c."amountPaise" INTO e FROM "CommissionEntry" c
   WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."entryId";
  IF NOT FOUND OR e."dentistUserId" <> dentist OR e."kind" = 'SETTLEMENT' OR e."amountPaise" <> NEW."amountPaise" THEN
    RAISE EXCEPTION 'settlement_item_mismatch: entry % does not belong in settlement % of dentist %',
      NEW."entryId", NEW."settlementId", dentist;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_item_guard_biud BEFORE INSERT OR UPDATE OR DELETE ON "CommissionSettlementItem"
  FOR EACH ROW EXECUTE FUNCTION settlement_item_guard();

-- ---------------------------------------------------------------------------------------------
-- Inventory (PRD 4.8). Every StockMovement insert atomically updates the (branch, item) StockBalance:
-- refuses a negative balance unless the item allows overdraw, keeps the weighted-average cost, stamps the
-- movement with the cost (outflows use the average) and the balance after it. SECURITY DEFINER so the app
-- role needs no write access to StockBalance (it cannot be edited by hand); it is pinned to the caller's
-- tenant (app.tenant_id) and a fixed search_path.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_movement_apply() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  item RECORD; bal RECORD; new_qty numeric(14,3); new_avg numeric(14,4); cost numeric(14,4); batch_qty numeric;
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM app_tenant_id() THEN
    RAISE EXCEPTION 'tenant_mismatch: stock movement for another tenant';
  END IF;
  SELECT i."allowOverdraw", i."active" INTO item FROM "InventoryItem" i
   WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."itemId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stock_item_missing: item % not found', NEW."itemId";
  END IF;
  INSERT INTO "StockBalance" ("id", "tenantId", "branchId", "itemId", "quantity", "avgUnitCostPaise", "updatedAt")
  VALUES (gen_random_uuid(), NEW."tenantId", NEW."branchId", NEW."itemId", 0, 0, now())
  ON CONFLICT ("tenantId", "branchId", "itemId") DO NOTHING;
  SELECT b."quantity", b."avgUnitCostPaise" INTO bal FROM "StockBalance" b
   WHERE b."tenantId" = NEW."tenantId" AND b."branchId" = NEW."branchId" AND b."itemId" = NEW."itemId" FOR UPDATE;
  new_qty := bal."quantity" + NEW."quantity";
  IF new_qty < 0 AND NOT item."allowOverdraw" THEN
    RAISE EXCEPTION 'insufficient_stock: item % at branch % has % but % is needed',
      NEW."itemId", NEW."branchId", bal."quantity", -NEW."quantity";
  END IF;
  IF NEW."quantity" < 0 AND NEW."batchNo" IS NOT NULL AND NOT item."allowOverdraw" THEN
    SELECT coalesce(sum(m."quantity"), 0) INTO batch_qty FROM "StockMovement" m
     WHERE m."tenantId" = NEW."tenantId" AND m."branchId" = NEW."branchId" AND m."itemId" = NEW."itemId"
       AND m."batchNo" = NEW."batchNo";
    IF batch_qty + NEW."quantity" < 0 THEN
      RAISE EXCEPTION 'insufficient_stock: batch % of item % at branch % has % but % is needed',
        NEW."batchNo", NEW."itemId", NEW."branchId", batch_qty, -NEW."quantity";
    END IF;
  END IF;
  IF NEW."quantity" > 0 THEN
    cost := coalesce(NEW."unitCostPaise", bal."avgUnitCostPaise");
    IF bal."quantity" <= 0 OR new_qty <= 0 THEN
      new_avg := cost;
    ELSE
      new_avg := (bal."quantity" * bal."avgUnitCostPaise" + NEW."quantity" * cost) / new_qty;
    END IF;
    NEW."unitCostPaise" := cost;
  ELSE
    new_avg := bal."avgUnitCostPaise";
    NEW."unitCostPaise" := bal."avgUnitCostPaise";
  END IF;
  UPDATE "StockBalance" SET "quantity" = new_qty, "avgUnitCostPaise" = new_avg, "updatedAt" = now()
   WHERE "tenantId" = NEW."tenantId" AND "branchId" = NEW."branchId" AND "itemId" = NEW."itemId";
  NEW."balanceAfter" := new_qty;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movement_apply_bi BEFORE INSERT ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_apply();

-- Transfer movements are reconciled to the transfer: OUT leaves the source branch while IN_TRANSIT and never
-- exceeds the line it ships; IN arrives at the destination, only against a matching OUT, never more than was sent,
-- and carries the OUT's cost (stock cannot be minted at the destination or revalued in transit).
-- Named "..._0_..." so it fires BEFORE stock_movement_apply_bi (triggers run in name order) and can fix the
-- cost before the balance and its weighted average are computed.
CREATE OR REPLACE FUNCTION stock_movement_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t RECORD; ln_qty numeric; out_qty numeric; out_cost numeric; in_qty numeric;
BEGIN
  IF NEW."transferId" IS NULL THEN RETURN NEW; END IF;
  SELECT x."fromBranchId", x."toBranchId", x."status" INTO t FROM "StockTransfer" x
   WHERE x."tenantId" = NEW."tenantId" AND x."id" = NEW."transferId" FOR SHARE;
  IF NOT FOUND
     OR (NEW."kind" = 'TRANSFER_OUT' AND (NEW."branchId" <> t."fromBranchId" OR t."status" <> 'IN_TRANSIT'))
     OR (NEW."kind" = 'TRANSFER_IN' AND NEW."branchId" <> t."toBranchId") THEN
    RAISE EXCEPTION 'stock_transfer_state: % movement does not match transfer %', NEW."kind", NEW."transferId";
  END IF;

  IF NEW."kind" = 'TRANSFER_OUT' THEN
    SELECT coalesce(sum(l."quantity"), 0) INTO ln_qty FROM "StockTransferLine" l
     WHERE l."tenantId" = NEW."tenantId" AND l."transferId" = NEW."transferId" AND l."itemId" = NEW."itemId"
       AND l."batchNo" IS NOT DISTINCT FROM NEW."batchNo";
    SELECT coalesce(sum(-m."quantity"), 0) - NEW."quantity" INTO out_qty FROM "StockMovement" m
     WHERE m."tenantId" = NEW."tenantId" AND m."transferId" = NEW."transferId" AND m."kind" = 'TRANSFER_OUT'
       AND m."itemId" = NEW."itemId" AND m."batchNo" IS NOT DISTINCT FROM NEW."batchNo";
    IF out_qty > ln_qty THEN
      RAISE EXCEPTION 'stock_transfer_state: sending % of item % exceeds the % on transfer % lines',
        out_qty, NEW."itemId", ln_qty, NEW."transferId";
    END IF;
  ELSE
    SELECT coalesce(sum(-m."quantity"), 0), max(m."unitCostPaise") INTO out_qty, out_cost FROM "StockMovement" m
     WHERE m."tenantId" = NEW."tenantId" AND m."transferId" = NEW."transferId" AND m."kind" = 'TRANSFER_OUT'
       AND m."itemId" = NEW."itemId" AND m."batchNo" IS NOT DISTINCT FROM NEW."batchNo";
    SELECT coalesce(sum(m."quantity"), 0) + NEW."quantity" INTO in_qty FROM "StockMovement" m
     WHERE m."tenantId" = NEW."tenantId" AND m."transferId" = NEW."transferId" AND m."kind" = 'TRANSFER_IN'
       AND m."itemId" = NEW."itemId" AND m."batchNo" IS NOT DISTINCT FROM NEW."batchNo";
    IF out_qty = 0 OR in_qty > out_qty THEN
      RAISE EXCEPTION 'stock_transfer_state: receiving % of item % exceeds the % sent on transfer %',
        in_qty, NEW."itemId", out_qty, NEW."transferId";
    END IF;
    NEW."unitCostPaise" := out_cost;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movement_0_transfer_guard_bi BEFORE INSERT ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION stock_movement_transfer_guard();

CREATE OR REPLACE FUNCTION stock_transfer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."tenantId", NEW."fromBranchId", NEW."toBranchId", NEW."notes", NEW."sentBy", NEW."sentAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."fromBranchId", OLD."toBranchId", OLD."notes", OLD."sentBy", OLD."sentAt")
     OR OLD."status" = 'RECEIVED'
     OR NEW."status" <> 'RECEIVED' THEN
    RAISE EXCEPTION 'stock_transfer_state: transfer % only moves IN_TRANSIT -> RECEIVED', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_transfer_guard_bu BEFORE UPDATE ON "StockTransfer"
  FOR EACH ROW EXECUTE FUNCTION stock_transfer_guard();

-- Lines are written with the transfer; the only later change is the received quantity, once.
CREATE OR REPLACE FUNCTION stock_transfer_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st "StockTransferStatus";
BEGIN
  SELECT x."status" INTO st FROM "StockTransfer" x
   WHERE x."tenantId" = NEW."tenantId" AND x."id" = NEW."transferId" FOR SHARE;
  IF st IS DISTINCT FROM 'IN_TRANSIT' THEN
    RAISE EXCEPTION 'stock_transfer_state: lines of % transfer % cannot change', coalesce(st::text, 'missing'), NEW."transferId";
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."receivedQuantity" IS NOT NULL THEN
    RAISE EXCEPTION 'stock_transfer_state: received quantity of line % is already set', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_transfer_line_guard_biu BEFORE INSERT OR UPDATE ON "StockTransferLine"
  FOR EACH ROW EXECUTE FUNCTION stock_transfer_line_guard();

-- ---------------------------------------------------------------------------------------------
-- Notifications (PRD 4.7): the outbox row's identity and content are frozen; the worker advances
-- status / attempts / provider columns. QUEUED is the only status that can move; delivery receipts
-- (deliveryStatus, deliveredAt) may still arrive after SENT.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notification_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('QUEUED', 'SKIPPED_NO_CONSENT', 'OPTED_OUT') THEN
      RAISE EXCEPTION 'notification_state: a message is created QUEUED, SKIPPED_NO_CONSENT or OPTED_OUT';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."branchId", NEW."patientId", NEW."channel", NEW."purpose", NEW."templateCode",
      NEW."templateVersionId", NEW."toAddress", NEW."variables", NEW."idempotencyKey", NEW."source",
      NEW."refType", NEW."refId", NEW."actorId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."branchId", OLD."patientId", OLD."channel", OLD."purpose", OLD."templateCode",
      OLD."templateVersionId", OLD."toAddress", OLD."variables", OLD."idempotencyKey", OLD."source",
      OLD."refType", OLD."refId", OLD."actorId", OLD."createdAt") THEN
    RAISE EXCEPTION 'notification_state: identity and content of message % cannot change', OLD."id";
  END IF;
  IF NEW."status" <> OLD."status" AND OLD."status" <> 'QUEUED' THEN
    RAISE EXCEPTION 'notification_state: % message % is final', OLD."status", OLD."id";
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'notification_state: attempts of message % cannot decrease', OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_outbox_guard_biu BEFORE INSERT OR UPDATE ON "NotificationOutbox"
  FOR EACH ROW EXECUTE FUNCTION notification_outbox_guard();

-- ---------------------------------------------------------------------------------------------
-- Row-level security: every new table is tenant-owned and fails closed (see 0002_rls).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'InvoiceCounter', 'RequestDedupe', 'Invoice', 'InvoiceLine', 'Payment', 'PaymentAllocation', 'PaymentGatewayEvent',
    'Refund', 'InvoiceAdjustment', 'FinanceLedgerEntry', 'PatientCreditEntry',
    'CommissionRule', 'CommissionEntry', 'CommissionSettlement', 'CommissionSettlementItem',
    'InventoryItem', 'Supplier', 'StockReceipt', 'StockMovement', 'StockBalance', 'StockTransfer',
    'StockTransferLine',
    'NotificationTemplate', 'NotificationTemplateVersion', 'NotificationOutbox', 'NotificationDeliveryEvent',
    'RecallSetting'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_tenant_id()) '
                   'WITH CHECK ("tenantId" = app_tenant_id())', t);
  END LOOP;
END $$;

-- History must not be silently overwritten (PRD 2.5, 4.6, 7.5). Grants come from 0002's default privileges.
-- Append-only for the app role (no UPDATE, no DELETE): ledgers and posted financial documents.
REVOKE UPDATE, DELETE ON "PaymentAllocation" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "PaymentGatewayEvent" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "InvoiceAdjustment" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "FinanceLedgerEntry" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "PatientCreditEntry" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "CommissionEntry" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "StockMovement" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "StockReceipt" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "NotificationTemplateVersion" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "NotificationDeliveryEvent" FROM dentalos_app;
REVOKE UPDATE, DELETE ON "RequestDedupe" FROM dentalos_app;
-- Stock balances are maintained only by the stock_movement_apply trigger (SECURITY DEFINER).
REVOKE INSERT, UPDATE, DELETE ON "StockBalance" FROM dentalos_app;
-- Never hard-deleted (status / deactivation / void / close instead):
REVOKE DELETE ON "Invoice" FROM dentalos_app;
-- Document counters are moved only by allocate_document_seq (SECURITY DEFINER): the app role may read them
-- but cannot rewind, skip or seed one, so numbers stay gap-free and collision-free.
REVOKE INSERT, UPDATE, DELETE ON "InvoiceCounter" FROM dentalos_app;
REVOKE DELETE ON "Payment" FROM dentalos_app;
REVOKE DELETE ON "Refund" FROM dentalos_app;
REVOKE DELETE ON "CommissionRule" FROM dentalos_app;
REVOKE DELETE ON "InventoryItem" FROM dentalos_app;
REVOKE DELETE ON "Supplier" FROM dentalos_app;
REVOKE DELETE ON "StockTransfer" FROM dentalos_app;
REVOKE DELETE ON "StockTransferLine" FROM dentalos_app;
REVOKE DELETE ON "NotificationTemplate" FROM dentalos_app;
REVOKE DELETE ON "NotificationOutbox" FROM dentalos_app;
REVOKE DELETE ON "RecallSetting" FROM dentalos_app;
-- (InvoiceLine, CommissionSettlement and CommissionSettlementItem keep DELETE: triggers allow it only
-- while the invoice / settlement is DRAFT.)
-- Column-level UPDATE where only some columns may ever change (triggers enforce the rules on top):
REVOKE UPDATE ON "Payment" FROM dentalos_app;
GRANT UPDATE ("status", "gatewayRef", "reference", "receiptNumber", "receivedAt", "failureCode")
  ON "Payment" TO dentalos_app;
REVOKE UPDATE ON "Refund" FROM dentalos_app;
GRANT UPDATE ("status", "approvedBy", "approvedAt", "rejectedBy", "rejectedAt", "rejectionReason",
              "processedBy", "processedAt", "reference", "gatewayRef")
  ON "Refund" TO dentalos_app;
REVOKE UPDATE ON "CommissionRule" FROM dentalos_app;
GRANT UPDATE ("effectiveTo", "endedBy") ON "CommissionRule" TO dentalos_app;
REVOKE UPDATE ON "StockTransfer" FROM dentalos_app;
GRANT UPDATE ("status", "receivedBy", "receivedAt") ON "StockTransfer" TO dentalos_app;
REVOKE UPDATE ON "StockTransferLine" FROM dentalos_app;
GRANT UPDATE ("receivedQuantity") ON "StockTransferLine" TO dentalos_app;
-- Invoice: paid / adjustments / balance are written ONLY by invoice_recalc (SECURITY DEFINER); the app role has
-- no UPDATE privilege on those columns at all. It still updates the rest (issue, void, dueDate, notes, drafts).
REVOKE UPDATE ON "Invoice" FROM dentalos_app;
GRANT UPDATE ("branchId", "patientId", "number", "status", "issuedAt", "issuedBy", "dueDate", "currency",
              "taxInclusive", "supplierGstin", "supplierStateCode", "placeOfSupplyStateCode", "subtotalPaise",
              "discountPaise", "taxPaise", "totalPaise", "invoiceDiscountPaise", "invoiceDiscountPercentBp",
              "discountReason", "discountAppliedBy", "planId", "planVersion", "encounterId", "notes", "voidReason",
              "voidedBy", "voidedAt", "createdBy", "createdAt", "updatedAt")
  ON "Invoice" TO dentalos_app;
