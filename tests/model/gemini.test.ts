import { ApiError, type GoogleGenAI } from "@google/genai";
import { describe, expect, it } from "vitest";
import { GeminiClient, toModelError } from "../../src/model/gemini.js";

const base = {
  model: "gemini-2.5-pro",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "AIzaFake",
  maxOutputTokens: 1000,
  effort: "high" as const,
  temperature: 0,
  seed: 42,
  limits: { maxSteps: 10, maxCostUsd: 1, requestTimeoutS: 30, maxRetries: 2 },
};

/** Minimal stand-in for the SDK: returns the given chunks as a stream. */
function fakeClient(chunks: unknown[], error?: unknown) {
  const client = {
    models: {
      async generateContentStream() {
        if (error) throw error;
        return (async function* () {
          yield* chunks;
        })();
      },
    },
  };
  return client as unknown as GoogleGenAI;
}

const textChunk = (text: string, extra: Record<string, unknown> = {}) => ({
  modelVersion: "gemini-2.5-pro-001",
  candidates: [{ content: { role: "model", parts: [{ text, ...extra }] } }],
});

describe("GeminiClient request", () => {
  const req = { system: "be brief", messages: [{ role: "user" as const, content: "hi" }] };

  it("Gemini 2.5: system instruction, temperature, seed, thinking budget", () => {
    const p = new GeminiClient(base, fakeClient([])).buildParams(req);
    expect(p).toMatchObject({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      config: { systemInstruction: "be brief", maxOutputTokens: 1000, temperature: 0, seed: 42, thinkingConfig: { thinkingBudget: -1 } },
    });
  });

  it("Gemini 3: thinking level, and temperature left at the default", () => {
    const p = new GeminiClient({ ...base, model: "gemini-3-pro-preview", effort: "low" }, fakeClient([])).buildParams(req);
    expect(p.config?.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(p.config).not.toHaveProperty("temperature");
  });

  it("replays Gemini's own parts (with thought signatures) and plain text otherwise", () => {
    const parts = [{ text: "A", thoughtSignature: "c2ln" }];
    const p = new GeminiClient(base, fakeClient([])).buildParams({
      system: "",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "A", native: { provider: "gemini", model: "gemini-2.5-pro", data: parts } },
        { role: "user", content: "q2" },
        { role: "assistant", content: "B", native: { provider: "anthropic", model: "x", data: [] } },
      ],
    });
    expect(p.contents).toEqual([
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts },
      { role: "user", parts: [{ text: "q2" }] },
      { role: "model", parts: [{ text: "B" }] },
    ]);
  });
});

describe("GeminiClient.chat", () => {
  it("streams text, merges plain parts, keeps signatures, normalises usage", async () => {
    const client = fakeClient([
      textChunk("Hel"),
      textChunk("lo"),
      textChunk("!", { thoughtSignature: "c2ln" }),
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 5, thoughtsTokenCount: 40 },
      },
    ]);
    const streamed: string[] = [];
    const res = await new GeminiClient(base, client).chat({ system: "", messages: [], onText: (d) => streamed.push(d) });
    expect(streamed).toEqual(["Hel", "lo", "!"]);
    expect(res.message.content).toBe("Hello!");
    expect(res.message.native?.data).toEqual([{ text: "Hello" }, { text: "!", thoughtSignature: "c2ln" }]);
    expect(res.model).toBe("gemini-2.5-pro-001");
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({ inputTokens: 400, outputTokens: 45, cacheReadTokens: 600, cacheWriteTokens: 0 });
  });

  it("does not show thought parts as reply text", async () => {
    const client = fakeClient([textChunk("thinking...", { thought: true }), textChunk("answer")]);
    const res = await new GeminiClient(base, client).chat({ system: "", messages: [] });
    expect(res.message.content).toBe("answer");
  });

  it("reports blocked prompts and safety stops as refusals", async () => {
    const blocked = fakeClient([{ promptFeedback: { blockReason: "SAFETY" } }]);
    expect((await new GeminiClient(base, blocked).chat({ system: "", messages: [] })).stopReason).toBe("refusal");
    const safety = fakeClient([{ candidates: [{ finishReason: "SAFETY" }] }]);
    expect((await new GeminiClient(base, safety).chat({ system: "", messages: [] })).stopReason).toBe("refusal");
  });
});

describe("toModelError (Gemini)", () => {
  const api = (status: number, message = "x") => new ApiError({ status, message });

  it.each([
    [403, "auth"],
    [404, "not_found"],
    [429, "rate_limit"],
    [400, "bad_request"],
    [503, "server"],
  ])("HTTP %i -> %s", (status, kind) => {
    expect(toModelError(api(status)).kind).toBe(kind);
  });

  it("treats a 400 with API_KEY_INVALID as an auth error, with a readable message", () => {
    // Shape of the real response to an invalid key: JSON inside JSON.
    const inner = JSON.stringify({
      error: { code: 400, message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] },
    });
    const e = toModelError(api(400, JSON.stringify({ error: { message: inner, code: 400 } })));
    expect(e.kind).toBe("auth");
    expect(e.detail).toBe("API key not valid. Please pass a valid API key.");
  });

  it("classifies aborts and network failures", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(toModelError(abort).kind).toBe("aborted");
    expect(toModelError(new TypeError("fetch failed")).kind).toBe("network");
  });

  it("is used by chat()", async () => {
    await expect(new GeminiClient(base, fakeClient([], api(429))).chat({ system: "", messages: [] })).rejects.toMatchObject({ kind: "rate_limit" });
  });
});

describe("GeminiClient tools", () => {
  const tools = [
    {
      name: "view_file",
      description: "Read a file.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"] },
    },
  ];

  it("sends tools as function declarations with a JSON schema", () => {
    const p = new GeminiClient(base, fakeClient([])).buildParams({ system: "", messages: [], tools });
    expect(p.config?.tools).toEqual([{ functionDeclarations: [{ name: "view_file", description: "Read a file.", parametersJsonSchema: tools[0]!.inputSchema }] }]);
    expect(new GeminiClient(base, fakeClient([])).buildParams({ system: "", messages: [] }).config).not.toHaveProperty("tools");
  });

  it("reads function calls, keeping their signatures, and reports tool use", async () => {
    const call = { functionCall: { name: "view_file", args: { path: "a.ts" } }, thoughtSignature: "c2ln" };
    const client = fakeClient([
      { candidates: [{ content: { role: "model", parts: [{ text: "Checking." }, call] }, finishReason: "STOP" }] },
    ]);
    const res = await new GeminiClient(base, client).chat({ system: "", messages: [], tools });
    expect(res.stopReason).toBe("tool_use");
    expect(res.message.toolCalls).toEqual([{ id: "gemini-local-0", name: "view_file", input: { path: "a.ts" } }]);
    expect(res.message.native?.data).toEqual([{ text: "Checking." }, call]);
  });

  it("sends results as functionResponse parts; local ids are not sent", () => {
    const p = new GeminiClient(base, fakeClient([])).buildParams({
      system: "",
      messages: [
        {
          role: "tool",
          results: [
            { callId: "gemini-local-0", name: "view_file", content: "1\tx", isError: false },
            { callId: "abc", name: "view_file", content: "Error: no", isError: true },
          ],
        },
      ],
    });
    expect(p.contents).toEqual([
      {
        role: "user",
        parts: [
          { functionResponse: { name: "view_file", response: { output: "1\tx" } } },
          { functionResponse: { id: "abc", name: "view_file", response: { error: "Error: no" } } },
        ],
      },
    ]);
  });

  it("rebuilds tool calls from another provider as functionCall parts", () => {
    const p = new GeminiClient(base, fakeClient([])).buildParams({
      system: "",
      messages: [{ role: "assistant", content: "", toolCalls: [{ id: "toolu_1", name: "view_file", input: { path: "a" } }] }],
    });
    expect(p.contents).toEqual([{ role: "model", parts: [{ functionCall: { id: "toolu_1", name: "view_file", args: { path: "a" } } }] }]);
  });
});
