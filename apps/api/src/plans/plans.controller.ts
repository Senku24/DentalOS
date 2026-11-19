import {
  type AddPlanItemRequest,
  type ApprovePlanRequest,
  type CancelPlanRequest,
  type CreatePlanItemSessionRequest,
  type CreatePlanRequest,
  type DecidePlanItemsRequest,
  type ListPlansQuery,
  type PlanItemTransitionRequest,
  type PresentPlanRequest,
  type UpdatePlanItemRequest,
  type UpdatePlanItemSessionRequest,
  type UpdatePlanRequest,
  addPlanItemRequest,
  approvePlanRequest,
  cancelPlanRequest,
  createPlanItemSessionRequest,
  createPlanRequest,
  decidePlanItemsRequest,
  listPlansQuery,
  planItemTransitionRequest,
  presentPlanRequest,
  updatePlanItemRequest,
  updatePlanItemSessionRequest,
  updatePlanRequest,
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
  Query,
} from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { PlanConsentService } from "./consent.service";
import { type ReorderPlanItemsRequest, reorderPlanItemsRequest, versionParam } from "./plans.dto";
import { PlansService } from "./plans.service";
import { SessionsService } from "./sessions.service";

const Id = () => Param("id", new ParseUUIDPipe());
const Version = (name: string) => Param(name, new ZodPipe(versionParam));

/**
 * Treatment plans (PRD 4.5). Route capability via @Can; the plan's branch is checked in the service
 * (`assertCan` / out-of-scope plans answer 404).
 */
@Controller("plans")
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly consents: PlanConsentService,
  ) {}

  @Can("plan:write")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createPlanRequest)) body: CreatePlanRequest,
  ) {
    return this.plans.create(p, body);
  }

  @Can("plan:read")
  @Get()
  list(@CurrentPrincipal() p: Principal, @Query(new ZodPipe(listPlansQuery)) q: ListPlansQuery) {
    return this.plans.list(p, q);
  }

  @Can("plan:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.plans.get(p, id);
  }

  @Can("plan:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updatePlanRequest)) body: UpdatePlanRequest,
  ) {
    return this.plans.update(p, id, body);
  }

  @Can("plan:write")
  @Post(":id/present")
  @HttpCode(200)
  present(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(presentPlanRequest)) body: PresentPlanRequest,
  ) {
    return this.plans.present(p, id, body);
  }

  @Can("plan:approve")
  @Post(":id/decisions")
  @HttpCode(200)
  decide(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(decidePlanItemsRequest)) body: DecidePlanItemsRequest,
  ) {
    return this.plans.decide(p, id, body);
  }

  @Can("plan:approve")
  @Post(":id/approve")
  @HttpCode(200)
  approve(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(approvePlanRequest)) body: ApprovePlanRequest,
  ) {
    return this.plans.approve(p, id, body);
  }

  @Can("plan:write")
  @Post(":id/cancel")
  @HttpCode(200)
  cancel(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(cancelPlanRequest)) body: CancelPlanRequest,
  ) {
    return this.plans.cancel(p, id, body);
  }

  @Can("plan:write")
  @Post(":id/items")
  addItem(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(addPlanItemRequest)) body: AddPlanItemRequest,
  ) {
    return this.plans.addItem(p, id, body);
  }

  @Can("plan:write")
  @Post(":id/items/reorder")
  @HttpCode(200)
  reorder(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(reorderPlanItemsRequest)) body: ReorderPlanItemsRequest,
  ) {
    return this.plans.reorder(p, id, body);
  }

  @Can("plan:read")
  @Get(":id/versions")
  versions(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.plans.versions(p, id);
  }

  @Can("plan:read")
  @Get(":id/versions/:a/diff/:b")
  diff(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Version("a") a: number,
    @Version("b") b: number,
  ) {
    return this.plans.diff(p, id, a, b);
  }

  @Can("plan:read")
  @Get(":id/versions/:version")
  version(@CurrentPrincipal() p: Principal, @Id() id: string, @Version("version") v: number) {
    return this.plans.version(p, id, v);
  }

  /** Consents signed against this plan's versions (for the approval UI). */
  @Can("consent:manage")
  @Get(":id/consents")
  planConsents(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.consents.planConsents(p, id);
  }
}

/** Items addressed by id: edit, delete (never-presented DRAFT only), clinician status moves, sessions. */
@Controller("plan-items")
export class PlanItemsController {
  constructor(
    private readonly plans: PlansService,
    private readonly sessions: SessionsService,
  ) {}

  @Can("plan:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updatePlanItemRequest)) body: UpdatePlanItemRequest,
  ) {
    return this.plans.updateItem(p, id, body);
  }

  @Can("plan:write")
  @Delete(":id")
  remove(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.plans.removeItem(p, id);
  }

  /** Permission per target status (`planItemTransitionPermissions`) is checked in the service. */
  @Can("plan:read")
  @Post(":id/status")
  @HttpCode(200)
  transition(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(planItemTransitionRequest)) body: PlanItemTransitionRequest,
  ) {
    return this.plans.transitionItem(p, id, body);
  }

  @Can("plan:read")
  @Get(":id/sessions")
  sessionsList(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.sessions.list(p, id);
  }

  @Can("plan:write")
  @Post(":id/sessions")
  createSession(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(createPlanItemSessionRequest)) body: CreatePlanItemSessionRequest,
  ) {
    return this.sessions.create(p, id, body);
  }
}

@Controller("plan-item-sessions")
export class PlanItemSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Can("plan:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updatePlanItemSessionRequest)) body: UpdatePlanItemSessionRequest,
  ) {
    return this.sessions.update(p, id, body);
  }

  @Can("plan:write")
  @Post(":id/complete")
  @HttpCode(200)
  complete(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.sessions.complete(p, id);
  }
}
