import { z } from "zod";
import {
  ANALYTICS_CATALOGUE,
  type AnalyticsQueryParams,
  aiLabel,
  analyticsQueryId,
  analyticsQueryParams,
  analyticsSnapshotResponse,
} from "./analytics";
import {
  dateOnly,
  isoDateTime,
  optionalText,
  pageQuery,
  staffRole,
  staffUserId,
  trimmed,
  uuid,
} from "./common";
import { sha256Hex } from "./portal";

// AI capabilities (PRD 5, 7.1): provider-agnostic provider contract, a deterministic stub, minimised prompt builders,
// draft shapes, settings / quota / access evaluators, the natural-language analytics planner and the DTOs.
// Rules: docs/adr/0005-portal-analytics-ai-rules.md §5 (PROPOSED — needs product sign-off).
// Frontend-safe and network-free: the real provider adapter (`openai-compatible`) lives in apps/api/src/ai.
//
// NON-NEGOTIABLES encoded here: nothing the model returns becomes a record by itself (drafts are reviewed and approved by a
// human); prompts carry no direct identifiers; identifiable clinical text only goes to region-compliant providers; the
// assistant can only choose among the fixed analytics catalogue; V1 mutations are proposals, never executed.

// ---------------------------------------------------------------------------------------------
// Capabilities (PRD 5.2) and per-capability rules
// ---------------------------------------------------------------------------------------------

export const AI_CAPABILITIES = [
  "patient_history_summary",
  "encounter_summary",
  "clinical_note_draft",
  "voice_note_draft",
  "plan_explanation",
  "nl_analytics",
  "daily_branch_summary",
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];
export const aiCapability = z.enum(AI_CAPABILITIES);

export const AI_DRAFT_KINDS = [
  "PATIENT_HISTORY_SUMMARY",
  "ENCOUNTER_SUMMARY",
  "CLINICAL_NOTE",
  "VOICE_NOTE",
  "PLAN_EXPLANATION",
] as const;
export type AiDraftKind = (typeof AI_DRAFT_KINDS)[number];
export const aiDraftKind = z.enum(AI_DRAFT_KINDS);
export const AI_DRAFT_STATUSES = ["DRAFT", "APPROVED", "REJECTED", "EXPIRED"] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];
export const aiDraftStatus = z.enum(AI_DRAFT_STATUSES);

export const AI_LANGUAGES = ["en", "hi"] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];
export const aiLanguage = z.enum(AI_LANGUAGES);

/**
 * What a capability sends to the model, which decides the India data-residency rule (PRD 5.6, 7.1):
 *  - `aggregate`     counts and amounts only, no patient data     -> any provider
 *  - `structured`    service names / tooth numbers / prices        -> any provider (no direct identifiers, no free text)
 *  - `clinical_text` free-text clinical content (history, notes, transcripts) -> ONLY region-compliant providers
 */
export type AiDataClass = "aggregate" | "structured" | "clinical_text";

export interface AiCapabilityInfo {
  code: AiCapability;
  title: string;
  description: string;
  /** DB kind of the draft it produces; null = no draft (an answer, or a stored snapshot). */
  draftKind: AiDraftKind | null;
  dataClass: AiDataClass;
  /** Permission needed to call it (the data it reads needs its own permissions too, see `dataPermissions`). */
  permission: "ai:use" | "ai:clinical";
  /** Permissions on the underlying data (all at the subject's branch). */
  dataPermissions: readonly string[];
  /** A dentist must approve the output before it is a record or reaches a patient. */
  requiresDentistApproval: boolean;
  /** Roles enabled by default when an admin switches the capability on. */
  defaultRoles: readonly z.infer<typeof staffRole>[];
  /** Monthly request quota used when `AiSetting.monthlyQuota` is NULL (commercial config, PRD 12.3). */
  defaultMonthlyQuota: number;
}

export const AI_CAPABILITY_CATALOGUE: Readonly<Record<AiCapability, AiCapabilityInfo>> = {
  patient_history_summary: {
    code: "patient_history_summary",
    title: "Patient history summary",
    description:
      "Summarises medical history, allergies, alerts and recent treatment for the dentist.",
    draftKind: "PATIENT_HISTORY_SUMMARY",
    dataClass: "clinical_text",
    permission: "ai:use",
    dataPermissions: ["patient:read", "medical:read", "clinical:read"],
    requiresDentistApproval: false,
    defaultRoles: ["DENTIST"],
    defaultMonthlyQuota: 300,
  },
  encounter_summary: {
    code: "encounter_summary",
    title: "Encounter summary",
    description: "Summarises a clinical encounter (findings, procedures, follow-up).",
    draftKind: "ENCOUNTER_SUMMARY",
    dataClass: "clinical_text",
    permission: "ai:use",
    dataPermissions: ["clinical:read"],
    requiresDentistApproval: false,
    defaultRoles: ["DENTIST"],
    defaultMonthlyQuota: 300,
  },
  clinical_note_draft: {
    code: "clinical_note_draft",
    title: "Clinical note draft",
    description:
      "Drafts SOAP notes for an open encounter; the dentist edits and approves before it is saved.",
    draftKind: "CLINICAL_NOTE",
    dataClass: "clinical_text",
    permission: "ai:clinical",
    dataPermissions: ["clinical:read", "clinical:write"],
    requiresDentistApproval: true,
    defaultRoles: ["DENTIST"],
    defaultMonthlyQuota: 300,
  },
  voice_note_draft: {
    code: "voice_note_draft",
    title: "Voice to clinical note (English / Hindi)",
    description:
      "Transcribes dictation (audio is never stored) and drafts SOAP notes for the dentist to review.",
    draftKind: "VOICE_NOTE",
    dataClass: "clinical_text",
    permission: "ai:clinical",
    dataPermissions: ["clinical:read", "clinical:write"],
    requiresDentistApproval: true,
    defaultRoles: ["DENTIST"],
    defaultMonthlyQuota: 150,
  },
  plan_explanation: {
    code: "plan_explanation",
    title: "Patient-friendly plan explanation",
    description:
      "Explains a treatment plan in plain English or Hindi; shown to the patient only after a dentist approves it.",
    draftKind: "PLAN_EXPLANATION",
    dataClass: "structured",
    permission: "ai:use",
    dataPermissions: ["plan:read"],
    requiresDentistApproval: true,
    defaultRoles: ["DENTIST"],
    defaultMonthlyQuota: 200,
  },
  nl_analytics: {
    code: "nl_analytics",
    title: "Ask your analytics",
    description:
      "Answers business questions by choosing one of the fixed analytics queries; results follow your own permissions.",
    draftKind: null,
    dataClass: "aggregate",
    permission: "ai:use",
    dataPermissions: ["analytics:branch"],
    requiresDentistApproval: false,
    defaultRoles: ["OWNER", "MANAGER", "ACCOUNTANT"],
    defaultMonthlyQuota: 500,
  },
  daily_branch_summary: {
    code: "daily_branch_summary",
    title: "Daily branch summary",
    description: "A short narrative of yesterday's branch numbers, generated by a nightly job.",
    draftKind: null,
    dataClass: "aggregate",
    permission: "ai:use",
    dataPermissions: ["analytics:branch"],
    requiresDentistApproval: false,
    defaultRoles: ["OWNER", "MANAGER"],
    defaultMonthlyQuota: 1000,
  },
};

/** Drafts not reviewed within this many days become EXPIRED (sweep job). */
export const AI_DRAFT_TTL_DAYS = 14;
export const AI_DRAFT_LABEL = "AI-generated draft — review before use";
export const AI_APPROVED_LABEL = "AI-assisted, reviewed and approved by a dentist";

/** Stable error codes of the AI API. */
export const AI_ERROR_CODES = [
  "ai_disabled",
  "ai_capability_disabled",
  "ai_role_denied",
  "ai_quota_exceeded",
  "ai_region_not_compliant",
  "ai_provider_error",
  "ai_consent_required",
  "ai_audio_invalid",
  "ai_draft_not_found",
  "ai_draft_final",
  "ai_draft_expired",
  "ai_draft_content_invalid",
  "ai_encounter_signed",
  "ai_content_changed",
  "ai_refused",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

// ---------------------------------------------------------------------------------------------
// Provider configuration and contract
// ---------------------------------------------------------------------------------------------

export const AI_PROVIDERS = ["stub", "openai-compatible"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];
export const AI_PROVIDER_STUB_MODEL = "stub-1";

export interface AiConfig {
  /** `disabled` = no provider configured: every capability answers `ai_disabled`. */
  provider: AiProviderName | "disabled";
  model: string;
  baseUrl: string | null;
  /** Set when the endpoint's region / contract was validated for India-only processing (AI_REGION_COMPLIANT=true). */
  regionCompliant: boolean;
  /** Why a configured provider was rejected (misconfiguration); null when fine or intentionally disabled. */
  problem: string | null;
}

/**
 * Environment knobs (all optional; AI is OFF by default):
 *   AI_PROVIDER=stub | openai-compatible     AI_BASE_URL=https://…/v1     AI_API_KEY=…     AI_MODEL=…
 *   AI_STT_MODEL=…  (speech-to-text model for transcribe; default = AI_MODEL)   AI_REGION_COMPLIANT=true
 * The API key is never part of this object.
 */
export function resolveAiConfig(env: Readonly<Record<string, string | undefined>>): AiConfig {
  const provider = env.AI_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "disabled" || provider === "off")
    return {
      provider: "disabled",
      model: "",
      baseUrl: null,
      regionCompliant: false,
      problem: null,
    };
  if (provider === "stub")
    return {
      provider: "stub",
      model: AI_PROVIDER_STUB_MODEL,
      baseUrl: null,
      regionCompliant: true,
      problem: null,
    };
  if (provider !== "openai-compatible")
    return {
      provider: "disabled",
      model: "",
      baseUrl: null,
      regionCompliant: false,
      problem: `Unknown AI_PROVIDER "${provider}"`,
    };
  const baseUrl = env.AI_BASE_URL?.trim().replace(/\/$/, "") || null;
  const model = env.AI_MODEL?.trim() || "";
  const missing = [
    !baseUrl && "AI_BASE_URL",
    !env.AI_API_KEY?.trim() && "AI_API_KEY",
    !model && "AI_MODEL",
  ]
    .filter(Boolean)
    .join(", ");
  if (missing)
    return {
      provider: "disabled",
      model: "",
      baseUrl: null,
      regionCompliant: false,
      problem: `openai-compatible provider needs ${missing}`,
    };
  if (
    baseUrl &&
    !/^https:\/\//.test(baseUrl) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)
  )
    return {
      provider: "disabled",
      model: "",
      baseUrl: null,
      regionCompliant: false,
      problem: "AI_BASE_URL must be https (http only for localhost)",
    };
  return {
    provider: "openai-compatible",
    model,
    baseUrl,
    regionCompliant: env.AI_REGION_COMPLIANT === "true",
    problem: null,
  };
}

export const AI_TASKS = [
  "history_summary",
  "encounter_summary",
  "clinical_note",
  "voice_note",
  "plan_explanation",
  "nl_analytics",
  "daily_summary",
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiChatRequest {
  task: AiTask;
  promptVersion: string;
  system: string;
  user: string;
  /** The minimised structured facts the prompt was built from (the stub reads these; real providers ignore them). */
  payload: Readonly<Record<string, unknown>>;
  language: AiLanguage;
  /** Ask for a JSON object (every task here returns JSON). */
  json: boolean;
  maxOutputTokens?: number;
}
export interface AiChatResult {
  text: string;
  provider: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
  finishReason: "stop" | "length";
}
export interface AiTranscribeRequest {
  audio: Uint8Array;
  mimeType: string;
  language: AiLanguage | "auto";
}
export interface AiTranscribeResult {
  text: string;
  language: AiLanguage;
  provider: string;
  model: string;
  durationSeconds: number | null;
  usage: { promptTokens: number; completionTokens: number };
}
/**
 * The only thing business code depends on. Implementations: `stub` (below, deterministic, no network) and
 * `openai-compatible` (apps/api/src/ai). Adapters must time out (<= 60 s), never log prompts or responses, and surface
 * failures as thrown errors (callers log an `AiActivityLog` row with outcome `error` and show `ai_provider_error`).
 */
export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  readonly regionCompliant: boolean;
  chat(req: AiChatRequest, opts?: { signal?: AbortSignal }): Promise<AiChatResult>;
  /** Audio is held in memory only for this call; it is never written anywhere. */
  transcribe(
    req: AiTranscribeRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<AiTranscribeResult>;
}

/** Cheap token estimate (4 characters per token) for quotas when the provider returns no usage. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export type AiDataPolicy =
  | { allowed: true; reason: null }
  | { allowed: false; reason: "disabled" | "region_not_compliant" };

/**
 * India data-residency gate (PRD 5.6, 7.1) — decided BEFORE any prompt is built:
 * no provider -> refuse; stub (no network) -> allow; a region-compliant provider -> allow; any other provider -> only
 * `aggregate` / `structured` data classes (still without direct identifiers), `clinical_text` is refused.
 */
export function aiDataPolicy(config: AiConfig, capability: AiCapability): AiDataPolicy {
  if (config.provider === "disabled") return { allowed: false, reason: "disabled" };
  if (config.provider === "stub" || config.regionCompliant) return { allowed: true, reason: null };
  return AI_CAPABILITY_CATALOGUE[capability].dataClass === "clinical_text"
    ? { allowed: false, reason: "region_not_compliant" }
    : { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------------------------
// Access, quota and month helpers (pure)
// ---------------------------------------------------------------------------------------------

export type AiDenial =
  | "provider_disabled"
  | "capability_disabled"
  | "role_not_allowed"
  | "permission_missing"
  | "quota_exceeded"
  | "region_not_compliant";

/**
 * Server-side gate for one AI call. All inputs are facts the service resolved itself (never client input):
 * the provider config, the tenant's `AiSetting` row (undefined = no row = off), the caller's roles and whether they hold
 * the capability's permissions, and this month's request count.
 */
export function evaluateAiAccess(input: {
  config: AiConfig;
  capability: AiCapability;
  setting:
    | { enabled: boolean; allowedRoles: readonly string[]; monthlyQuota: number | null }
    | undefined;
  roles: readonly string[];
  hasPermissions: boolean;
  usedThisMonth: number;
}): AiDenial[] {
  const denials: AiDenial[] = [];
  const policy = aiDataPolicy(input.config, input.capability);
  if (!policy.allowed)
    denials.push(policy.reason === "disabled" ? "provider_disabled" : "region_not_compliant");
  if (!input.setting?.enabled) denials.push("capability_disabled");
  else {
    if (!input.roles.some((r) => input.setting?.allowedRoles.includes(r)))
      denials.push("role_not_allowed");
    const quota =
      input.setting.monthlyQuota ?? AI_CAPABILITY_CATALOGUE[input.capability].defaultMonthlyQuota;
    if (input.usedThisMonth >= quota) denials.push("quota_exceeded");
  }
  if (!input.hasPermissions) denials.push("permission_missing");
  return denials;
}

export const AI_DENIAL_ERROR: Readonly<Record<AiDenial, AiErrorCode>> = {
  provider_disabled: "ai_disabled",
  capability_disabled: "ai_capability_disabled",
  role_not_allowed: "ai_role_denied",
  permission_missing: "ai_role_denied",
  quota_exceeded: "ai_quota_exceeded",
  region_not_compliant: "ai_region_not_compliant",
};

/** Remaining requests this month (`null` = unlimited is never returned: a quota always applies). */
export function aiQuotaRemaining(
  capability: AiCapability,
  monthlyQuota: number | null,
  used: number,
): { quota: number; remaining: number } {
  const quota = monthlyQuota ?? AI_CAPABILITY_CATALOGUE[capability].defaultMonthlyQuota;
  return { quota, remaining: Math.max(quota - used, 0) };
}

/** First day of the month containing `at` in `timeZone`, "YYYY-MM-01" (the `AiUsage.month` value). */
export function aiUsageMonth(at: Date, timeZone = "Asia/Kolkata"): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" })
    .formatToParts(at)
    .reduce<Record<string, string>>((a, x) => {
      a[x.type] = x.value;
      return a;
    }, {});
  return `${p.year}-${p.month}-01`;
}

// ---------------------------------------------------------------------------------------------
// Minimisation and de-identification (pure)
// ---------------------------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s-]{8,}\d)/g;
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/g;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes direct identifiers from free text: e-mails, phone numbers, Aadhaar / PAN shaped numbers, and every given
 * name token (>= 2 letters, case-insensitive). Best effort — which is why `clinical_text` capabilities are refused for
 * non-compliant providers instead of relying on this. Returns the cleaned text and the number of replacements.
 */
export function deidentifyText(
  text: string,
  knownNames: readonly string[] = [],
): { text: string; redactions: number } {
  let redactions = 0;
  const sub = (re: RegExp, token: string) => {
    out = out.replace(re, () => {
      redactions++;
      return token;
    });
  };
  let out = text;
  sub(EMAIL_RE, "[EMAIL]");
  sub(AADHAAR_RE, "[ID]");
  sub(PAN_RE, "[ID]");
  sub(PHONE_RE, "[PHONE]");
  const tokens = [
    ...new Set(knownNames.flatMap((n) => n.split(/\s+/)).filter((t) => t.length >= 2)),
  ];
  for (const t of tokens) sub(new RegExp(`\\b${escapeRe(t)}\\b`, "gi"), "[PATIENT]");
  return { text: out, redactions };
}

/** Age in whole years at `now` from a "YYYY-MM-DD" date of birth; null when unknown / in the future. */
export function ageYears(dob: string | null | undefined, now: Date = new Date()): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  if (!y || !m || !d) return null;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age--;
  return age >= 0 ? age : null;
}

/** 34 -> "30-39"; < 18 -> "under 18"; >= 90 -> "90+". Prompts get the band, never the date of birth. */
export function ageBand(age: number | null): string | null {
  if (age === null) return null;
  if (age < 18) return "under 18";
  if (age >= 90) return "90+";
  const lo = Math.floor(age / 10) * 10;
  return `${lo}-${lo + 9}`;
}

export interface AiPrompt {
  task: AiTask;
  promptVersion: string;
  system: string;
  user: string;
  payload: Record<string, unknown>;
  language: AiLanguage;
  /** Direct identifiers were excluded / scrubbed (always true for these builders). */
  deidentified: true;
  redactions: number;
}

export const AI_PROMPT_VERSIONS = {
  history_summary: "history-summary.v1",
  encounter_summary: "encounter-summary.v1",
  clinical_note: "clinical-note.v1",
  voice_note: "voice-note.v1",
  plan_explanation: "plan-explanation.v1",
  nl_analytics: "nl-analytics.v1",
  daily_summary: "daily-summary.v1",
} as const satisfies Record<AiTask, string>;

const LANGUAGE_NAME: Record<AiLanguage, string> = { en: "English", hi: "Hindi (Devanagari)" };
const SAFETY_CLINICAL =
  "You assist a licensed dentist by drafting text for their review. You are not the clinician: do not diagnose, prescribe, " +
  "choose or authorise treatment, or state anything that is not in the provided facts. Say 'not documented' instead of guessing. " +
  "Never include names, phone numbers, e-mail addresses, addresses or ID numbers. Respond with a single JSON object only.";

const MAX_FREE_TEXT = 4000;
interface Scrubber {
  names: readonly string[];
  redactions: number;
}
function scrub(s: Scrubber, text: string | null | undefined, max = MAX_FREE_TEXT): string {
  if (!text) return "";
  const r = deidentifyText(text.trim().slice(0, max), s.names);
  s.redactions += r.redactions;
  return r.text;
}
const scrubList = (
  s: Scrubber,
  items: readonly (string | null | undefined)[] | undefined,
  max = 200,
  cap = 30,
) =>
  (items ?? [])
    .slice(0, cap)
    .map((i) => scrub(s, i, max))
    .filter(Boolean);

export interface PromptContext {
  language: AiLanguage;
  /** Names of the patient / relatives to strip from free text. */
  knownNames?: readonly string[];
}

/** Allow-listed facts for a history summary. Pass only these; extra properties are ignored by construction. */
export interface HistorySummaryFacts {
  ageYears: number | null;
  sex: string | null;
  allergies: readonly { substance: string; severity?: string | null; reaction?: string | null }[];
  conditions: readonly string[];
  medications: readonly string[];
  alerts: readonly string[];
  recentEncounters: readonly {
    date: string;
    diagnoses: readonly string[];
    procedures: readonly string[];
    notes?: string | null;
  }[];
  habits?: readonly string[];
}

export function buildHistorySummaryPrompt(
  facts: HistorySummaryFacts,
  ctx: PromptContext,
): AiPrompt {
  const s: Scrubber = { names: ctx.knownNames ?? [], redactions: 0 };
  const payload = {
    ageBand: ageBand(facts.ageYears),
    sex: facts.sex,
    allergies: facts.allergies.slice(0, 30).map((a) => ({
      substance: scrub(s, a.substance, 100),
      severity: a.severity ?? null,
      reaction: scrub(s, a.reaction, 150),
    })),
    conditions: scrubList(s, facts.conditions),
    medications: scrubList(s, facts.medications),
    alerts: scrubList(s, facts.alerts),
    habits: scrubList(s, facts.habits),
    recentEncounters: facts.recentEncounters.slice(0, 10).map((e) => ({
      date: e.date,
      diagnoses: scrubList(s, e.diagnoses, 150, 15),
      procedures: scrubList(s, e.procedures, 150, 15),
      notes: scrub(s, e.notes, 800),
    })),
  };
  return {
    task: "history_summary",
    promptVersion: AI_PROMPT_VERSIONS.history_summary,
    system: `${SAFETY_CLINICAL} Write in ${LANGUAGE_NAME[ctx.language]}. JSON shape: {"summary": string, "keyPoints": string[], "flags": string[]} where flags list allergies, alerts and medical risks that matter before treatment.`,
    user: `Summarise this patient's history for the treating dentist.\nFACTS:\n${JSON.stringify(payload)}`,
    payload,
    language: ctx.language,
    deidentified: true,
    redactions: s.redactions,
  };
}

export interface EncounterFacts {
  ageYears: number | null;
  sex: string | null;
  date: string;
  chiefComplaint?: string | null;
  notes: readonly { kind: string; body: string }[];
  diagnoses: readonly { toothCode?: number | null; label: string }[];
  procedures: readonly { toothCode?: number | null; label: string; status?: string }[];
}

export function buildEncounterSummaryPrompt(facts: EncounterFacts, ctx: PromptContext): AiPrompt {
  const s: Scrubber = { names: ctx.knownNames ?? [], redactions: 0 };
  const payload = {
    ageBand: ageBand(facts.ageYears),
    sex: facts.sex,
    date: facts.date,
    chiefComplaint: scrub(s, facts.chiefComplaint, 500),
    notes: facts.notes.slice(0, 20).map((n) => ({ kind: n.kind, body: scrub(s, n.body, 1500) })),
    diagnoses: facts.diagnoses
      .slice(0, 30)
      .map((d) => ({ tooth: d.toothCode ?? null, label: scrub(s, d.label, 150) })),
    procedures: facts.procedures.slice(0, 30).map((p) => ({
      tooth: p.toothCode ?? null,
      label: scrub(s, p.label, 150),
      status: p.status ?? null,
    })),
  };
  return {
    task: "encounter_summary",
    promptVersion: AI_PROMPT_VERSIONS.encounter_summary,
    system: `${SAFETY_CLINICAL} Write in ${LANGUAGE_NAME[ctx.language]}. JSON shape: {"summary": string, "diagnoses": string[], "procedures": string[], "followUp": string[]}.`,
    user: `Summarise this encounter.\nFACTS:\n${JSON.stringify(payload)}`,
    payload,
    language: ctx.language,
    deidentified: true,
    redactions: s.redactions,
  };
}

export interface NoteDraftFacts {
  ageYears: number | null;
  sex: string | null;
  /** The dentist's rough notes (typed) or the voice transcript. */
  clinicianText: string;
  chiefComplaint?: string | null;
  history?: readonly string[];
  diagnoses?: readonly { toothCode?: number | null; label: string }[];
  procedures?: readonly { toothCode?: number | null; label: string }[];
}

export function buildClinicalNotePrompt(
  facts: NoteDraftFacts,
  ctx: PromptContext & { source: "typed" | "voice" },
): AiPrompt {
  const s: Scrubber = { names: ctx.knownNames ?? [], redactions: 0 };
  const payload = {
    ageBand: ageBand(facts.ageYears),
    sex: facts.sex,
    source: ctx.source,
    chiefComplaint: scrub(s, facts.chiefComplaint, 500),
    relevantHistory: scrubList(s, facts.history, 200, 15),
    diagnoses: (facts.diagnoses ?? [])
      .slice(0, 30)
      .map((d) => ({ tooth: d.toothCode ?? null, label: scrub(s, d.label, 150) })),
    procedures: (facts.procedures ?? [])
      .slice(0, 30)
      .map((p) => ({ tooth: p.toothCode ?? null, label: scrub(s, p.label, 150) })),
    clinicianText: scrub(s, facts.clinicianText, 12_000),
  };
  const task: AiTask = ctx.source === "voice" ? "voice_note" : "clinical_note";
  return {
    task,
    promptVersion: AI_PROMPT_VERSIONS[task],
    system: `${SAFETY_CLINICAL} Turn the clinician's ${ctx.source === "voice" ? "dictation transcript" : "rough notes"} into SOAP sections in ${LANGUAGE_NAME[ctx.language]}. Use only what the clinician said or the structured facts state; leave a section empty rather than inventing content. JSON shape: {"subjective": string, "objective": string, "assessment": string, "plan": string}.`,
    user: `Draft the SOAP note.\nFACTS:\n${JSON.stringify(payload)}`,
    payload,
    language: ctx.language,
    deidentified: true,
    redactions: s.redactions,
  };
}

export interface PlanExplanationFacts {
  items: readonly {
    planItemId: string;
    serviceName: string;
    toothCode?: number | null;
    quantity: number;
    estimatePaise: number;
    phase?: number;
  }[];
  totalPaise: number;
}

/** Structured only: service names, tooth numbers, prices. No patient attributes, no free text. */
export function buildPlanExplanationPrompt(
  facts: PlanExplanationFacts,
  ctx: PromptContext,
): AiPrompt {
  const s: Scrubber = { names: [], redactions: 0 };
  const payload = {
    items: facts.items.slice(0, 50).map((i) => ({
      planItemId: i.planItemId,
      service: scrub(s, i.serviceName, 120),
      tooth: i.toothCode ?? null,
      quantity: i.quantity,
      estimateRupees: Math.round(i.estimatePaise) / 100,
      phase: i.phase ?? 1,
    })),
    totalRupees: facts.totalPaise / 100,
  };
  return {
    task: "plan_explanation",
    promptVersion: AI_PROMPT_VERSIONS.plan_explanation,
    system: `You explain a dental treatment plan to a patient in simple, calm ${LANGUAGE_NAME[ctx.language]}, at a school-leaving reading level. Explain what each item is for in general terms, in the given order. Do not give a diagnosis, promise outcomes, recommend anything not listed, or mention risks that are not in general patient information. Prices are estimates. Never include names or contact details. Respond with a single JSON object only: {"text": string, "itemNotes": [{"planItemId": string, "explanation": string}]}.`,
    user: `Explain this treatment plan to the patient.\nPLAN:\n${JSON.stringify(payload)}`,
    payload,
    language: ctx.language,
    deidentified: true,
    redactions: s.redactions,
  };
}

/** The question is the only free text; it is scrubbed. The model sees the catalogue, never data. */
export function buildNlAnalyticsPrompt(question: string, ctx: { today: string }): AiPrompt {
  const s: Scrubber = { names: [], redactions: 0 };
  const q = scrub(s, question, 500);
  const catalogue = Object.values(ANALYTICS_CATALOGUE).map((e) => ({
    queryId: e.id,
    description: e.description,
    parameters: e.uses,
  }));
  const payload = { question: q, today: ctx.today, catalogue };
  return {
    task: "nl_analytics",
    promptVersion: AI_PROMPT_VERSIONS.nl_analytics,
    system:
      "You route a clinic manager's question to ONE query from the catalogue. You cannot run SQL and you never see data. " +
      'Choose "queryId" from the catalogue and set only the parameters that query lists (period is one of today, yesterday, last_7_days, ' +
      "last_30_days, this_week, this_month, last_month, this_quarter, this_fy; or custom with from/to as YYYY-MM-DD). " +
      'If no catalogue query answers it, respond {"refuse": "<short reason>"}. Respond with a single JSON object only: ' +
      '{"queryId": string, "params": object} or {"refuse": string}.',
    user: JSON.stringify(payload),
    payload,
    language: "en",
    deidentified: true,
    redactions: s.redactions,
  };
}

/** Numbers only (an aggregate); the model writes the narrative, it does not compute anything. */
export function buildDailySummaryPrompt(
  input: {
    branchName: string;
    day: string;
    metrics: {
      appointments: number;
      completedVisits: number;
      newPatients: number;
      cancellationRateBp: number | null;
      noShowRateBp: number | null;
      billedPaise: number | null;
      collectedPaise: number | null;
      outstandingPaise: number | null;
    };
    previous?: {
      appointments: number;
      completedVisits: number;
      collectedPaise: number | null;
    } | null;
  },
  ctx: PromptContext,
): AiPrompt {
  const m = input.metrics;
  const rupees = (p: number | null) => (p === null ? null : p / 100);
  const pct = (bp: number | null) => (bp === null ? null : bp / 100);
  const payload = {
    branch: input.branchName,
    day: input.day,
    appointments: m.appointments,
    completedVisits: m.completedVisits,
    newPatients: m.newPatients,
    cancellationRatePercent: pct(m.cancellationRateBp),
    noShowRatePercent: pct(m.noShowRateBp),
    billedRupees: rupees(m.billedPaise),
    collectedRupees: rupees(m.collectedPaise),
    outstandingRupees: rupees(m.outstandingPaise),
    previousDay: input.previous
      ? {
          appointments: input.previous.appointments,
          completedVisits: input.previous.completedVisits,
          collectedRupees: rupees(input.previous.collectedPaise),
        }
      : null,
  };
  return {
    task: "daily_summary",
    promptVersion: AI_PROMPT_VERSIONS.daily_summary,
    system: `You write a 3-4 sentence daily performance note for a dental clinic manager in ${LANGUAGE_NAME[ctx.language]}. Use ONLY the provided numbers, quote them exactly, and never compute new figures or speculate about causes. Respond with a single JSON object only: {"summary": string}.`,
    user: `Write the note.\nNUMBERS:\n${JSON.stringify(payload)}`,
    payload,
    language: ctx.language,
    deidentified: true,
    redactions: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Draft content (stored in AiDraft.content) and provenance (AiDraft.metadata)
// ---------------------------------------------------------------------------------------------

const para = (max = 6000) => z.string().trim().max(max);
export const aiHistorySummaryContent = z.object({
  summary: para().min(1),
  keyPoints: z.array(para(500)).max(20),
  flags: z.array(para(300)).max(20),
});
export const aiEncounterSummaryContent = z.object({
  summary: para().min(1),
  diagnoses: z.array(para(300)).max(30),
  procedures: z.array(para(300)).max(30),
  followUp: z.array(para(300)).max(20),
});
/** CLINICAL_NOTE and VOICE_NOTE. Approval writes one ClinicalNote per non-empty section (S, O, A, P). */
export const aiNoteContent = z
  .object({
    subjective: para(),
    objective: para(),
    assessment: para(),
    plan: para(),
    language: aiLanguage,
    /** Voice drafts keep the transcript text (never the audio) so the dentist can compare. */
    transcript: z.string().trim().max(50_000).optional(),
  })
  .refine((v) => [v.subjective, v.objective, v.assessment, v.plan].some((x) => x.length > 0), {
    message: "At least one SOAP section must have text",
  });
export const aiPlanExplanationContent = z.object({
  language: aiLanguage,
  text: para(8000).min(1),
  itemNotes: z.array(z.object({ planItemId: uuid, explanation: para(1000) })).max(50),
});

export const AI_DRAFT_CONTENT_SCHEMAS = {
  PATIENT_HISTORY_SUMMARY: aiHistorySummaryContent,
  ENCOUNTER_SUMMARY: aiEncounterSummaryContent,
  CLINICAL_NOTE: aiNoteContent,
  VOICE_NOTE: aiNoteContent,
  PLAN_EXPLANATION: aiPlanExplanationContent,
} as const satisfies Record<AiDraftKind, z.ZodType>;

/** Validates draft content against its kind (generation output and every edit). */
export function parseDraftContent(kind: AiDraftKind, content: unknown) {
  return AI_DRAFT_CONTENT_SCHEMAS[kind].safeParse(content);
}

/** ClinicalNote rows an approved note draft becomes: SOAP order, empty sections skipped. */
export const SOAP_NOTE_KINDS = [
  { section: "subjective", kind: "SUBJECTIVE" },
  { section: "objective", kind: "OBJECTIVE" },
  { section: "assessment", kind: "ASSESSMENT" },
  { section: "plan", kind: "PLAN" },
] as const;
export function soapNotesFromDraft(content: z.infer<typeof aiNoteContent>) {
  return SOAP_NOTE_KINDS.map(({ section, kind }) => ({ kind, body: content[section] })).filter(
    (n) => n.body.length > 0,
  );
}

/** Extracts the first JSON object from model text (tolerates fences / prose around it) or null. */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Stable JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
/** SHA-256 of a draft's content: sent back on approve so a reviewer approves exactly what they saw. */
export const aiContentHash = (content: unknown) => sha256Hex(canonicalJson(content));

export const aiDraftMetadata = aiLabel.extend({
  aiGenerated: z.literal(true).default(true),
  /** Direct identifiers stripped from the prompt (always true). */
  deidentified: z.boolean(),
  language: aiLanguage.optional(),
  promptTokens: z.number().int().optional(),
  completionTokens: z.number().int().optional(),
});
export type AiDraftMetadata = z.infer<typeof aiDraftMetadata>;

// ---------------------------------------------------------------------------------------------
// Natural-language analytics planning (the model picks a catalogue query; this validates it)
// ---------------------------------------------------------------------------------------------

export const nlAnalyticsModelOutput = z.union([
  z.object({ queryId: analyticsQueryId, params: analyticsQueryParams.default({}) }),
  z.object({ refuse: trimmed(300) }),
]);

export type NlAnalyticsPlan =
  | { ok: true; queryId: z.infer<typeof analyticsQueryId>; params: AnalyticsQueryParams }
  | {
      ok: false;
      reason: "unparseable" | "refused" | "not_in_catalogue" | "scope" | "finance" | "branch";
    };

/**
 * Validates the model's choice against the CALLER's permissions (never the model's say-so): the query must exist in the
 * catalogue, params are re-parsed strictly, org-scope queries need `orgWide`, financial queries need `financeVisible`, a
 * branch outside the caller's scope is refused, and a single-branch caller gets their branch filled in.
 */
export function resolveNlAnalyticsPlan(
  modelText: string,
  caller: { orgWide: boolean; financeVisible: boolean; branchScope: readonly string[] },
): NlAnalyticsPlan {
  const raw = extractJsonObject(modelText);
  if (raw === null) return { ok: false, reason: "unparseable" };
  const parsed = nlAnalyticsModelOutput.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "not_in_catalogue" };
  if ("refuse" in parsed.data) return { ok: false, reason: "refused" };
  const entry = ANALYTICS_CATALOGUE[parsed.data.queryId];
  // Keep only the parameters this query reads.
  const params = Object.fromEntries(
    Object.entries(parsed.data.params).filter(([k]) =>
      (entry.uses as readonly string[]).includes(k),
    ),
  ) as AnalyticsQueryParams;
  if (entry.scope === "org" && !caller.orgWide) return { ok: false, reason: "scope" };
  if (entry.financial && !caller.financeVisible) return { ok: false, reason: "finance" };
  if (params.branchId && !caller.orgWide && !caller.branchScope.includes(params.branchId))
    return { ok: false, reason: "branch" };
  if (
    entry.scope === "branch" &&
    !params.branchId &&
    (entry.uses as readonly string[]).includes("branchId")
  ) {
    if (!caller.orgWide && caller.branchScope.length === 1) params.branchId = caller.branchScope[0];
  }
  return { ok: true, queryId: entry.id, params };
}

// ---------------------------------------------------------------------------------------------
// Deterministic stub provider (no network; offline dev / demos / tests of the flow)
// ---------------------------------------------------------------------------------------------

const STUB_TRANSCRIPT: Record<AiLanguage, string> = {
  en: "Patient reports sensitivity in the lower right molar for three days. On examination there is a deep cavity on tooth 46, no swelling. Advise root canal treatment and a crown. Review in one week.",
  hi: "मरीज़ को तीन दिन से निचले दाएँ दाढ़ में झनझनाहट है। जाँच में दाँत 46 में गहरी cavity है, सूजन नहीं है। रूट कैनाल इलाज और क्राउन की सलाह दी गई। एक सप्ताह बाद दोबारा दिखाएँ।",
};

const stubText = (
  task: AiTask,
  p: Readonly<Record<string, unknown>>,
  lang: AiLanguage,
): unknown => {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
  switch (task) {
    case "history_summary": {
      const allergies = arr(p.allergies)
        .map((a) => str((a as { substance?: unknown }).substance))
        .filter(Boolean);
      const conditions = arr(p.conditions)
        .map((c) => str(c))
        .filter(Boolean);
      return {
        summary: `[Stub] ${str(p.ageBand, "Adult")} patient. Conditions: ${conditions.join(", ") || "none documented"}. Allergies: ${allergies.join(", ") || "none documented"}. ${arr(p.recentEncounters).length} recent encounter(s) on record.`,
        keyPoints: [
          ...conditions.slice(0, 5),
          ...arr(p.alerts)
            .map((a) => str(a))
            .slice(0, 3),
        ],
        flags: allergies.map((a) => `Allergy: ${a}`),
      };
    }
    case "encounter_summary":
      return {
        summary: `[Stub] Encounter on ${str(p.date)}: ${arr(p.diagnoses).length} diagnosis item(s), ${arr(p.procedures).length} procedure item(s).`,
        diagnoses: arr(p.diagnoses).map((d) => str((d as { label?: unknown }).label)),
        procedures: arr(p.procedures).map((d) => str((d as { label?: unknown }).label)),
        followUp: ["Review as advised by the treating dentist"],
      };
    case "clinical_note":
    case "voice_note": {
      const text = str(p.clinicianText);
      return {
        subjective: str(p.chiefComplaint) || text.slice(0, 300),
        objective:
          arr(p.diagnoses)
            .map((d) => str((d as { label?: unknown }).label))
            .join("; ") || "Not documented",
        assessment: "Not documented (draft for dentist review)",
        plan:
          arr(p.procedures)
            .map((d) => str((d as { label?: unknown }).label))
            .join("; ") || "Not documented",
      };
    }
    case "plan_explanation": {
      const items = arr(p.items) as { planItemId?: unknown; service?: unknown; tooth?: unknown }[];
      return {
        text:
          lang === "hi"
            ? `[Stub] आपकी उपचार योजना में ${items.length} चरण हैं। आपका डेंटिस्ट हर चरण विस्तार से समझाएँगे।`
            : `[Stub] Your treatment plan has ${items.length} step(s). Your dentist will explain each one in detail.`,
        itemNotes: items.map((i) => ({
          planItemId: str(i.planItemId),
          explanation: `${str(i.service)}${i.tooth ? ` (tooth ${String(i.tooth)})` : ""}`,
        })),
      };
    }
    case "nl_analytics": {
      const q = str(p.question).toLowerCase();
      const pick = (id: string, params: Record<string, unknown> = {}) => ({ queryId: id, params });
      if (/no.?show|cancel/.test(q))
        return pick("cancellation_noshow_rates", { period: "last_30_days" });
      if (/outstanding|unpaid|due/.test(q)) return pick("outstanding_balances");
      if (/collect|payment/.test(q))
        return pick("collections_summary", { period: "last_30_days", grain: "week" });
      if (/revenue|billed|invoice/.test(q))
        return pick("revenue_trend", { period: "last_30_days", grain: "week" });
      if (/new patient/.test(q))
        return pick("new_patients_trend", { period: "last_30_days", grain: "week" });
      if (/dentist|doctor/.test(q)) return pick("dentist_performance", { period: "last_30_days" });
      if (/wait/.test(q)) return pick("waiting_patients");
      if (/overview|summary|how are we/.test(q))
        return pick("org_overview", { period: "last_30_days" });
      return { refuse: "I can only answer questions covered by the analytics catalogue." };
    }
    case "daily_summary":
      return {
        summary: `[Stub] ${str(p.branch)} on ${str(p.day)}: ${String(p.appointments)} appointments, ${String(p.completedVisits)} completed, ${String(p.newPatients)} new patients.`,
      };
  }
};

/** Deterministic, offline provider: same input, same output. Marks every text with "[Stub]". */
export function createStubAiProvider(): AiProvider {
  return {
    name: "stub",
    model: AI_PROVIDER_STUB_MODEL,
    regionCompliant: true,
    async chat(req) {
      const text = JSON.stringify(stubText(req.task, req.payload, req.language));
      return {
        text,
        provider: "stub",
        model: AI_PROVIDER_STUB_MODEL,
        usage: {
          promptTokens: estimateTokens(req.system + req.user),
          completionTokens: estimateTokens(text),
        },
        finishReason: "stop",
      };
    },
    async transcribe(req) {
      const language: AiLanguage = req.language === "hi" ? "hi" : "en";
      const text = STUB_TRANSCRIPT[language];
      return {
        text,
        language,
        provider: "stub",
        model: AI_PROVIDER_STUB_MODEL,
        durationSeconds: null,
        usage: {
          promptTokens: Math.ceil(req.audio.byteLength / 16_000),
          completionTokens: estimateTokens(text),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Voice constraints
// ---------------------------------------------------------------------------------------------

export const AI_AUDIO_MIME_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/x-m4a",
] as const;
/** Audio is processed in memory only; this bounds the memory per call. */
export const AI_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const AI_MAX_AUDIO_SECONDS = 600;

// ---------------------------------------------------------------------------------------------
// Settings, capabilities, usage
// ---------------------------------------------------------------------------------------------

export const aiProviderInfo = z.object({
  provider: z.enum([...AI_PROVIDERS, "disabled"]),
  model: z.string(),
  regionCompliant: z.boolean(),
  /** Configuration problem to show an admin (never a secret). */
  problem: z.string().nullable(),
});
export type AiProviderInfo = z.infer<typeof aiProviderInfo>;

export const aiSettingResponse = z.object({
  capability: aiCapability,
  title: z.string(),
  enabled: z.boolean(),
  allowedRoles: z.array(staffRole),
  /** Stored value; null = the default below applies. */
  monthlyQuota: z.number().int().nullable(),
  effectiveMonthlyQuota: z.number().int(),
  retainContent: z.boolean(),
  usedThisMonth: z.number().int(),
  updatedBy: z.string().nullable(),
  updatedAt: isoDateTime.nullable(),
});
export type AiSettingResponse = z.infer<typeof aiSettingResponse>;
export const aiSettingsResponse = z.object({
  provider: aiProviderInfo,
  capabilities: z.array(aiSettingResponse),
});
export type AiSettingsResponse = z.infer<typeof aiSettingsResponse>;

/** PATCH /ai/settings/:capability — no defaults. `allowedRoles` replaces the set (PATIENT is not a staff role). */
export const updateAiSettingRequest = z.object({
  enabled: z.boolean().optional(),
  allowedRoles: z.array(staffRole).max(5).optional(),
  monthlyQuota: z.number().int().min(0).max(1_000_000).nullable().optional(),
  retainContent: z.boolean().optional(),
});
export type UpdateAiSettingRequest = z.infer<typeof updateAiSettingRequest>;

export const aiCapabilityAvailability = z.object({
  code: aiCapability,
  title: z.string(),
  description: z.string(),
  available: z.boolean(),
  /** Why not (`AiDenial` values) when unavailable. */
  denied: z.array(
    z.enum([
      "provider_disabled",
      "capability_disabled",
      "role_not_allowed",
      "permission_missing",
      "quota_exceeded",
      "region_not_compliant",
    ]),
  ),
  remainingQuota: z.number().int().nullable(),
  requiresDentistApproval: z.boolean(),
});
export const aiCapabilitiesResponse = z.object({
  provider: aiProviderInfo,
  capabilities: z.array(aiCapabilityAvailability),
});
export type AiCapabilitiesResponse = z.infer<typeof aiCapabilitiesResponse>;

export const aiUsageQuery = z.object({
  /** "YYYY-MM" (default: the current month). */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});
export type AiUsageQuery = z.infer<typeof aiUsageQuery>;
export const aiUsageResponse = z.object({
  month: dateOnly,
  capabilities: z.array(
    z.object({
      capability: aiCapability,
      requestCount: z.number().int(),
      promptTokens: z.number().int(),
      completionTokens: z.number().int(),
      quota: z.number().int(),
      remaining: z.number().int(),
    }),
  ),
});
export type AiUsageResponse = z.infer<typeof aiUsageResponse>;

// ---------------------------------------------------------------------------------------------
// Generation requests (each returns a draft, except NL analytics and the daily summary)
// ---------------------------------------------------------------------------------------------

/** POST /ai/patient-summary */
export const generatePatientSummaryRequest = z.object({
  patientId: uuid,
  language: aiLanguage.default("en"),
});
export type GeneratePatientSummaryRequest = z.infer<typeof generatePatientSummaryRequest>;
/** POST /ai/encounter-summary */
export const generateEncounterSummaryRequest = z.object({
  encounterId: uuid,
  language: aiLanguage.default("en"),
});
export type GenerateEncounterSummaryRequest = z.infer<typeof generateEncounterSummaryRequest>;
/** POST /ai/clinical-note-draft — the encounter must be OPEN (a signed encounter is refused, `ai_encounter_signed`). */
export const generateClinicalNoteDraftRequest = z.object({
  encounterId: uuid,
  /** The dentist's rough notes; optional (the structured findings alone may suffice). */
  clinicianNotes: z.string().trim().max(12_000).optional(),
  language: aiLanguage.default("en"),
});
export type GenerateClinicalNoteDraftRequest = z.infer<typeof generateClinicalNoteDraftRequest>;
/**
 * POST /ai/voice-note-draft (multipart): the audio part is `audio` (<= 10 MB, `AI_AUDIO_MIME_TYPES`); these are the
 * text fields. `consentConfirmed` must be true AND the patient must hold a GRANTED `AI_TRANSCRIPTION` consent. Audio is
 * transcribed in memory and discarded; only the transcript text lives on in the draft.
 */
export const voiceNoteDraftFields = z.object({
  encounterId: uuid,
  language: z.enum(["en", "hi", "auto"]).default("auto"),
  consentConfirmed: z
    .stringbool()
    .refine((v) => v === true, "Patient consent to record is required"),
});
export type VoiceNoteDraftFields = z.infer<typeof voiceNoteDraftFields>;
/** POST /ai/plan-explanation */
export const generatePlanExplanationRequest = z.object({
  planId: uuid,
  /** Default: the plan's current version. */
  planVersion: z.number().int().min(1).optional(),
  language: aiLanguage.default("en"),
});
export type GeneratePlanExplanationRequest = z.infer<typeof generatePlanExplanationRequest>;

/** POST /ai/nl-analytics */
export const nlAnalyticsRequest = z.object({
  question: trimmed(500).min(3),
  /** Preselect a branch (must be in the caller's scope). */
  branchId: uuid.optional(),
});
export type NlAnalyticsRequest = z.infer<typeof nlAnalyticsRequest>;
export const nlAnalyticsResponse = z.object({
  question: z.string(),
  /** What was run; null when the question was refused. */
  resolved: z
    .object({ queryId: analyticsQueryId, title: z.string(), params: analyticsQueryParams })
    .nullable(),
  refusal: z
    .enum(["unparseable", "refused", "not_in_catalogue", "scope", "finance", "branch"])
    .nullable(),
  /** The analytics response of the chosen query (shape per `queryId`). */
  data: z.unknown(),
  label: aiLabel,
  logId: uuid,
});
export type NlAnalyticsResponse = z.infer<typeof nlAnalyticsResponse>;
export const nlAnalyticsCatalogueResponse = z.object({
  queries: z.array(
    z.object({
      id: analyticsQueryId,
      title: z.string(),
      description: z.string(),
      scope: z.enum(["org", "branch"]),
      financial: z.boolean(),
      available: z.boolean(),
    }),
  ),
  examples: z.array(z.string()),
});
export type NlAnalyticsCatalogueResponse = z.infer<typeof nlAnalyticsCatalogueResponse>;
export const NL_ANALYTICS_EXAMPLES = [
  "How many appointments were cancelled or no-shows last month?",
  "What is our outstanding balance?",
  "Show collections by week for the last 30 days",
  "Which dentist completed the most visits this month?",
] as const;

/** GET /ai/daily-summary?branchId=&day= */
export const dailySummaryQuery = z.object({ branchId: uuid, day: dateOnly.optional() });
export type DailySummaryQuery = z.infer<typeof dailySummaryQuery>;
export const dailySummaryResponse = analyticsSnapshotResponse;
/** POST /ai/daily-summary/regenerate — recompute numbers and narrative for a day (counts against the quota). */
export const regenerateDailySummaryRequest = z.object({ branchId: uuid, day: dateOnly.optional() });
export type RegenerateDailySummaryRequest = z.infer<typeof regenerateDailySummaryRequest>;

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

export const aiDraftResponse = z.object({
  id: uuid,
  kind: aiDraftKind,
  status: aiDraftStatus,
  subjectType: z.string(),
  subjectId: uuid,
  patientId: uuid.nullable(),
  branchId: uuid,
  encounterId: uuid.nullable(),
  planVersionId: uuid.nullable(),
  content: z.record(z.string(), z.unknown()),
  /** Provider, model, promptVersion — render the "AI-generated" label from these. */
  metadata: aiDraftMetadata,
  /** `AI_DRAFT_LABEL` while DRAFT, `AI_APPROVED_LABEL` once approved. */
  label: z.string(),
  contentHash: z.string(),
  createdBy: z.string(),
  createdAt: isoDateTime,
  editedBy: z.string().nullable(),
  editedAt: isoDateTime.nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: isoDateTime.nullable(),
  reviewNote: z.string().nullable(),
  resultingRecordType: z.string().nullable(),
  resultingRecordId: uuid.nullable(),
  expiresAt: isoDateTime,
});
export type AiDraftResponse = z.infer<typeof aiDraftResponse>;

export const listAiDraftsQuery = pageQuery.extend({
  status: aiDraftStatus.optional(),
  kind: aiDraftKind.optional(),
  patientId: uuid.optional(),
  encounterId: uuid.optional(),
  branchId: uuid.optional(),
  /** Only drafts I created. */
  mine: z.stringbool().optional(),
});
export type ListAiDraftsQuery = z.infer<typeof listAiDraftsQuery>;

/** PATCH /ai/drafts/:id — edits a DRAFT only; top-level keys replace the stored ones, then the kind's schema must still hold. */
export const updateAiDraftRequest = z.object({
  content: z.record(z.string(), z.unknown()),
});
export type UpdateAiDraftRequest = z.infer<typeof updateAiDraftRequest>;

/**
 * POST /ai/drafts/:id/approve. `contentHash` = `aiContentHash` of the content the reviewer saw (409 `ai_content_changed`
 * when it moved); `attestation` = the reviewer confirms they reviewed it and accept responsibility. CLINICAL_NOTE /
 * VOICE_NOTE need `ai:clinical` + `clinical:write` at the encounter's branch and an OPEN encounter: approval writes the
 * ClinicalNote rows (SOAP, `aiAssisted`, authored by the approver) in the same transaction. PLAN_EXPLANATION approval
 * releases the text to the portal and to messages.
 */
export const approveAiDraftRequest = z.object({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  attestation: z.literal(true),
  note: optionalText(500),
});
export type ApproveAiDraftRequest = z.infer<typeof approveAiDraftRequest>;
export const approveAiDraftResponse = z.object({
  draft: aiDraftResponse,
  /** ClinicalNote ids written for note drafts (SOAP order); empty otherwise. */
  noteIds: z.array(uuid),
});
export type ApproveAiDraftResponse = z.infer<typeof approveAiDraftResponse>;
export const rejectAiDraftRequest = z.object({ reason: trimmed(500).min(3) });
export type RejectAiDraftRequest = z.infer<typeof rejectAiDraftRequest>;

// ---------------------------------------------------------------------------------------------
// Activity log (append-only; ai:admin reads it)
// ---------------------------------------------------------------------------------------------

export const AI_ACTIONS = [
  "generate",
  "transcribe",
  "query",
  "summarise",
  "approve",
  "reject",
  "expire",
  "proposal",
  "refuse",
] as const;
export const AI_OUTCOMES = [
  "success",
  "refused",
  "error",
  "quota_exceeded",
  "disabled",
  "denied",
] as const;
export const AI_SCOPES = ["ORG", "BRANCH", "PATIENT"] as const;

export const listAiActivityQuery = pageQuery.extend({
  capability: aiCapability.optional(),
  actorId: staffUserId.optional(),
  outcome: z.enum(AI_OUTCOMES).optional(),
  branchId: uuid.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export type ListAiActivityQuery = z.infer<typeof listAiActivityQuery>;
export const aiActivityResponse = z.object({
  id: uuid,
  createdAt: isoDateTime,
  actorId: z.string(),
  scope: z.enum(AI_SCOPES),
  branchId: uuid.nullable(),
  patientId: uuid.nullable(),
  capability: z.string(),
  provider: z.string(),
  model: z.string(),
  action: z.enum(AI_ACTIONS),
  draftId: uuid.nullable(),
  approval: z.enum(["APPROVED", "REJECTED"]).nullable(),
  outcome: z.enum(AI_OUTCOMES),
  errorCode: z.string().nullable(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  latencyMs: z.number().int().nullable(),
  deidentified: z.boolean(),
});
export type AiActivityResponse = z.infer<typeof aiActivityResponse>;

// ---------------------------------------------------------------------------------------------
// Assistant proposals (V1: read / draft only)
// ---------------------------------------------------------------------------------------------

/**
 * A mutation the assistant suggests. It is NEVER executed by the assistant: the UI shows `summary`, and only an explicit
 * user confirmation calls the normal endpoint (`confirmEndpoint`) with the user's own credentials, permissions and
 * validation. Nothing in V1 creates proposals automatically; this is the contract for the first approved workflow.
 */
export const aiProposal = z.object({
  /** Always false: executing is the user's confirm call, not the assistant's. */
  executed: z.literal(false),
  type: z.string().max(60),
  summary: z.string().max(500),
  confirmEndpoint: z.object({
    method: z.enum(["POST", "PATCH", "PUT", "DELETE"]),
    path: z.string().max(200),
  }),
  body: z.record(z.string(), z.unknown()),
  logId: uuid.optional(),
});
export type AiProposal = z.infer<typeof aiProposal>;

// ---------------------------------------------------------------------------------------------
// Queues (pg-boss; ids-only payloads)
// ---------------------------------------------------------------------------------------------

export const AI_QUEUES = {
  /** Writes the AI narrative onto an existing AnalyticsSnapshot (queued by the analytics snapshot job). */
  DAILY_SUMMARY: "ai.daily-summary",
  /** Daily: DRAFT rows past `expiresAt` -> EXPIRED. */
  DRAFT_EXPIRY_SWEEP: "ai.draft-expiry-sweep",
} as const;
export type AiQueue = (typeof AI_QUEUES)[keyof typeof AI_QUEUES];
export const aiDailySummaryJob = z.object({ snapshotId: uuid });
export type AiDailySummaryJob = z.infer<typeof aiDailySummaryJob>;
export const aiDraftExpirySweepJob = z.object({ asOf: isoDateTime.optional() });
export type AiDraftExpirySweepJob = z.infer<typeof aiDraftExpirySweepJob>;
