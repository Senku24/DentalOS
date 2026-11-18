import {
  type AddAlertRequest,
  type AddAllergyRequest,
  type AddMedicalHistoryRequest,
  addAlertRequest,
  addAllergyRequest,
  type IncludeResolvedQuery,
  addMedicalHistoryRequest,
  includeResolvedQuery,
  resolveRequest,
} from "@dentalos/validation";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { MedicalService } from "./medical.service";

const Id = () => Param("id", new ParseUUIDPipe());

/** Medical/dental history, allergies and clinical alerts (medical:read / medical:write). */
@Controller("patients/:id")
export class MedicalController {
  constructor(private readonly medical: MedicalService) {}

  @Can("medical:read")
  @Get("medical-history")
  history(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.medical.history(p, id);
  }

  @Can("medical:write")
  @Post("medical-history")
  addHistory(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(addMedicalHistoryRequest)) body: AddMedicalHistoryRequest,
  ) {
    return this.medical.addHistory(p, id, body);
  }

  @Can("medical:read")
  @Get("allergies")
  allergies(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Query(new ZodPipe(includeResolvedQuery)) q: IncludeResolvedQuery,
  ) {
    return this.medical.allergies(p, id, q.includeResolved);
  }

  @Can("medical:write")
  @Post("allergies")
  addAllergy(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(addAllergyRequest)) body: AddAllergyRequest,
  ) {
    return this.medical.addAllergy(p, id, body);
  }

  @Can("medical:write")
  @Post("allergies/:allergyId/resolve")
  @HttpCode(200)
  resolveAllergy(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Param("allergyId", new ParseUUIDPipe()) allergyId: string,
    @Body(new ZodPipe(resolveRequest)) _body: unknown,
  ) {
    return this.medical.resolveAllergy(p, id, allergyId);
  }

  @Can("medical:read")
  @Get("alerts")
  alerts(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Query(new ZodPipe(includeResolvedQuery)) q: IncludeResolvedQuery,
  ) {
    return this.medical.alerts(p, id, q.includeResolved);
  }

  @Can("medical:write")
  @Post("alerts")
  addAlert(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(addAlertRequest)) body: AddAlertRequest,
  ) {
    return this.medical.addAlert(p, id, body);
  }

  @Can("medical:write")
  @Post("alerts/:alertId/resolve")
  @HttpCode(200)
  resolveAlert(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Param("alertId", new ParseUUIDPipe()) alertId: string,
    @Body(new ZodPipe(resolveRequest)) _body: unknown,
  ) {
    return this.medical.resolveAlert(p, id, alertId);
  }
}
