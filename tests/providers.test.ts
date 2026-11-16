import { describe, expect, it } from "vitest";
import { detectProviderFromKey } from "../src/providers.js";

describe("detectProviderFromKey", () => {
  it.each([
    ["sk-ant-fake", "anthropic"],
    ["gsk_fake", "groq"],
    ["AIzaFake", "gemini"],
    ["sk-proj-fake", "openai"],
    ["sk-fake", "openai"],
    ["sk-or-v1-fake", "openai-compatible"],
  ])("%s -> %s", (key, provider) => {
    expect(detectProviderFromKey(key)?.provider).toBe(provider);
  });

  it("gives OpenRouter keys the OpenRouter endpoint", () => {
    expect(detectProviderFromKey("sk-or-v1-fake")?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("ignores surrounding whitespace", () => {
    expect(detectProviderFromKey("  sk-ant-fake\n")?.provider).toBe("anthropic");
  });

  it("returns null for an unknown format", () => {
    expect(detectProviderFromKey("some-random-token")).toBeNull();
  });
});
