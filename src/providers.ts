export const PROVIDERS = ["anthropic", "openai", "gemini", "groq", "openai-compatible"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Built-in endpoints. openai-compatible has none: it needs base_url. */
export const DEFAULT_BASE_URLS: Partial<Record<Provider, string>> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com/openai/v1",
};

/** Which sampling settings each API accepts (the Anthropic API rejects temperature). */
export const SUPPORTS_TEMPERATURE: Record<Provider, boolean> = {
  anthropic: false,
  openai: true,
  gemini: true,
  groq: true,
  "openai-compatible": true,
};

export const SUPPORTS_SEED: Record<Provider, boolean> = {
  anthropic: false,
  openai: true,
  gemini: true,
  groq: true,
  "openai-compatible": true,
};

export interface Detected {
  provider: Provider;
  baseUrl?: string;
}

/**
 * Guess the provider from the key's prefix. Order matters: "sk-ant-" and
 * "sk-or-" must be checked before the generic OpenAI "sk-".
 */
export function detectProviderFromKey(key: string): Detected | null {
  const k = key.trim();
  if (k.startsWith("sk-ant-")) return { provider: "anthropic" };
  if (k.startsWith("gsk_")) return { provider: "groq" };
  if (k.startsWith("AIza") || k.startsWith("AQ.")) return { provider: "gemini" }; // AQ.: Google's newer key format
  if (k.startsWith("sk-or-")) return { provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" };
  if (k.startsWith("sk-")) return { provider: "openai" };
  return null;
}
