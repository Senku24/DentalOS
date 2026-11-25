import {
  type AiChatRequest,
  type AiChatResult,
  type AiConfig,
  type AiProvider,
  createStubAiProvider,
  estimateTokens,
  resolveAiConfig,
} from "@dentalos/validation";

/**
 * AI provider for the worker (ADR 0005 §5.9). Same contract and env knobs as the API's `AiProviderService`
 * (AI_PROVIDER, AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_REGION_COMPLIANT): this app cannot import from apps/api, so the small
 * chat half of the `openai-compatible` adapter is repeated here (flagged). Only the numbers-only daily summary runs in the
 * worker, so `transcribe` is not supported. Never logs prompts or responses; 60 s timeout.
 */
export interface WorkerAiProvider {
  config: AiConfig;
  provider: AiProvider | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function openAiCompatible(config: AiConfig, apiKey: string): AiProvider {
  const baseUrl = config.baseUrl as string;
  return {
    name: "openai-compatible",
    model: config.model,
    regionCompliant: config.regionCompliant,
    async chat(req: AiChatRequest, opts): Promise<AiChatResult> {
      const timeout = AbortSignal.timeout(60_000);
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
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
        signal: opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      });
      if (!res.ok) throw new Error(`ai provider chat failed with HTTP ${res.status}`);
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
    async transcribe() {
      throw new Error("transcription is not available in the worker");
    },
  };
}

export function currentProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkerAiProvider {
  const config = resolveAiConfig(env);
  if (config.provider === "stub") return { config, provider: createStubAiProvider() };
  if (config.provider === "openai-compatible")
    return { config, provider: openAiCompatible(config, env.AI_API_KEY?.trim() ?? "") };
  return { config, provider: null };
}
