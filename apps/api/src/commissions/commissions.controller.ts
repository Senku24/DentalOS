import {
  type ApproveSettlementRequest,
  type CloseCommissionRuleRequest,
  type CreateCommissionAdjustmentRequest,
  type CreateCommissionRuleRequest,
  type CreateSettlementRequest,
  type DentistStatementQuery,
  type ListCommissionEntriesQuery,
  type ListCommissionRulesQuery,
  type ListSettlementsQuery,
  type PaySettlementRequest,
  type SupersedeCommissionRuleRequest,
  approveSettlementRequest,
  closeCommissionRuleRequest,
  createCommissionAdjustmentRequest,
  createCommissionRuleRequest,
  createSettlementRequest,
  dentistStatementQuery,
  listCommissionEntriesQuery,
  listCommissionRulesQuery,
  listSettlementsQuery,
  paySettlementRequest,
  supersedeCommissionRuleRequest,
} from "@dentalos/validation";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { LedgerService } from "./ledger.service";
import { RulesService } from "./rules.service";
import { SettlementsService } from "./settlements.service";

const Id = () => Param("id", new ParseUUIDPipe());

/**
 * Commission rules. Reads are NOT behind `@Can`: `compensation:read` is self-scoped, so the guard (which checks the
 * capability without a resource) would refuse every dentist; the service decides (org-wide readers see all rules,
 * a dentist sees their own + the defaults). Writes need the org-wide `compensation:manage`.
 */
@Controller("commission-rules")
export class CommissionRulesController {
  constructor(private readonly rules: RulesService) {}

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listCommissionRulesQuery)) q: ListCommissionRulesQuery,
  ) {
    return this.rules.list(p, q);
  }

  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.rules.get(p, id);
  }

  @Can("compensation:manage")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createCommissionRuleRequest)) body: CreateCommissionRuleRequest,
  ) {
    return this.rules.create(p, body);
  }

  @Can("compensation:manage")
  @Post(":id/supersede")
  supersede(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(supersedeCommissionRuleRequest)) body: SupersedeCommissionRuleRequest,
  ) {
    return this.rules.supersede(p, id, body);
  }

  @Can("compensation:manage")
  @Post(":id/close")
  @HttpCode(200)
  close(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(closeCommissionRuleRequest)) body: CloseCommissionRuleRequest,
  ) {
    return this.rules.close(p, id, body);
  }
}

/** Commission ledger: list (self-scoped for dentists), manual adjustments (compensation:manage). */
@Controller("commission-entries")
export class CommissionEntriesController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listCommissionEntriesQuery)) q: ListCommissionEntriesQuery,
  ) {
    return this.ledger.listEntries(p, q);
  }

  @Can("compensation:manage")
  @Post("adjustments")
  adjust(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createCommissionAdjustmentRequest)) body: CreateCommissionAdjustmentRequest,
  ) {
    return this.ledger.adjust(p, body);
  }
}

@Controller("commission-settlements")
export class CommissionSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Can("compensation:manage")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createSettlementRequest)) body: CreateSettlementRequest,
  ) {
    return this.settlements.create(p, body);
  }

  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listSettlementsQuery)) q: ListSettlementsQuery,
  ) {
    return this.settlements.list(p, q);
  }

  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.settlements.get(p, id);
  }

  @Can("compensation:settle")
  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(approveSettlementRequest)) body: ApproveSettlementRequest,
  ) {
    return this.settlements.approve(p, id, body);
  }

  @Can("compensation:manage")
  @Post(":id/pay")
  @HttpCode(200)
  pay(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(paySettlementRequest)) body: PaySettlementRequest,
  ) {
    return this.settlements.pay(p, id, body);
  }

  @Can("compensation:manage")
  @Delete(":id")
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Id() id: string) {
    await this.settlements.remove(p, id);
  }
}

/** Dentist statement (self-scoped for dentists) and the manual accrual endpoint. */
@Controller()
export class CompensationController {
  constructor(private readonly ledger: LedgerService) {}

  @Get("compensation/statement")
  statement(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(dentistStatementQuery)) q: DentistStatementQuery,
  ) {
    return this.ledger.statement(p, q);
  }

  /** Manual / recovery accrual for one payment-allocation row. Idempotent. */
  @Can("compensation:manage")
  @Post("commissions/accrue/:allocationId")
  @HttpCode(200)
  accrue(
    @CurrentPrincipal() p: Principal,
    @Param("allocationId", new ParseUUIDPipe()) allocationId: string,
  ) {
    return this.ledger.accrue(p, allocationId);
  }
}
