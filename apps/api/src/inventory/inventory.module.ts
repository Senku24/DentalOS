import { Module } from "@nestjs/common";

/**
 * M3 Inventory (PRD 4.8): items, suppliers, simple purchase receipts, usage (FEFO) linked to procedures, adjustments
 * and waste with reasons, inter-branch transfers (IN_TRANSIT -> RECEIVED), balances, low-stock, valuation
 * (weighted-average cost). The DB trigger on StockMovement maintains StockBalance — write movements only.
 * Owned by Wave 1 worker C1 — add controllers/providers here only (apps/api/src/inventory/**).
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Rules: docs/adr/0004-business-operations-rules.md §8; DTOs + helpers in @dentalos/validation `inventory.ts`;
 * map `insufficient_stock` / `stock_transfer_state` with `m3GuardError`. See docs/M3-business-ops.md.
 */
@Module({
  controllers: [],
  providers: [],
})
export class InventoryModule {}
