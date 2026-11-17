import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicClient, toModelError } from "../../src/model/anthropic.js";
import { ModelError } from "../../src/model/errors.js";

const settings = {
  model: "claude-opus-5-5",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant-fake",
  maxOutputTokens: 1000,
  effort: "high" as const,
  refusalFallback: true,
  limits: { maxSteps: 10, maxCostUsd: 1, requestTimeoutS: 30, maxRetries: 2 },
};

/** Minimal stand-in for the SDK: records the request, replays text deltas. */
function fakeClient(reply: Partial<Anthropic.Beta.BetaMessage>, deltas: string[] = [], error?: unknown) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: unknown) {
          calls.push(params);
          let onText: ((d: string) => void) | undefined;
          return {
            on(event: string, cb: (d: string) => void) {
              if (event === "text") onText = cb;
              return this;
            },
            async finalMessage() {
              if (error) throw error;
              for (const d of deltas) onText?.(d);
              return {
                model: "claude-opus-5-5",
                stop_reason: "end_turn",
                content: [{ type: "text", text: deltas.join("") }],
                usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                ...reply,
              };
            },
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

describe("AnthropicClient request", () => {
  it("caches, sets effort and the refusal fallback, and never sends temperature", () => {
    const params = new AnthropicClient(settings, fakeClient({}).client).buildParams({
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 1000,
      cache_control: { type: "ephemeral" },
      system: "be brief",
      output_config: { effort: "high" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(params).not.toHaveProperty("temperature");
  });

  it("leaves out the fallback for models without it, or when disabled", () => {
    const older = new AnthropicClient({ ...settings, model: "claude-haiku-4-5" }, fakeClient({}).client);
    expect(older.buildParams({ system: "", messages: [] })).not.toHaveProperty("fallbacks");
    const off = new AnthropicClient({ ...settings, refusalFallback: false }, fakeClient({}).client);
    expect(off.buildParams({ system: "", messages: [] })).not.toHaveProperty("betas");
  });

  it("leaves out effort when it is not configured", () => {
    const c = new AnthropicClient({ ...settings, effort: undefined }, fakeClient({}).client);
    expect(c.buildParams({ system: "", messages: [] })).not.toHaveProperty("output_config");
  });

  it("replays Claude's own raw reply unchanged, and plain text from other providers", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "A" }];
    const c = new AnthropicClient(settings, fakeClient({}).client);
    const params = c.buildParams({
      system: "",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "A", native: { provider: "anthropic", model: "claude-opus-5-5", data: raw } },
        { role: "user", content: "q2" },
        { role: "assistant", content: "B", native: { provider: "openai", model: "gpt-5", data: {} } },
      ],
    });
    expect(params.messages[1]).toEqual({ role: "assistant", content: raw });
    expect(params.messages[3]).toEqual({ role: "assistant", content: "B" });
  });
});

describe("AnthropicClient.chat", () => {
  it("streams text, returns the reply and normalised usage", async () => {
    const { client } = fakeClient(
      { usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 30 } as Anthropic.Beta.BetaUsage },
      ["Hel", "lo"],
    );
    const streamed: string[] = [];
    const res = await new AnthropicClient(settings, client).chat({
      system: "",
      messages: [{ role: "user", content: "hi" }],
      onText: (d) => streamed.push(d),
    });
    expect(streamed).toEqual(["Hel", "lo"]);
    expect(res.message.content).toBe("Hello");
    expect(res.message.native?.provider).toBe("anthropic");
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadTokens: 900, cacheWriteTokens: 30 });
  });

  it("maps refusal and max_tokens stop reasons", async () => {
    const refused = await new AnthropicClient(settings, fakeClient({ stop_reason: "refusal" }).client).chat({ system: "", messages: [] });
    expect(refused.stopReason).toBe("refusal");
    const cut = await new AnthropicClient(settings, fakeClient({ stop_reason: "max_tokens" }).client).chat({ system: "", messages: [] });
    expect(cut.stopReason).toBe("max_tokens");
  });

  it("turns SDK errors into ModelError", async () => {
    const authErr = Anthropic.APIError.generate(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, new Headers());
    const c = new AnthropicClient(settings, fakeClient({}, [], authErr).client);
    await expect(c.chat({ system: "", messages: [] })).rejects.toMatchObject({ kind: "auth", status: 401 });
  });
});

describe("toModelError", () => {
  const gen = (status: number) => Anthropic.APIError.generate(status, { error: { message: "x" } }, undefined, new Headers());

  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "rate_limit"],
    [400, "bad_request"],
    [500, "server"],
    [529, "server"],
  ])("HTTP %i -> %s", (status, kind) => {
    expect(toModelError(gen(status)).kind).toBe(kind);
  });

  it("classifies connection problems and cancellation", () => {
    expect(toModelError(new Anthropic.APIConnectionTimeoutError()).kind).toBe("timeout");
    expect(toModelError(new Anthropic.APIConnectionError({ message: "ECONNREFUSED" })).kind).toBe("network");
    expect(toModelError(new Anthropic.APIUserAbortError()).kind).toBe("aborted");
  });

  it("keeps error details to one short line", () => {
    const e = new ModelError("server", `line one\n\n   line two ${"x".repeat(500)}`);
    expect(e.detail).not.toContain("\n");
    expect(e.detail.length).toBeLessThanOrEqual(300);
    expect(e.detail.startsWith("line one line two")).toBe(true);
  });

  it("marks only transient errors as retryable", () => {
    expect(toModelError(gen(429)).retryable).toBe(true);
    expect(toModelError(gen(401)).retryable).toBe(false);
    expect(new ModelError("network", "").retryable).toBe(true);
  });
});

describe("AnthropicClient tools", () => {
  const tools = [
    {
      name: "view_file",
      description: "Read a file.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"] },
    },
  ];

  it("sends tools with eager input streaming on the real API only", () => {
    const p = new AnthropicClient(settings, fakeClient({}).client).buildParams({ system: "", messages: [], tools });
    expect(p.tools).toEqual([{ name: "view_file", description: "Read a file.", input_schema: tools[0]!.inputSchema, eager_input_streaming: true }]);
    const proxied = new AnthropicClient({ ...settings, baseUrl: "https://proxy.example" }, fakeClient({}).client);
    expect(proxied.buildParams({ system: "", messages: [], tools }).tools?.[0]).not.toHaveProperty("eager_input_streaming");
    expect(new AnthropicClient(settings, fakeClient({}).client).buildParams({ system: "", messages: [] })).not.toHaveProperty("tools");
  });

  it("sends tool results as a user turn, with is_error only on failures", () => {
    const p = new AnthropicClient(settings, fakeClient({}).client).buildParams({
      system: "",
      messages: [
        {
          role: "tool",
          results: [
            { callId: "t1", name: "view_file", content: "ok", isError: false },
            { callId: "t2", name: "view_file", content: "Error: x", isError: true },
          ],
        },
      ],
    });
    expect(p.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "tool_result", tool_use_id: "t2", content: "Error: x", is_error: true },
      ],
    });
  });

  it("rebuilds tool calls from another provider as tool_use blocks", () => {
    const p = new AnthropicClient(settings, fakeClient({}).client).buildParams({
      system: "",
      messages: [{ role: "assistant", content: "Looking.", toolCalls: [{ id: "call_1", name: "view_file", input: { path: "a" } }] }],
    });
    expect(p.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "call_1", name: "view_file", input: { path: "a" } },
      ],
    });
  });

  it("reads tool_use blocks from the reply", async () => {
    const content = [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "view_file", input: { path: "a.ts" } },
    ] as Anthropic.Beta.BetaContentBlock[];
    const res = await new AnthropicClient(settings, fakeClient({ content, stop_reason: "tool_use" }).client).chat({ system: "", messages: [], tools });
    expect(res.stopReason).toBe("tool_use");
    expect(res.message.content).toBe("Let me check.");
    expect(res.message.toolCalls).toEqual([{ id: "toolu_1", name: "view_file", input: { path: "a.ts" } }]);
    expect(res.message.native?.data).toEqual(content); // replayed unchanged next turn
  });

  it("maps the SDK's unparseable tool JSON error to invalid_output", () => {
    const err = new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model. JSON: {\"pa");
    expect(toModelError(err).kind).toBe("invalid_output");
    expect(toModelError(err).retryable).toBe(false);
  });
});
