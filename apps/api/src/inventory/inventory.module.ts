import { Module } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { ItemsService } from "./items.service";
import { InventoryReportsService } from "./reports.service";
import { StockService } from "./stock.service";
import { TransfersService } from "./transfers.service";

/**
 * M3 Inventory (PRD 4.8): items, suppliers, simple purchase receipts, usage (FEFO) linked to procedures, adjustments
 * and waste with reasons, inter-branch transfers (IN_TRANSIT -> RECEIVED), balances, low-stock, batches / expiry,
 * valuation (weighted-average cost). The DB trigger on StockMovement maintains StockBalance — write movements only.
 * PRISMA, AuditService, EventBus and StorageService are @Global (AppModule) and injectable as-is.
 * Rules: docs/adr/0004-business-operations-rules.md §8; DTOs + helpers in @dentalos/validation `inventory.ts`;
 * DB guard codes mapped in ./inventory-common.ts (`mapInventoryDbError`). See docs/M3-business-ops.md.
 */
@Module({
  controllers: [InventoryController],
  providers: [ItemsService, StockService, TransfersService, InventoryReportsService],
})
export class InventoryModule {}
