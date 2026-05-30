/**
 * Provider abstraction (TRD §4, §7). One factory turns the task's provider
 * config + the env-supplied key into an AI SDK LanguageModel. Swapping
 * providers is a config change, never a code change.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ProviderConfig } from "./contracts.ts";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Resolve the API key from the env var named in the config. Throws if absent so
 * preflight can fail clearly rather than the first LLM call hanging.
 */
export function resolveApiKey(config: ProviderConfig, env = process.env): string {
  const key = env[config.api_key_env];
  if (!key || key.trim().length === 0) {
    throw new ProviderError(
      `Provider "${config.name}" requires env var ${config.api_key_env}, which is unset or empty.`,
    );
  }
  return key;
}

/** Build the AI SDK model for the given provider config. */
export function getModel(config: ProviderConfig, env = process.env): LanguageModel {
  const apiKey = resolveApiKey(config, env);
  switch (config.name) {
    case "openrouter":
      return createOpenRouter({ apiKey }).chat(config.model);
    case "anthropic":
      return createAnthropic({ apiKey })(config.model);
    case "openai":
      return createOpenAI({ apiKey })(config.model);
    default: {
      const _exhaustive: never = config.name;
      throw new ProviderError(`Unknown provider: ${String(_exhaustive)}`);
    }
  }
}
