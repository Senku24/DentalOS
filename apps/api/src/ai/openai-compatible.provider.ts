import {
  type AiChatRequest,
  type AiChatResult,
  type AiConfig,
  type AiProvider,
  type AiTranscribeRequest,
  type AiTranscribeResult,
  estimateTokens,
} from "@dentalos/validation";

/**
 * `openai-compatible` adapter (ADR 0005 §5.9): chat-completions + audio-transcription style HTTP API over `fetch`.
 * 60 s timeout. NEVER logs or echoes prompts / responses / audio: failures are thrown as `AiProviderHttpError` carrying
 * the status code only. Sends no training opt-in headers; the API key travels only in the Authorization header.
 */
export const AI_PROVIDER_TIMEOUT_MS = 60_000;

export class AiProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly where: "chat" | "transcribe",
  ) {
    super(`ai provider ${where} failed with HTTP ${status}`);
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function signalFor(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(AI_PROVIDER_TIMEOUT_MS);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/x-m4a": "m4a",
};

export function createOpenAiCompatibleProvider(
  config: AiConfig,
  secrets: { apiKey: string; transcribeModel?: string },
): AiProvider {
  const baseUrl = config.baseUrl;
  if (!baseUrl) throw new Error("openai-compatible provider needs a base url");
  const sttModel = secrets.transcribeModel || config.model;
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${secrets.apiKey}`,
    ...extra,
  });

  return {
    name: "openai-compatible",
    model: config.model,
    regionCompliant: config.regionCompliant,

    async chat(req: AiChatRequest, opts): Promise<AiChatResult> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
        signal: signalFor(opts?.signal),
      });
      if (!res.ok) throw new AiProviderHttpError(res.status, "chat");
      const body = (await res.json()) as {
        choices?: { message?: { content?: unknown }; finish_reason?: string }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const choice = body.choices?.[0];
      const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
      return {
        text,
        provider: "openai-compatible",
        model: config.model,
        usage: {
          promptTokens: num(body.usage?.prompt_tokens) || estimateTokens(req.system + req.user),
          completionTokens: num(body.usage?.completion_tokens) || estimateTokens(text),
        },
        finishReason: choice?.finish_reason === "length" ? "length" : "stop",
      };
    },

    async transcribe(req: AiTranscribeRequest, opts): Promise<AiTranscribeResult> {
      const form = new FormData();
      // Copy into a fresh ArrayBuffer-backed view: the audio exists only in memory and only for this call.
      const bytes = new Uint8Array(req.audio);
      form.append(
        "file",
        new Blob([bytes], { type: req.mimeType }),
        `dictation.${EXT[req.mimeType] ?? "bin"}`,
      );
      form.append("model", sttModel);
      form.append("response_format", "verbose_json");
      if (req.language !== "auto") form.append("language", req.language);
      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: headers(),
        body: form,
        signal: signalFor(opts?.signal),
      });
      if (!res.ok) throw new AiProviderHttpError(res.status, "transcribe");
      const body = (await res.json()) as { text?: unknown; language?: unknown; duration?: unknown };
      const text = typeof body.text === "string" ? body.text : "";
      const detected = typeof body.language === "string" ? body.language.toLowerCase() : "";
      const language =
        req.language !== "auto" ? req.language : /^(hi|hin)/.test(detected) ? "hi" : "en";
      return {
        text,
        language,
        provider: "openai-compatible",
        model: sttModel,
        durationSeconds: typeof body.duration === "number" ? body.duration : null,
        usage: { promptTokens: 0, completionTokens: estimateTokens(text) },
      };
    },
  };
}
