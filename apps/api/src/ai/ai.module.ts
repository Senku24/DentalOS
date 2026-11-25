import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module";
import { AiAdminService } from "./ai-admin.service";
import { AiDailySummaryService } from "./ai-daily-summary.service";
import { AiDraftsService } from "./ai-drafts.service";
import { AiGateService } from "./ai-gate.service";
import { AiGenerateService } from "./ai-generate.service";
import { AiProviderService } from "./ai-provider.service";
import { AiAdminController, AiDraftsController, AiGenerateController } from "./ai.controller";

/**
 * M4 AI capabilities (PRD 5; ADR 0005 §5). Provider-agnostic: `AiProviderService` resolves `stub` (offline, deterministic) or
 * `openai-compatible` (fetch, 60 s timeout, no logging of prompts / responses) from env (AI_PROVIDER ..., default OFF).
 * Every call: `AiGateService.admit` (config, residency, setting, role, permission, atomic quota) -> minimised prompt ->
 * provider -> validated output -> `AiDraft` (DRAFT, provenance) + `AiUsage` + `AiActivityLog` (append-only, no content
 * unless `retainContent`). Approval of note drafts writes ClinicalNote rows authored by the approver. Voice audio is
 * transcribed in memory and never stored. NL analytics only runs a catalogue query through `AnalyticsQueryService`
 * (exported by AnalyticsModule: the one cross-module import). V1 assistant actions are proposals only (`aiProposal`; none are created automatically).
 * No imports from ../portal or ../portal-admin; reads earlier modules' pure helpers only.
 */
@Module({
  imports: [AnalyticsModule],
  controllers: [AiAdminController, AiGenerateController, AiDraftsController],
  providers: [
    AiProviderService,
    AiGateService,
    AiGenerateService,
    AiDraftsService,
    AiAdminService,
    AiDailySummaryService,
  ],
})
export class AiModule {}
