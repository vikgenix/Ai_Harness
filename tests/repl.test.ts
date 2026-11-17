import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { UsageTracker } from "../src/model/cost.js";
import { ModelError, type ChatRequest, type ChatResponse, type ModelClient } from "../src/model/index.js";
import { startRepl } from "../src/ui/repl.js";

const config = loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } });

/** Fake model: replies with "echo: <last message>" or runs a custom handler. */
function fakeModel(handler?: (req: ChatRequest, call: number) => Promise<ChatResponse> | ChatResponse) {
  const requests: ChatRequest[] = [];
  const model: ModelClient = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    async chat(req) {
      requests.push(structuredClone({ ...req, onText: undefined, signal: undefined }));
      if (handler) return handler(req, requests.length);
      const last = req.messages[req.messages.length - 1]?.content ?? "";
      const text = `echo: ${last}`;
      req.onText?.(text);
      return {
        message: { role: "assistant", content: text },
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        model: "claude-opus-5-5",
        durationMs: 5,
      };
    },
  };
  return { model, requests };
}

async function run(lines: string[], model: ModelClient, tracker = new UsageTracker(config.pricing)) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));
  input.end(lines.map((l) => `${l}\n`).join(""));
  await startRepl({ config, model, tracker, input, output });
  return { out, tracker };
}

describe("interactive session", () => {
  it("sends chat messages with the full conversation and shows usage", async () => {
    const { model, requests } = fakeModel();
    const { out, tracker } = await run(["hello", "again", "/exit"], model);

    expect(out).toContain("echo: hello");
    expect(out).toContain("echo: again");
    expect(out).toContain("$4.0000"); // 1M input tokens of claude-opus-5-5
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.map((m) => m.content)).toEqual(["hello", "echo: hello", "again"]);
    expect(requests[0]!.system).toBe(requests[1]!.system); // stable system prompt for caching
    expect(tracker.requests).toBe(2);
  });

  it("/clear starts a new conversation; /cost shows totals", async () => {
    const { model, requests } = fakeModel();
    const { out } = await run(["one", "/clear", "two", "/cost", "/exit"], model);
    expect(requests[1]!.messages.map((m) => m.content)).toEqual(["two"]);
    expect(out).toContain("Started a new conversation.");
    expect(out).toMatch(/2 requests · 2,000,000 in · 0 out · \$8\.0000/);
  });

  it("reports model errors and keeps the failed turn out of the history", async () => {
    const { model, requests } = fakeModel((req, call) => {
      if (call === 1) throw new ModelError("auth", "invalid x-api-key", 401);
      return {
        message: { role: "assistant", content: "ok" },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        model: "claude-opus-5-5",
        durationMs: 1,
      };
    });
    const { out } = await run(["first", "second", "/exit"], model);
    expect(out).toContain("Model error: Check that AI_API_KEY is valid");
    expect(requests[1]!.messages.map((m) => m.content)).toEqual(["second"]);
  });

  it("explains refusals and cut-off replies", async () => {
    const reasons = ["refusal", "max_tokens"] as const;
    const { model } = fakeModel((_req, call) => ({
      message: { role: "assistant", content: "" },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: reasons[call - 1]!,
      model: "unlisted-model",
      durationMs: 1,
    }));
    const { out } = await run(["a", "b", "/cost"], model);
    expect(out).toContain("(the model declined to answer)");
    expect(out).toContain("(reply cut off at max_output_tokens)");
    expect(out).toContain("cost unknown");
    expect(out).toContain("no price for: unlisted-model");
  });

  it("keeps the slash commands working without calling the model", async () => {
    const { model, requests } = fakeModel();
    const { out } = await run(["/fix 3", "/repo https://github.com/o/r", "/fix 3", "/bogus"], model);
    expect(out).toContain("Set a repository first");
    expect(out).toContain("Repository set: https://github.com/o/r");
    expect(out).toContain("arrives in Phase 3");
    expect(out).toContain("Unknown command '/bogus'");
    expect(requests).toHaveLength(0);
  });
});
