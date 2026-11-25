import {
  type AiConfig,
  type AiProvider,
  createStubAiProvider,
  resolveAiConfig,
} from "@dentalos/validation";
import { Injectable } from "@nestjs/common";
import { createOpenAiCompatibleProvider } from "./openai-compatible.provider";

export interface CurrentAiProvider {
  config: AiConfig;
  /** null when AI is disabled / misconfigured (every capability then answers `ai_disabled`). */
  provider: AiProvider | null;
}

/**
 * Resolves the provider from the environment (ADR 0005 §5.9): AI_PROVIDER=stub | openai-compatible (unset = disabled),
 * AI_BASE_URL, AI_API_KEY, AI_MODEL, AI_REGION_COMPLIANT, AI_TRANSCRIBE_MODEL (alias AI_STT_MODEL; default AI_MODEL).
 * The API key is read here only and never leaves this object.
 */
@Injectable()
export class AiProviderService {
  private cacheKey = "";
  private cached: CurrentAiProvider | null = null;

  current(env: Readonly<Record<string, string | undefined>> = process.env): CurrentAiProvider {
    const key = [
      env.AI_PROVIDER,
      env.AI_BASE_URL,
      env.AI_MODEL,
      env.AI_REGION_COMPLIANT,
      env.AI_TRANSCRIBE_MODEL,
      env.AI_STT_MODEL,
      env.AI_API_KEY ? "k" : "",
    ].join("|");
    if (this.cached && key === this.cacheKey) return this.cached;
    const config = resolveAiConfig(env);
    let provider: AiProvider | null = null;
    if (config.provider === "stub") provider = createStubAiProvider();
    else if (config.provider === "openai-compatible")
      provider = createOpenAiCompatibleProvider(config, {
        apiKey: env.AI_API_KEY?.trim() ?? "",
        transcribeModel: env.AI_TRANSCRIBE_MODEL?.trim() || env.AI_STT_MODEL?.trim() || undefined,
      });
    this.cacheKey = key;
    this.cached = { config, provider };
    return this.cached;
  }
}
