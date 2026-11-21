import {
  type AdjustStockRequest,
  type ConsumeStockRequest,
  type CreateInventoryItemRequest,
  type CreateSupplierRequest,
  type ListInventoryItemsQuery,
  type ListStockMovementsQuery,
  type ListStockReceiptsQuery,
  type ListSuppliersQuery,
  type ListTransfersQuery,
  type ReceiveStockRequest,
  type ReceiveTransferRequest,
  type RecordWasteRequest,
  type SendTransferRequest,
  type StockBalancesQuery,
  type UpdateInventoryItemRequest,
  type UpdateSupplierRequest,
  adjustStockRequest,
  consumeStockRequest,
  createInventoryItemRequest,
  createSupplierRequest,
  listInventoryItemsQuery,
  listStockMovementsQuery,
  listStockReceiptsQuery,
  listSuppliersQuery,
  listTransfersQuery,
  receiveStockRequest,
  receiveTransferRequest,
  recordWasteRequest,
  sendTransferRequest,
  stockBalancesQuery,
  stockBatchesQuery,
  stockValuationQuery,
  updateInventoryItemRequest,
  updateSupplierRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { type ExpiringBatchesQuery, expiringBatchesQuery } from "./inventory.dto";
import { ItemsService } from "./items.service";
import { InventoryReportsService } from "./reports.service";
import { StockService } from "./stock.service";
import { TransfersService } from "./transfers.service";

const Id = () => Param("id", new ParseUUIDPipe());

/**
 * Inventory (PRD 4.8). `@Can` proves the capability; the branch of the resource / the request is checked in the services
 * (`assertCan` / branch-scope filters: out-of-scope branches answer 403 for writes and are filtered out of reads).
 */
@Controller("inventory")
export class InventoryController {
  constructor(
    private readonly items: ItemsService,
    private readonly stock: StockService,
    private readonly transfers: TransfersService,
    private readonly reports: InventoryReportsService,
  ) {}

  // ---- Items ----------------------------------------------------------------------------------
  @Can("inventory:read")
  @Get("items")
  listItems(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listInventoryItemsQuery)) q: ListInventoryItemsQuery,
  ) {
    return this.items.list(p, q);
  }

  @Can("inventory:write")
  @Post("items")
  createItem(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createInventoryItemRequest)) body: CreateInventoryItemRequest,
  ) {
    return this.items.create(p, body);
  }

  @Can("inventory:read")
  @Get("items/:id")
  getItem(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.items.get(p, id);
  }

  @Can("inventory:write")
  @Patch("items/:id")
  updateItem(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateInventoryItemRequest)) body: UpdateInventoryItemRequest,
  ) {
    return this.items.update(p, id, body);
  }

  // ---- Suppliers ------------------------------------------------------------------------------
  @Can("inventory:read")
  @Get("suppliers")
  listSuppliers(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listSuppliersQuery)) q: ListSuppliersQuery,
  ) {
    return this.items.listSuppliers(p, q);
  }

  @Can("inventory:write")
  @Post("suppliers")
  createSupplier(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createSupplierRequest)) body: CreateSupplierRequest,
  ) {
    return this.items.createSupplier(p, body);
  }

  @Can("inventory:read")
  @Get("suppliers/:id")
  getSupplier(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.items.getSupplier(p, id);
  }

  @Can("inventory:write")
  @Patch("suppliers/:id")
  updateSupplier(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateSupplierRequest)) body: UpdateSupplierRequest,
  ) {
    return this.items.updateSupplier(p, id, body);
  }

  // ---- Stock movements ------------------------------------------------------------------------
  @Can("inventory:write")
  @Post("receipts")
  receive(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(receiveStockRequest)) body: ReceiveStockRequest,
  ) {
    return this.stock.receive(p, body);
  }

  @Can("inventory:read")
  @Get("receipts")
  listReceipts(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listStockReceiptsQuery)) q: ListStockReceiptsQuery,
  ) {
    return this.stock.listReceipts(p, q);
  }

  @Can("inventory:read")
  @Get("receipts/:id")
  getReceipt(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.stock.getReceipt(p, id);
  }

  @Can("inventory:write")
  @Post("consumption")
  consume(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(consumeStockRequest)) body: ConsumeStockRequest,
  ) {
    return this.stock.consume(p, body);
  }

  @Can("inventory:adjust")
  @Post("adjustments")
  adjust(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(adjustStockRequest)) body: AdjustStockRequest,
  ) {
    return this.stock.adjust(p, body);
  }

  @Can("inventory:adjust")
  @Post("waste")
  waste(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(recordWasteRequest)) body: RecordWasteRequest,
  ) {
    return this.stock.waste(p, body);
  }

  @Can("inventory:read")
  @Get("movements")
  movements(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listStockMovementsQuery)) q: ListStockMovementsQuery,
  ) {
    return this.stock.listMovements(p, q);
  }

  // ---- Transfers ------------------------------------------------------------------------------
  @Can("inventory:transfer")
  @Post("transfers")
  send(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(sendTransferRequest)) body: SendTransferRequest,
  ) {
    return this.transfers.send(p, body);
  }

  @Can("inventory:transfer")
  @Get("transfers")
  listTransfers(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listTransfersQuery)) q: ListTransfersQuery,
  ) {
    return this.transfers.list(p, q);
  }

  @Can("inventory:transfer")
  @Get("transfers/:id")
  getTransfer(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.transfers.get(p, id);
  }

  @Can("inventory:transfer")
  @Post("transfers/:id/receive")
  @HttpCode(200)
  receiveTransfer(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(receiveTransferRequest)) body: ReceiveTransferRequest,
  ) {
    return this.transfers.receive(p, id, body);
  }

  // ---- Balances / reports ---------------------------------------------------------------------
  @Can("inventory:read")
  @Get("balances")
  balances(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(stockBalancesQuery)) q: StockBalancesQuery,
  ) {
    return this.reports.balances(p, q);
  }

  @Can("inventory:read")
  @Get("low-stock")
  lowStock(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(stockBalancesQuery)) q: StockBalancesQuery,
  ) {
    return this.reports.lowStock(p, q);
  }

  @Can("inventory:read")
  @Get("batches")
  batches(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(stockBatchesQuery)) q: { branchId: string; itemId: string },
  ) {
    return this.reports.batches(p, q);
  }

  @Can("inventory:read")
  @Get("expiring")
  expiring(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(expiringBatchesQuery)) q: ExpiringBatchesQuery,
  ) {
    return this.reports.expiring(p, q);
  }

  @Can("inventory:read")
  @Get("valuation")
  valuation(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(stockValuationQuery)) q: { branchId?: string | undefined },
  ) {
    return this.reports.valuation(p, q);
  }
}
