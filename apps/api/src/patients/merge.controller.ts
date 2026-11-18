import {
  type MergePatientsRequest,
  type MergePreviewQuery,
  dismissDuplicateRequest,
  listDuplicateCandidatesQuery,
  mergePatientsRequest,
  mergePreviewQuery,
  type z,
} from "@dentalos/validation";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Can, StepUp } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { DuplicatesService } from "./duplicates.service";
import { MergeService } from "./merge.service";

/** Duplicate review queue (patient:merge also covers review/dismissal). */
@Controller("duplicate-candidates")
export class DuplicateCandidatesController {
  constructor(private readonly duplicates: DuplicatesService) {}

  @Can("patient:merge")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listDuplicateCandidatesQuery))
    q: z.infer<typeof listDuplicateCandidatesQuery>,
  ) {
    return this.duplicates.listCandidates(p, q);
  }

  @Can("patient:merge")
  @Post(":id/dismiss")
  @HttpCode(200)
  dismiss(
    @CurrentPrincipal() p: Principal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(dismissDuplicateRequest)) _body: unknown,
  ) {
    return this.duplicates.dismiss(p, id);
  }
}

/** Controlled merge: preview, then execute with an explicit survivor (never automatic). */
@Controller("patient-merges")
export class PatientMergesController {
  constructor(private readonly merges: MergeService) {}

  @Can("patient:merge")
  @Get("preview")
  preview(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(mergePreviewQuery)) q: MergePreviewQuery,
  ) {
    return this.merges.preview(p, q);
  }

  /** Irreversible in-app: requires a sign-in within 15 minutes (PRD 7.3 step-up). */
  @Can("patient:merge")
  @StepUp(900)
  @Post()
  execute(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(mergePatientsRequest)) body: MergePatientsRequest,
  ) {
    return this.merges.execute(p, body);
  }
}
