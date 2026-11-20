import {
  type ChartTeethRequest,
  type OdontogramQuery,
  type SupersedeToothRecordsRequest,
  chartTeethRequest,
  odontogramQuery,
  supersedeToothRecordsRequest,
  uuid,
} from "@dentalos/validation";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { PatientClinicalService } from "./patient-clinical.service";

const Id = () => Param("id", new ParseUUIDPipe());
const contextQuery = z.object({ branchId: uuid.optional() });

/** Odontogram and clinical workspace context of a patient (merge lineage included on reads). */
@Controller("patients/:id")
export class PatientClinicalController {
  constructor(private readonly svc: PatientClinicalService) {}

  @Can("clinical:read")
  @Get("odontogram")
  odontogram(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Query(new ZodPipe(odontogramQuery)) q: OdontogramQuery,
  ) {
    return this.svc.odontogram(p, id, q);
  }

  @Can("clinical:write")
  @Post("odontogram")
  chart(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(chartTeethRequest)) body: ChartTeethRequest,
  ) {
    return this.svc.chart(p, id, body);
  }

  @Can("clinical:write")
  @Post("odontogram/supersede")
  @HttpCode(200)
  supersede(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(supersedeToothRecordsRequest)) body: SupersedeToothRecordsRequest,
  ) {
    return this.svc.supersede(p, id, body);
  }

  @Can("clinical:read")
  @Get("clinical-context")
  context(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Query(new ZodPipe(contextQuery)) q: z.infer<typeof contextQuery>,
  ) {
    return this.svc.context(p, id, q.branchId);
  }
}
