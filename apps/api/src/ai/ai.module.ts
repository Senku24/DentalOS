import { Module } from "@nestjs/common";

/**
 * M4 AI capabilities (PRD 5). Owner: I1 (apps/api/src/ai/** and the AI job handlers in apps/worker/src/handlers/ai*).
 * Provider-agnostic: depend on `AiProvider` from @dentalos/validation `ai.ts`; implement the `openai-compatible` adapter
 * here (fetch, 60 s timeout, never log prompts / responses) and use `createStubAiProvider()` for `AI_PROVIDER=stub`.
 * Order of every call: resolve config -> `evaluateAiAccess` (provider, region policy, setting, role, permission, quota) ->
 * build a minimised prompt (`build*Prompt`) -> provider -> validate output (`parseDraftContent`) -> store an `AiDraft` +
 * `AiUsage` increment + `AiActivityLog` row (append-only, no content unless `AiSetting.retainContent`). Approval of note
 * drafts writes ClinicalNote rows (`aiAssisted`, `aiDraftId`) authored by the approver in the same transaction. Voice audio
 * is transcribed in memory and never stored. NL analytics only runs a catalogue query chosen via `resolveNlAnalyticsPlan`.
 * V1 assistant actions are proposals only (`aiProposal`). See docs/M4-portal-analytics-ai.md and
 * docs/adr/0005-portal-analytics-ai-rules.md §5.
 */
@Module({})
export class AiModule {}
