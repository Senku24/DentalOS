import { type PrismaClient, type Tx } from "@dentalos/db";
import {
  AI_AUDIO_MIME_TYPES,
  AI_DRAFT_TTL_DAYS,
  AI_MAX_AUDIO_BYTES,
  ANALYTICS_CATALOGUE,
  type AiCapability,
  type AiDraftKind,
  type AiDraftResponse,
  type AiPrompt,
  type GenerateClinicalNoteDraftRequest,
  type GenerateEncounterSummaryRequest,
  type GeneratePatientSummaryRequest,
  type GeneratePlanExplanationRequest,
  NL_ANALYTICS_EXAMPLES,
  type NlAnalyticsCatalogueResponse,
  type NlAnalyticsRequest,
  type NlAnalyticsResponse,
  type VoiceNoteDraftFields,
  buildClinicalNotePrompt,
  buildEncounterSummaryPrompt,
  buildHistorySummaryPrompt,
  buildNlAnalyticsPrompt,
  buildPlanExplanationPrompt,
  extractJsonObject,
  parseDraftContent,
  resolveNlAnalyticsPlan,
} from "@dentalos/validation";
import { Inject, Injectable } from "@nestjs/common";
import { AnalyticsQueryService } from "../analytics/analytics-query.service";
import { PRISMA } from "../auth/auth.guard";
import { type Principal, can } from "../auth/roles";
import { loadEncounter } from "../clinical/clinical-common";
import { findActivePatient, findPatientOr404, lineageIds } from "../patients/patient-common";
import {
  aiError,
  asJson,
  conflict,
  encounterSigned,
  notFound,
  runTx,
  toDraftResponse,
} from "./ai-common";
import {
  branchForPatient,
  hasAiPermissions,
  loadEncounterFacts,
  loadHistoryFacts,
  loadNoteFacts,
  patientNames,
  planFactsFromSnapshot,
} from "./ai-context";
import { type Admission, AiGateService } from "./ai-gate.service";

/** Minimal shape of a multer memory-storage file (no @types/multer in this repo). */
export interface UploadedAudio {
  buffer: Uint8Array;
  mimetype: string;
  size: number;
}

const DAY_MS = 86_400_000;

interface DraftSpec {
  capability: AiCapability;
  kind: AiDraftKind;
  adm: Admission;
  prompt: AiPrompt;
  subject: { type: string; id: string };
  patientId: string;
  branchId: string;
  encounterId?: string;
  planVersionId?: string;
  /** Keys added to the validated content (e.g. the voice transcript). */
  extra?: Record<string, unknown>;
  /** Adjusts the model's JSON before validation (drops references to unknown plan items). */
  fix?: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The five draft-producing capabilities, voice, and natural-language analytics (ADR 0005 §5.1-§5.7). Every call: load the
 * subject header -> permissions at its branch -> `AiGateService.admit` (config, residency, setting, role, permission,
 * quota) -> minimised prompt from the caller-scoped read -> provider -> output validated by the kind's schema -> an
 * `AiDraft` (status DRAFT, provenance in metadata) + usage tokens + activity-log row in ONE transaction. Nothing the model
 * returns becomes a record; a failed validation is `ai_provider_error` (424) with no draft.
 */
@Injectable()
export class AiGenerateService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly gate: AiGateService,
    private readonly analytics: AnalyticsQueryService,
  ) {}

  // ------------------------------------------------------------------------------------------
  // Shared: provider call -> validation -> draft
  // ------------------------------------------------------------------------------------------

  private async produce(p: Principal, s: DraftSpec): Promise<AiDraftResponse> {
    const { adm, prompt } = s;
    const fail = async (
      code: "ai_provider_error",
      usage?: { promptTokens: number; completionTokens: number },
    ) => {
      await this.gate.finish(adm, {
        action: "generate",
        outcome: "error",
        errorCode: code,
        deidentified: true,
        usage,
      });
      return aiError(code);
    };
    let chat: Awaited<ReturnType<Admission["provider"]["chat"]>>;
    try {
      chat = await adm.provider.chat({
        task: prompt.task,
        promptVersion: prompt.promptVersion,
        system: prompt.system,
        user: prompt.user,
        payload: prompt.payload,
        language: prompt.language,
        json: true,
        maxOutputTokens: 3000,
      });
    } catch {
      throw await fail("ai_provider_error");
    }
    const raw = extractJsonObject(chat.text);
    const object =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const parsed = object
      ? parseDraftContent(s.kind, {
          ...(s.fix ? s.fix(object) : object),
          language: prompt.language,
          ...(s.extra ?? {}),
        })
      : null;
    if (!parsed?.success) throw await fail("ai_provider_error", chat.usage);

    const draft = await runTx(this.prisma, p, async (tx) => {
      const row = await tx.aiDraft.create({
        data: {
          tenantId: p.tenantId,
          kind: s.kind,
          subjectType: s.subject.type,
          subjectId: s.subject.id,
          patientId: s.patientId,
          branchId: s.branchId,
          encounterId: s.encounterId ?? null,
          planVersionId: s.planVersionId ?? null,
          content: asJson(parsed.data),
          metadata: asJson({
            provider: chat.provider,
            model: chat.model,
            promptVersion: prompt.promptVersion,
            aiGenerated: true,
            deidentified: prompt.deidentified,
            language: prompt.language,
            promptTokens: chat.usage.promptTokens,
            completionTokens: chat.usage.completionTokens,
          }),
          createdBy: p.userId,
          expiresAt: new Date(Date.now() + AI_DRAFT_TTL_DAYS * DAY_MS),
        },
      });
      await this.gate.finish(
        adm,
        {
          action: "generate",
          outcome: "success",
          draftId: row.id,
          usage: chat.usage,
          deidentified: prompt.deidentified,
          content: { prompt: prompt.user, response: chat.text },
        },
        tx,
      );
      return row;
    });
    return await toDraftResponse(draft);
  }

  // ------------------------------------------------------------------------------------------
  // 1. Patient history summary
  // ------------------------------------------------------------------------------------------

  async patientSummary(p: Principal, body: GeneratePatientSummaryRequest) {
    const patient = await runTx(this.prisma, p, (tx) => findActivePatient(tx, body.patientId));
    const branchId = branchForPatient(p, patient);
    const capability = "patient_history_summary" as const;
    const adm = await this.gate.admit({
      p,
      capability,
      scope: "PATIENT",
      branchId,
      patientId: patient.id,
      hasPermissions: !!branchId && hasAiPermissions(p, capability, branchId),
    });
    const prompt = await runTx(this.prisma, p, async (tx) =>
      buildHistorySummaryPrompt(await loadHistoryFacts(tx, p, patient), {
        language: body.language,
        knownNames: patientNames(patient),
      }),
    );
    return this.produce(p, {
      capability,
      kind: "PATIENT_HISTORY_SUMMARY",
      adm,
      prompt,
      subject: { type: "patient", id: patient.id },
      patientId: patient.id,
      branchId: branchId as string,
    });
  }

  // ------------------------------------------------------------------------------------------
  // 2. Encounter summary
  // ------------------------------------------------------------------------------------------

  async encounterSummary(p: Principal, body: GenerateEncounterSummaryRequest) {
    const { enc, patient } = await runTx(this.prisma, p, async (tx) => {
      const enc = await loadEncounter(tx, body.encounterId);
      return { enc, patient: await findPatientOr404(tx, enc.patientId) };
    });
    const capability = "encounter_summary" as const;
    const adm = await this.gate.admit({
      p,
      capability,
      scope: "PATIENT",
      branchId: enc.branchId,
      patientId: enc.patientId,
      hasPermissions: hasAiPermissions(p, capability, enc.branchId),
    });
    const prompt = await runTx(this.prisma, p, async (tx) =>
      buildEncounterSummaryPrompt(await loadEncounterFacts(tx, enc, patient), {
        language: body.language,
        knownNames: patientNames(patient),
      }),
    );
    return this.produce(p, {
      capability,
      kind: "ENCOUNTER_SUMMARY",
      adm,
      prompt,
      subject: { type: "encounter", id: enc.id },
      patientId: enc.patientId,
      branchId: enc.branchId,
      encounterId: enc.id,
    });
  }

  // ------------------------------------------------------------------------------------------
  // 3. Clinical note draft (typed rough notes)
  // ------------------------------------------------------------------------------------------

  async clinicalNoteDraft(p: Principal, body: GenerateClinicalNoteDraftRequest) {
    const { enc, patient } = await runTx(this.prisma, p, async (tx) => {
      const enc = await loadEncounter(tx, body.encounterId);
      return { enc, patient: await findPatientOr404(tx, enc.patientId) };
    });
    const capability = "clinical_note_draft" as const;
    const permitted = hasAiPermissions(p, capability, enc.branchId);
    // A signed encounter never gets a note draft (quota untouched); callers without access hit the gate's denial instead.
    if (permitted && enc.status !== "OPEN") throw encounterSigned();
    const adm = await this.gate.admit({
      p,
      capability,
      scope: "PATIENT",
      branchId: enc.branchId,
      patientId: enc.patientId,
      hasPermissions: permitted,
    });
    const prompt = await runTx(this.prisma, p, async (tx) =>
      buildClinicalNotePrompt(await loadNoteFacts(tx, enc, patient, body.clinicianNotes ?? ""), {
        language: body.language,
        knownNames: patientNames(patient),
        source: "typed",
      }),
    );
    return this.produce(p, {
      capability,
      kind: "CLINICAL_NOTE",
      adm,
      prompt,
      subject: { type: "encounter", id: enc.id },
      patientId: enc.patientId,
      branchId: enc.branchId,
      encounterId: enc.id,
    });
  }

  // ------------------------------------------------------------------------------------------
  // 4. Voice -> clinical note draft (audio in memory only)
  // ------------------------------------------------------------------------------------------

  async voiceNoteDraft(
    p: Principal,
    fields: VoiceNoteDraftFields,
    file: UploadedAudio | undefined,
    base64: { audioBase64?: string; mimeType?: string } = {},
  ) {
    // Input checks first: nothing is sent anywhere for a bad upload, and the audio never touches disk / DB.
    let audio: Uint8Array | undefined = file?.buffer;
    let mimeType = file?.mimetype ?? base64.mimeType ?? "";
    if (!audio && base64.audioBase64) audio = Buffer.from(base64.audioBase64, "base64");
    mimeType = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!audio || audio.byteLength === 0) throw aiError("ai_audio_invalid", { reason: "missing" });
    if (audio.byteLength > AI_MAX_AUDIO_BYTES)
      throw aiError("ai_audio_invalid", { reason: "too_large", maxBytes: AI_MAX_AUDIO_BYTES });
    if (!(AI_AUDIO_MIME_TYPES as readonly string[]).includes(mimeType))
      throw aiError("ai_audio_invalid", { reason: "unsupported_type" });

    const { enc, patient, consented } = await runTx(this.prisma, p, async (tx) => {
      const enc = await loadEncounter(tx, fields.encounterId);
      const patient = await findPatientOr404(tx, enc.patientId);
      const ids = await lineageIds(tx, patient.id);
      const latest = await tx.patientConsent.findFirst({
        where: { patientId: { in: ids }, type: "AI_TRANSCRIPTION" },
        orderBy: { createdAt: "desc" },
        select: { status: true },
      });
      return { enc, patient, consented: latest?.status === "GRANTED" };
    });
    const capability = "voice_note_draft" as const;
    const permitted = hasAiPermissions(p, capability, enc.branchId);
    if (permitted && enc.status !== "OPEN") throw encounterSigned();
    if (permitted && !consented) {
      await this.gate.record(undefined, {
        tenantId: p.tenantId,
        actorId: p.userId,
        scope: "PATIENT",
        branchId: enc.branchId,
        patientId: enc.patientId,
        capability,
        provider: this.gate.providerName(),
        model: "none",
        action: "refuse",
        outcome: "refused",
        errorCode: "ai_consent_required",
      });
      throw aiError("ai_consent_required");
    }
    const adm = await this.gate.admit({
      p,
      capability,
      scope: "PATIENT",
      branchId: enc.branchId,
      patientId: enc.patientId,
      hasPermissions: permitted,
    });

    let transcript: Awaited<ReturnType<Admission["provider"]["transcribe"]>>;
    try {
      transcript = await adm.provider.transcribe({ audio, mimeType, language: fields.language });
    } catch {
      await this.gate.finish(adm, {
        action: "transcribe",
        outcome: "error",
        errorCode: "ai_provider_error",
      });
      throw aiError("ai_provider_error");
    } finally {
      // The audio lived in memory for this one call: drop every reference we hold.
      audio = undefined;
      if (file) file.buffer = new Uint8Array(0);
    }
    if (!transcript.text.trim()) {
      await this.gate.finish(adm, {
        action: "transcribe",
        outcome: "error",
        errorCode: "ai_audio_invalid",
        usage: transcript.usage,
      });
      throw aiError("ai_audio_invalid", { reason: "no_speech" });
    }
    await this.gate.finish(adm, {
      action: "transcribe",
      outcome: "success",
      usage: transcript.usage,
      deidentified: false,
    });

    const prompt = await runTx(this.prisma, p, async (tx) =>
      buildClinicalNotePrompt(await loadNoteFacts(tx, enc, patient, transcript.text), {
        language: transcript.language,
        knownNames: patientNames(patient),
        source: "voice",
      }),
    );
    return this.produce(p, {
      capability,
      kind: "VOICE_NOTE",
      adm,
      prompt,
      subject: { type: "encounter", id: enc.id },
      patientId: enc.patientId,
      branchId: enc.branchId,
      encounterId: enc.id,
      // The transcript TEXT stays in the draft for the dentist's comparison (never the audio).
      extra: { transcript: transcript.text.slice(0, 50_000) },
    });
  }

  // ------------------------------------------------------------------------------------------
  // 5. Patient-friendly plan explanation
  // ------------------------------------------------------------------------------------------

  async planExplanation(p: Principal, body: GeneratePlanExplanationRequest) {
    const found = await runTx(this.prisma, p, async (tx: Tx) => {
      const plan = await tx.treatmentPlan.findUnique({ where: { id: body.planId } });
      if (!plan) throw notFound("plan_not_found");
      return plan;
    });
    const capability = "plan_explanation" as const;
    const permitted = hasAiPermissions(p, capability, found.branchId);
    const adm = await this.gate.admit({
      p,
      capability,
      scope: "PATIENT",
      branchId: found.branchId,
      patientId: found.patientId,
      hasPermissions: permitted,
    });
    const version = await runTx(this.prisma, p, async (tx) => {
      const n = body.planVersion ?? found.currentVersion;
      if (n < 1) throw conflict("plan_not_presented");
      const v = await tx.treatmentPlanVersion.findUnique({
        where: { tenantId_planId_version: { tenantId: p.tenantId, planId: found.id, version: n } },
      });
      if (!v) throw notFound("plan_version_not_found");
      return v;
    }).catch(async (e) => {
      // The plan lookup failed after the quota was taken: account for it as an error, then surface the real reason.
      await this.gate.finish(adm, {
        action: "generate",
        outcome: "error",
        errorCode: "plan_version",
      });
      throw e;
    });
    const facts = planFactsFromSnapshot(version.snapshot);
    const prompt = buildPlanExplanationPrompt(facts, { language: body.language });
    const known = new Set(facts.items.map((i) => i.planItemId));
    return this.produce(p, {
      capability,
      kind: "PLAN_EXPLANATION",
      adm,
      prompt,
      subject: { type: "plan_version", id: version.id },
      patientId: found.patientId,
      branchId: found.branchId,
      planVersionId: version.id,
      fix: (raw) => ({
        ...raw,
        itemNotes: Array.isArray(raw.itemNotes)
          ? raw.itemNotes.filter(
              (n) =>
                n &&
                typeof n === "object" &&
                known.has(String((n as { planItemId?: unknown }).planItemId)),
            )
          : [],
      }),
    });
  }

  // ------------------------------------------------------------------------------------------
  // 6. Natural-language analytics (catalogue only)
  // ------------------------------------------------------------------------------------------

  async nlCatalogue(p: Principal): Promise<NlAnalyticsCatalogueResponse> {
    return {
      queries: Object.values(ANALYTICS_CATALOGUE).map((q) => ({
        id: q.id,
        title: q.title,
        description: q.description,
        scope: q.scope,
        financial: q.financial,
        available:
          (q.scope === "branch" ? can(p, "analytics:branch") : can(p, "analytics:org")) &&
          (!q.financial || can(p, "finance:report")),
      })),
      examples: [...NL_ANALYTICS_EXAMPLES],
    };
  }

  async nlAnalytics(p: Principal, body: NlAnalyticsRequest): Promise<NlAnalyticsResponse> {
    const capability = "nl_analytics" as const;
    const resource = body.branchId ? { branchId: body.branchId } : {};
    const adm = await this.gate.admit({
      p,
      capability,
      scope: body.branchId || !p.orgWide ? "BRANCH" : "ORG",
      branchId: body.branchId ?? (p.orgWide ? null : (p.branchScope[0] ?? null)),
      hasPermissions: can(p, "ai:use", resource) && can(p, "analytics:branch", resource),
    });
    const today = new Date().toISOString().slice(0, 10);
    const prompt = buildNlAnalyticsPrompt(body.question, { today });
    const label = {
      provider: adm.provider.name,
      model: adm.provider.model,
      promptVersion: prompt.promptVersion,
    };
    let chat: Awaited<ReturnType<Admission["provider"]["chat"]>>;
    try {
      chat = await adm.provider.chat({
        task: prompt.task,
        promptVersion: prompt.promptVersion,
        system: prompt.system,
        user: prompt.user,
        payload: prompt.payload,
        language: "en",
        json: true,
        maxOutputTokens: 500,
      });
    } catch {
      await this.gate.finish(adm, {
        action: "query",
        outcome: "error",
        errorCode: "ai_provider_error",
        deidentified: true,
      });
      throw aiError("ai_provider_error");
    }
    const plan = resolveNlAnalyticsPlan(chat.text, {
      orgWide: p.orgWide && can(p, "analytics:org"),
      financeVisible: can(p, "finance:report", resource),
      branchScope: p.branchScope,
    });
    const content = { prompt: prompt.user, response: chat.text };
    if (!plan.ok) {
      const logId = await this.gate.finish(adm, {
        action: "query",
        outcome: "refused",
        errorCode: `nl_${plan.reason}`,
        usage: chat.usage,
        deidentified: true,
        content,
      });
      return {
        question: body.question,
        resolved: null,
        refusal: plan.reason,
        data: null,
        label: { ...label, model: chat.model },
        logId,
      };
    }
    const entry = ANALYTICS_CATALOGUE[plan.queryId];
    const params = { ...plan.params };
    if (body.branchId && (entry.uses as readonly string[]).includes("branchId") && !params.branchId)
      params.branchId = body.branchId;
    let data: unknown;
    try {
      data = (await this.analytics.run(p, plan.queryId, params)).data;
    } catch (e) {
      await this.gate.finish(adm, {
        action: "query",
        outcome: "error",
        errorCode: String(
          (e as { response?: { error?: string } })?.response?.error ?? "analytics_error",
        ),
        usage: chat.usage,
        deidentified: true,
        content,
      });
      throw e;
    }
    const logId = await this.gate.finish(adm, {
      action: "query",
      outcome: "success",
      usage: chat.usage,
      deidentified: true,
      content,
    });
    return {
      question: body.question,
      resolved: { queryId: plan.queryId, title: entry.title, params },
      refusal: null,
      data,
      label: { ...label, model: chat.model },
      logId,
    };
  }
}
