import {
  type CreateInvoiceFromPlanRequest,
  type CreateInvoiceRequest,
  type EstimateQuery,
  type InvoiceLineInput,
  type IssueInvoiceRequest,
  type ListInvoicesQuery,
  type SetInvoiceDiscountRequest,
  type UpdateInvoiceLineRequest,
  type UpdateInvoiceRequest,
  type VoidInvoiceRequest,
  createInvoiceFromPlanRequest,
  createInvoiceRequest,
  estimateQuery,
  invoiceLineInput,
  issueInvoiceRequest,
  listInvoicesQuery,
  setInvoiceDiscountRequest,
  updateInvoiceLineRequest,
  updateInvoiceRequest,
  voidInvoiceRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { InvoicesService } from "./invoices.service";

const Id = () => Param("id", new ParseUUIDPipe());
const LineId = () => Param("lineId", new ParseUUIDPipe());

/** Estimates are plan prices at a version (nothing stored); the plan's branch is checked in the service. */
@Controller("estimates")
export class EstimatesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Can("billing:read")
  @Get()
  get(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(estimateQuery)) q: EstimateQuery) {
    return this.invoices.estimate(p, q);
  }
}

/**
 * Invoices (PRD 4.6, ADR 0004 §1-§3). Route capability via @Can; the invoice's branch is checked in the service
 * (out-of-scope / foreign-tenant ids answer 404, in-scope but lacking the permission at that branch 403).
 */
@Controller("invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Can("invoice:write")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createInvoiceRequest)) body: CreateInvoiceRequest,
  ) {
    return this.invoices.create(p, body);
  }

  @Can("invoice:write")
  @Post("from-plan")
  fromPlan(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createInvoiceFromPlanRequest)) body: CreateInvoiceFromPlanRequest,
  ) {
    return this.invoices.createFromPlan(p, body);
  }

  @Can("billing:read")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listInvoicesQuery)) q: ListInvoicesQuery,
  ) {
    return this.invoices.list(p, q);
  }

  @Can("billing:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.invoices.get(p, id);
  }

  @Can("billing:read")
  @Get(":id/print")
  print(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.invoices.print(p, id);
  }

  @Can("invoice:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateInvoiceRequest)) body: UpdateInvoiceRequest,
  ) {
    return this.invoices.update(p, id, body);
  }

  @Can("invoice:write")
  @Put(":id/discount")
  setDiscount(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(setInvoiceDiscountRequest)) body: SetInvoiceDiscountRequest,
  ) {
    return this.invoices.setDiscount(p, id, body);
  }

  @Can("invoice:write")
  @Post(":id/lines")
  addLine(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(invoiceLineInput)) body: InvoiceLineInput,
  ) {
    return this.invoices.addLine(p, id, body);
  }

  @Can("invoice:write")
  @Patch(":id/lines/:lineId")
  updateLine(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @LineId() lineId: string,
    @Body(new ZodPipe(updateInvoiceLineRequest)) body: UpdateInvoiceLineRequest,
  ) {
    return this.invoices.updateLine(p, id, lineId, body);
  }

  @Can("invoice:write")
  @Delete(":id/lines/:lineId")
  deleteLine(@CurrentPrincipal() p: Principal, @Id() id: string, @LineId() lineId: string) {
    return this.invoices.deleteLine(p, id, lineId);
  }

  @Can("invoice:write")
  @Post(":id/issue")
  @HttpCode(200)
  issue(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(issueInvoiceRequest)) body: IssueInvoiceRequest,
  ) {
    return this.invoices.issue(p, id, body);
  }

  @Can("invoice:write")
  @Post(":id/void")
  @HttpCode(200)
  void(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(voidInvoiceRequest)) body: VoidInvoiceRequest,
  ) {
    return this.invoices.void(p, id, body);
  }
}
