import type { HarnessConfig } from "../config.js";
import { AnthropicClient } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";
import { OpenAICompatibleClient } from "./openai.js";
import type { ModelClient } from "./types.js";

export * from "./errors.js";
export * from "./types.js";

/** Creates the client for the configured provider. */
export function createModelClient(config: HarnessConfig): ModelClient {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicClient(config);
    case "openai":
    case "groq":
    case "openai-compatible":
      return new OpenAICompatibleClient({ ...config, provider: config.provider });
    case "gemini":
      return new GeminiClient(config);
  }
}
