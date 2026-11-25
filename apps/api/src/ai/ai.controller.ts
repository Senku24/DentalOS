import {
  AI_MAX_AUDIO_BYTES,
  type AiCapability,
  type ApproveAiDraftRequest,
  type DailySummaryQuery,
  type GenerateClinicalNoteDraftRequest,
  type GenerateEncounterSummaryRequest,
  type GeneratePatientSummaryRequest,
  type GeneratePlanExplanationRequest,
  type ListAiActivityQuery,
  type ListAiDraftsQuery,
  type NlAnalyticsRequest,
  type RegenerateDailySummaryRequest,
  type RejectAiDraftRequest,
  type UpdateAiDraftRequest,
  type UpdateAiSettingRequest,
  aiCapability,
  aiUsageQuery,
  approveAiDraftRequest,
  dailySummaryQuery,
  generateClinicalNoteDraftRequest,
  generateEncounterSummaryRequest,
  generatePatientSummaryRequest,
  generatePlanExplanationRequest,
  listAiActivityQuery,
  listAiDraftsQuery,
  nlAnalyticsRequest,
  regenerateDailySummaryRequest,
  rejectAiDraftRequest,
  updateAiDraftRequest,
  updateAiSettingRequest,
  voiceNoteDraftFields,
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
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { z } from "zod";
import { Can } from "../auth/auth.guard";
import type { Principal } from "../auth/roles";
import { CurrentPrincipal } from "../common/principal";
import { ZodPipe } from "../common/zod.pipe";
import { AiAdminService } from "./ai-admin.service";
import { AiDailySummaryService } from "./ai-daily-summary.service";
import { AiDraftsService } from "./ai-drafts.service";
import { AiGenerateService, type UploadedAudio } from "./ai-generate.service";

const Id = () => Param("id", new ParseUUIDPipe());

/** Multipart fields (strings) or a JSON body with `audioBase64`; `consentConfirmed` must be true either way. */
const voiceRequest = voiceNoteDraftFields.extend({
  consentConfirmed: z
    .union([z.boolean(), z.stringbool()])
    .refine((v) => v === true, "Patient consent to record is required"),
  audioBase64: z.string().max(14_000_000).optional(),
  mimeType: z.string().max(100).optional(),
});

/**
 * Admin / self-service surface of the AI module (ADR 0005 §5.4, §5.10, §5.11): the caller's capability list, per-capability
 * settings (`ai:admin`, org scope), usage and the append-only activity log (never returns prompt / response content).
 */
@Controller("ai")
export class AiAdminController {
  constructor(private readonly admin: AiAdminService) {}

  @Can("ai:use")
  @Get("capabilities")
  capabilities(@CurrentPrincipal() p: Principal) {
    return this.admin.capabilities(p);
  }

  @Can("ai:admin")
  @Get("settings")
  settings(@CurrentPrincipal() p: Principal) {
    return this.admin.settings(p);
  }

  @Can("ai:admin")
  @Patch("settings/:capability")
  updateSetting(
    @CurrentPrincipal() p: Principal,
    @Param("capability", new ZodPipe(aiCapability)) capability: AiCapability,
    @Body(new ZodPipe(updateAiSettingRequest)) body: UpdateAiSettingRequest,
  ) {
    return this.admin.updateSetting(p, capability, body);
  }

  @Can("ai:admin")
  @Get("usage")
  usage(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(aiUsageQuery)) q: z.infer<typeof aiUsageQuery>,
  ) {
    return this.admin.usage(p, q);
  }

  @Can("ai:admin")
  @Get("activity")
  activity(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listAiActivityQuery)) q: ListAiActivityQuery,
  ) {
    return this.admin.activity(p, q);
  }
}

/** The seven approved capabilities. Each draft endpoint answers with an `AiDraft` (status DRAFT, labelled). */
@Controller("ai")
export class AiGenerateController {
  constructor(
    private readonly gen: AiGenerateService,
    private readonly daily: AiDailySummaryService,
  ) {}

  @Can("ai:use")
  @Post("patient-summary")
  patientSummary(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(generatePatientSummaryRequest)) body: GeneratePatientSummaryRequest,
  ) {
    return this.gen.patientSummary(p, body);
  }

  @Can("ai:use")
  @Post("encounter-summary")
  encounterSummary(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(generateEncounterSummaryRequest)) body: GenerateEncounterSummaryRequest,
  ) {
    return this.gen.encounterSummary(p, body);
  }

  @Can("ai:clinical")
  @Post("clinical-note-draft")
  clinicalNoteDraft(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(generateClinicalNoteDraftRequest)) body: GenerateClinicalNoteDraftRequest,
  ) {
    return this.gen.clinicalNoteDraft(p, body);
  }

  /** Multipart (`audio` + text fields) or JSON with `audioBase64`. The audio stays in memory for the one provider call. */
  @Can("ai:clinical")
  @Post("voice-note-draft")
  @UseInterceptors(FileInterceptor("audio", { limits: { fileSize: AI_MAX_AUDIO_BYTES, files: 1 } }))
  voiceNoteDraft(
    @CurrentPrincipal() p: Principal,
    @UploadedFile() file: UploadedAudio | undefined,
    @Body(new ZodPipe(voiceRequest)) body: z.infer<typeof voiceRequest>,
  ) {
    const { audioBase64, mimeType, ...fields } = body;
    return this.gen.voiceNoteDraft(p, { ...fields, consentConfirmed: true }, file, {
      audioBase64,
      mimeType,
    });
  }

  @Can("ai:use")
  @Post("plan-explanation")
  planExplanation(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(generatePlanExplanationRequest)) body: GeneratePlanExplanationRequest,
  ) {
    return this.gen.planExplanation(p, body);
  }

  @Can("ai:use")
  @Get("nl-analytics/catalogue")
  nlCatalogue(@CurrentPrincipal() p: Principal) {
    return this.gen.nlCatalogue(p);
  }

  @Can("ai:use")
  @HttpCode(200)
  @Post("nl-analytics")
  nlAnalytics(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(nlAnalyticsRequest)) body: NlAnalyticsRequest,
  ) {
    return this.gen.nlAnalytics(p, body);
  }

  @Can("analytics:branch")
  @Get("daily-summary")
  dailySummary(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(dailySummaryQuery)) q: DailySummaryQuery,
  ) {
    return this.daily.get(p, q);
  }

  @Can("ai:use")
  @HttpCode(200)
  @Post("daily-summary/regenerate")
  regenerateDailySummary(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(regenerateDailySummaryRequest)) body: RegenerateDailySummaryRequest,
  ) {
    return this.daily.regenerate(p, body);
  }
}

/** Draft review: list, read, edit, approve, reject. Approving a note draft writes the notes as the approving dentist. */
@Controller("ai/drafts")
export class AiDraftsController {
  constructor(private readonly drafts: AiDraftsService) {}

  @Can("ai:use")
  @Get()
  list(
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(listAiDraftsQuery)) q: ListAiDraftsQuery,
  ) {
    return this.drafts.list(p, q);
  }

  @Can("ai:use")
  @Get(":id")
  get(@CurrentPrincipal() p: Principal, @Id() id: string) {
    return this.drafts.get(p, id);
  }

  @Can("ai:use")
  @Patch(":id")
  update(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(updateAiDraftRequest)) body: UpdateAiDraftRequest,
  ) {
    return this.drafts.update(p, id, body);
  }

  @Can("ai:use")
  @HttpCode(200)
  @Post(":id/approve")
  approve(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(approveAiDraftRequest)) body: ApproveAiDraftRequest,
  ) {
    return this.drafts.approve(p, id, body);
  }

  @Can("ai:use")
  @HttpCode(200)
  @Post(":id/reject")
  reject(
    @CurrentPrincipal() p: Principal,
    @Id() id: string,
    @Body(new ZodPipe(rejectAiDraftRequest)) body: RejectAiDraftRequest,
  ) {
    return this.drafts.reject(p, id, body);
  }
}
