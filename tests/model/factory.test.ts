import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { AnthropicClient } from "../../src/model/anthropic.js";
import { GeminiClient } from "../../src/model/gemini.js";
import { createModelClient } from "../../src/model/index.js";
import { OpenAICompatibleClient } from "../../src/model/openai.js";

describe("createModelClient", () => {
  it.each([
    ["sk-ant-fake", {}, AnthropicClient, "anthropic"],
    ["sk-fake", {}, OpenAICompatibleClient, "openai"],
    ["gsk_fake", {}, OpenAICompatibleClient, "groq"],
    ["sk-or-v1-fake", { AI_MODEL: "anthropic/claude-sonnet-5-5" }, OpenAICompatibleClient, "openai-compatible"],
    ["AIzaFake", {}, GeminiClient, "gemini"],
  ] as const)("%s -> %s", (key, extraEnv, cls, provider) => {
    const client = createModelClient(loadConfig({ env: { AI_API_KEY: key, ...extraEnv } }));
    expect(client).toBeInstanceOf(cls);
    expect(client.provider).toBe(provider);
  });
});
