import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleClient, toModelError } from "../../src/model/openai.js";

const base = {
  provider: "openai" as const,
  model: "gpt-4.1",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-fake",
  maxOutputTokens: 1000,
  effort: "high" as const,
  temperature: 0,
  seed: 42,
  limits: { maxSteps: 10, maxCostUsd: 1, requestTimeoutS: 30, maxRetries: 2 },
};

/** Minimal stand-in for the SDK: records the request, returns the given chunks as a stream. */
function fakeClient(chunks: unknown[], error?: unknown) {
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: unknown) {
          calls.push(params);
          if (error) throw error;
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  };
  return { client: client as unknown as OpenAI, calls };
}

const chunk = (content: string | null, extra: Record<string, unknown> = {}) => ({
  model: "gpt-4.1-2025",
  choices: content === null ? [] : [{ index: 0, delta: { content }, finish_reason: null }],
  ...extra,
});

describe("OpenAICompatibleClient request", () => {
  const req = { system: "be brief", messages: [{ role: "user" as const, content: "hi" }] };

  it("OpenAI, regular model: system message, usage, temperature, seed, cache key", () => {
    const p = new OpenAICompatibleClient(base, fakeClient([]).client).buildParams(req);
    expect(p).toMatchObject({
      model: "gpt-4.1",
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 1000,
      temperature: 0,
      seed: 42,
      prompt_cache_key: "shrike",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    expect(p).not.toHaveProperty("reasoning_effort"); // gpt-4.1 isn't a reasoning model
    expect(p).not.toHaveProperty("max_tokens");
  });

  it("OpenAI reasoning model: effort sent, temperature and seed left out", () => {
    const p = new OpenAICompatibleClient({ ...base, model: "gpt-5" }, fakeClient([]).client).buildParams(req);
    expect(p.reasoning_effort).toBe("high");
    expect(p).not.toHaveProperty("temperature");
    expect(p).not.toHaveProperty("seed");
  });

  it("clamps xhigh/max effort to high", () => {
    const p = new OpenAICompatibleClient({ ...base, model: "o3", effort: "max" }, fakeClient([]).client).buildParams(req);
    expect(p.reasoning_effort).toBe("high");
  });

  it("Groq gpt-oss: effort and temperature both sent, no OpenAI cache key", () => {
    const p = new OpenAICompatibleClient(
      { ...base, provider: "groq", model: "openai/gpt-oss-120b", effort: "low" },
      fakeClient([]).client,
    ).buildParams(req);
    expect(p).toMatchObject({ reasoning_effort: "low", temperature: 0, max_completion_tokens: 1000 });
    expect(p).not.toHaveProperty("prompt_cache_key");
  });

  it("generic compatible server: uses max_tokens", () => {
    const p = new OpenAICompatibleClient(
      { ...base, provider: "openai-compatible", model: "qwen3-coder", baseUrl: "http://localhost:11434/v1" },
      fakeClient([]).client,
    ).buildParams(req);
    expect(p.max_tokens).toBe(1000);
    expect(p).not.toHaveProperty("max_completion_tokens");
  });

  it("sends earlier assistant turns as plain text", () => {
    const p = new OpenAICompatibleClient(base, fakeClient([]).client).buildParams({
      system: "",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", native: { provider: "anthropic", model: "x", data: [] } },
      ],
    });
    expect(p.messages[2]).toEqual({ role: "assistant", content: "a" });
  });
});

describe("OpenAICompatibleClient.chat", () => {
  it("streams text and reads usage from the final chunk, excluding cached tokens", async () => {
    const { client } = fakeClient([
      chunk("Hel"),
      chunk("lo"),
      { model: "gpt-4.1-2025", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      chunk(null, { usage: { prompt_tokens: 1000, completion_tokens: 8, total_tokens: 1008, prompt_tokens_details: { cached_tokens: 900 } } }),
    ]);
    const streamed: string[] = [];
    const res = await new OpenAICompatibleClient(base, client).chat({
      system: "",
      messages: [{ role: "user", content: "hi" }],
      onText: (d) => streamed.push(d),
    });
    expect(streamed).toEqual(["Hel", "lo"]);
    expect(res.message.content).toBe("Hello");
    expect(res.model).toBe("gpt-4.1-2025");
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 8, cacheReadTokens: 900, cacheWriteTokens: 0 });
  });

  it("reads Groq's x_groq usage when no standard usage is sent", async () => {
    const { client } = fakeClient([
      chunk("ok", { x_groq: { usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } } }),
    ]);
    const res = await new OpenAICompatibleClient({ ...base, provider: "groq" }, client).chat({ system: "", messages: [] });
    expect(res.usage.inputTokens).toBe(20);
    expect(res.usage.outputTokens).toBe(2);
  });

  it("maps length and content_filter finish reasons", async () => {
    const finish = (r: string) => fakeClient([{ model: "m", choices: [{ index: 0, delta: {}, finish_reason: r }] }]).client;
    expect((await new OpenAICompatibleClient(base, finish("length")).chat({ system: "", messages: [] })).stopReason).toBe("max_tokens");
    expect((await new OpenAICompatibleClient(base, finish("content_filter")).chat({ system: "", messages: [] })).stopReason).toBe("refusal");
  });

  it("turns SDK errors into ModelError", async () => {
    const err = OpenAI.APIError.generate(401, { error: { message: "Incorrect API key" } }, undefined, new Headers());
    const c = new OpenAICompatibleClient(base, fakeClient([], err).client);
    await expect(c.chat({ system: "", messages: [] })).rejects.toMatchObject({ kind: "auth", status: 401 });
  });
});

describe("toModelError (OpenAI)", () => {
  const gen = (status: number) => OpenAI.APIError.generate(status, { error: { message: "x" } }, undefined, new Headers());

  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "rate_limit"],
    [400, "bad_request"],
    [422, "bad_request"],
    [503, "server"],
  ])("HTTP %i -> %s", (status, kind) => {
    expect(toModelError(gen(status)).kind).toBe(kind);
  });

  it("tells a used-up quota (insufficient_quota) from a rate limit", () => {
    const quota = OpenAI.APIError.generate(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } }, undefined, new Headers());
    expect(toModelError(quota).kind).toBe("quota");
    expect(toModelError(quota).retryable).toBe(false);
  });

  it("recognizes a tool call the host rejected against the schema (Groq tool_use_failed)", () => {
    const groq = OpenAI.APIError.generate(400, { error: { message: "tool call validation failed: parameters for tool grep did not match schema", code: "tool_use_failed" } }, undefined, new Headers());
    expect(toModelError(groq)).toMatchObject({ kind: "invalid_tool_call", detail: expect.stringContaining("did not match schema") });
    // In a stream the error arrives without a status or code, only the message.
    const streamed = new OpenAI.APIError(undefined, undefined, "Tool call validation failed: tool call validation failed: missing properties: 'pattern'", undefined);
    expect(toModelError(streamed).kind).toBe("invalid_tool_call");
  });

  it("classifies connection problems and cancellation", () => {
    expect(toModelError(new OpenAI.APIConnectionTimeoutError()).kind).toBe("timeout");
    expect(toModelError(new OpenAI.APIConnectionError({ message: "ECONNREFUSED" })).kind).toBe("network");
    expect(toModelError(new OpenAI.APIUserAbortError()).kind).toBe("aborted");
  });
});

describe("OpenAICompatibleClient tools", () => {
  const tools = [
    {
      name: "view_file",
      description: "Read a file.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"] },
    },
  ];
  const toolChunk = (tc: Record<string, unknown>, finish: string | null = null) => ({
    model: "gpt-4.1-2025",
    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: finish }],
  });

  it("sends tools as functions, and replays calls and results", () => {
    const p = new OpenAICompatibleClient(base, fakeClient([]).client).buildParams({
      system: "s",
      tools,
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "view_file", input: { path: "a" } }] },
        {
          role: "tool",
          results: [
            { callId: "c1", name: "view_file", content: "1\tx", isError: false },
            { callId: "c2", name: "view_file", content: "Error: nope", isError: true },
          ],
        },
      ],
    });
    expect(p.tools).toEqual([{ type: "function", function: { name: "view_file", description: "Read a file.", parameters: tools[0]!.inputSchema } }]);
    expect(p.messages.slice(2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "view_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "1\tx" },
      { role: "tool", tool_call_id: "c2", content: "Error: nope" },
    ]);
  });

  it("leaves tools out when there are none", () => {
    expect(new OpenAICompatibleClient(base, fakeClient([]).client).buildParams({ system: "", messages: [] })).not.toHaveProperty("tools");
  });

  it("assembles streamed tool calls by index", async () => {
    const { client } = fakeClient([
      toolChunk({ index: 0, id: "call_a", type: "function", function: { name: "view_file", arguments: '{"pa' } }),
      toolChunk({ index: 1, id: "call_b", type: "function", function: { name: "view_file", arguments: "" } }),
      toolChunk({ index: 0, function: { arguments: 'th":"x.ts"}' } }),
      toolChunk({ index: 1, function: { arguments: '{"path": "broken' } }, "tool_calls"),
    ]);
    const res = await new OpenAICompatibleClient(base, client).chat({ system: "", messages: [], tools });
    expect(res.stopReason).toBe("tool_use");
    expect(res.message.toolCalls).toEqual([
      { id: "call_a", name: "view_file", input: { path: "x.ts" } },
      { id: "call_b", name: "view_file", input: undefined, rawInput: '{"path": "broken' },
    ]);
  });

  it("fills in missing ids and treats 'stop' with tool calls as tool use", async () => {
    const { client } = fakeClient([toolChunk({ index: 0, function: { name: "view_file", arguments: "" } }, "stop")]);
    const res = await new OpenAICompatibleClient({ ...base, provider: "openai-compatible" }, client).chat({ system: "", messages: [], tools });
    expect(res.stopReason).toBe("tool_use");
    expect(res.message.toolCalls).toEqual([{ id: "call_0", name: "view_file", input: {} }]);
  });
});
