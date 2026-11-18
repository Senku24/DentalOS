import {
  type CreatePatientRequest,
  type DuplicateCheckRequest,
  type LifecycleTransitionRequest,
  type SearchPatientsQuery,
  type UpdatePatientRequest,
  type VerifyIdentityRequest,
  createPatientRequest,
  duplicateCheckRequest,
  lifecycleTransitionRequest,
  searchPatientsQuery,
  updatePatientRequest,
  verifyIdentityRequest,
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
import { DuplicatesService } from "./duplicates.service";
import { MergeService } from "./merge.service";
import { PatientsService } from "./patients.service";

const Id = () => Param("id", new ParseUUIDPipe());

/** Shared patient profile (tenant-wide across branches; originBranchId is retained). */
@Controller("patients")
export class PatientsController {
  constructor(
    private readonly patients: PatientsService,
    private readonly duplicates: DuplicatesService,
    private readonly merges: MergeService,
  ) {}

  @Can("patient:write")
  @Post()
  create(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(createPatientRequest)) body: CreatePatientRequest,
  ) {
    return this.patients.create(p, body);
  }

  @Can("patient:read")
  @Get()
  search(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(searchPatientsQuery)) q: SearchPatientsQuery,
  ) {
    return this.patients.search(p, q);
  }

  /** Pre-create / pre-edit duplicate check; read-only, blocks (409) only with `failOnMatch`. */
  @Can("patient:read")
  @Post("duplicate-check")
  @HttpCode(200)
  duplicateCheck(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(duplicateCheckRequest)) body: DuplicateCheckRequest,
  ) {
    return this.duplicates.check(p, body);
  }

  @Can("patient:read")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.patients.get(p, id);
  }

  @Can("patient:write")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updatePatientRequest)) body: UpdatePatientRequest,
  ) {
    return this.patients.update(p, id, body);
  }

  @Can("patient:write")
  @Post(":id/lifecycle")
  @HttpCode(200)
  transition(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(lifecycleTransitionRequest)) body: LifecycleTransitionRequest,
  ) {
    return this.patients.transition(p, id, body.stage);
  }

  @Can("patient:write")
  @Post(":id/identity-verification")
  @HttpCode(200)
  verifyIdentity(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(verifyIdentityRequest)) body: VerifyIdentityRequest,
  ) {
    return this.patients.verifyIdentity(p, id, body);
  }

  @Can("patient:read")
  @Get(":id/merges")
  mergeHistory(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.merges.history(p, id);
  }
}
