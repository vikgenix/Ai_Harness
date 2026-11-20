import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeShrink, REMOVED_NOTE, requestChars, shrinkMessages } from "../../src/agent/context.js";
import { forgetLearnedLimits, retryAfterMs, runAgent } from "../../src/agent/loop.js";
import { loadConfig } from "../../src/config.js";
import { UsageTracker } from "../../src/model/cost.js";
import { isTooLarge, ModelError, tooLargeSizes } from "../../src/model/errors.js";
import type { ChatRequest, Message, ModelClient } from "../../src/model/index.js";
import { toModelError } from "../../src/model/openai.js";
import { createDefaultTools } from "../../src/tools/index.js";

/** The message Groq sent in the user's session (organization id replaced). */
const GROQ_413 =
  "413 Request too large for model `openai/gpt-oss-120b` in organization `org_test` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8844, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing";

describe("recognizing a request that is too large", () => {
  it.each([
    ["Groq", GROQ_413, { limit: 8000, requested: 8844 }],
    ["OpenAI", "This model's maximum context length is 128000 tokens. However, your messages resulted in 131,072 tokens.", { limit: 128000, requested: 131072 }],
    ["Anthropic", "prompt is too long: 210345 tokens > 200000 maximum", { limit: 200000, requested: 210345 }],
    ["Gemini", "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).", { limit: 1048576, requested: 1100000 }],
  ])("%s", (_name, message, sizes) => {
    expect(isTooLarge(400, message)).toBe(true);
    expect(tooLargeSizes(message)).toEqual(sizes);
  });

  it("keeps the sizes even when the message is shortened for display", () => {
    const long = `${"x".repeat(400)} Limit 6000, Requested 9000`;
    const err = new ModelError("too_large", long, 413);
    expect(err.detail.length).toBeLessThanOrEqual(300);
    expect(err.sizes).toEqual({ limit: 6000, requested: 9000 });
    expect(err.message).toMatch(/^The request is larger than this model or plan allows/);
  });

  it("maps Groq's 413 to too_large instead of an unknown error", () => {
    const err = OpenAI.APIError.generate(413, { error: { message: GROQ_413.slice(4), type: "tokens", code: "rate_limit_exceeded" } }, undefined, new Headers());
    expect(toModelError(err)).toMatchObject({ kind: "too_large", sizes: { limit: 8000, requested: 8844 } });
    expect(isTooLarge(429, "Rate limit reached for model ... Please try again in 6.6s")).toBe(false);
  });

  it("reads the wait a rate-limit message asks for", () => {
    expect(retryAfterMs("Please try again in 6.665s.")).toBe(6665);
    expect(retryAfterMs("Please try again in 1m2.5s")).toBe(62500);
    expect(retryAfterMs("Please retry in 30.5s.")).toBe(30500); // Gemini
    expect(retryAfterMs("try again in 450ms")).toBe(450);
    expect(retryAfterMs("slow down")).toBeUndefined();
  });
});

const big = (n: number, ch = "x") => ch.repeat(n);

/** A conversation: the task with a repository map, then turns of tool calls and their outputs. */
function conversation(turns = 4): Message[] {
  const messages: Message[] = [{ role: "user", content: `<repo_map>\n${big(4000, "m")}\n</repo_map>\nThe map above lists files.\n\nFix the bug.` }];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: "assistant",
      content: `step ${i}`,
      toolCalls: [{ id: `c${i}`, name: "create_file", input: { path: `f${i}.py`, content: big(1000, "c") } }],
      native: { provider: "anthropic", model: "m", data: { raw: true } },
    });
    messages.push({ role: "tool", results: [{ callId: `c${i}`, name: "create_file", content: `output ${i}\n${big(3000, "o")}`, isError: false }] });
  }
  return messages;
}

describe("shrinkMessages", () => {
  it("shortens older tool outputs first and keeps the latest turns whole", () => {
    const messages = conversation();
    const before = requestChars("", [], messages);
    const r = shrinkMessages(messages, before - 5000);
    expect(r).toMatchObject({ outputs: 2, inputs: 0, repoMap: false });
    const outputs = messages.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.results[0]!.content : ""));
    expect(outputs[0]).toMatch(new RegExp(`^output 0\\no+\\n${REMOVED_NOTE.replace(/[[\]]/g, "\\$&")}$`));
    expect(outputs[1]!.endsWith(REMOVED_NOTE)).toBe(true);
    expect(outputs[2]).toBe(`output 2\n${big(3000, "o")}`); // the last two turns stay whole
    expect(outputs[3]).toBe(`output 3\n${big(3000, "o")}`);
    expect(r.after).toBeLessThanOrEqual(before - 5000);
  });

  it("then older tool inputs (dropping the provider's raw copy), the repository map, and last the latest outputs", () => {
    const messages = conversation();
    const r = shrinkMessages(messages, 4000);
    expect(r.outputs).toBe(4);
    expect(r.inputs).toBe(2);
    expect(r.repoMap).toBe(true);
    const first = messages[1]!;
    expect(first.role === "assistant" && first.native).toBeUndefined();
    expect(first.role === "assistant" && (first.toolCalls![0]!.input as { content: string }).content).toMatch(/^c+… \[1000 characters, shortened by Shrike\]$/);
    const last = messages[7]!;
    expect(last.role === "assistant" && last.native).toBeDefined(); // the latest turns keep theirs
    expect(messages[0]!.role === "user" && messages[0]!.content).toBe("<repo_map>\n(Left out to fit the model's request limit: use find_files, list_dir and grep to find the code.)\n</repo_map>\n\nFix the bug.");
    expect(describeShrink(r, 8000)).toMatch(/^Shortened the conversation to fit the model's limit of 8,000 tokens: 4 tool outputs, 2 tool inputs, the repository map \(\d+k → \d+k characters\)\.$/);
  });

  it("says when it cannot get under the target", () => {
    const messages: Message[] = [{ role: "user", content: big(5000) }];
    expect(shrinkMessages(messages, 1000).after).toBe(5000);
  });
});

// --- the loop ---------------------------------------------------------------------------

const config = loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } });
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "shrike-context-"));
  await writeFile(path.join(root, "big.txt"), big(30_000, "b"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => forgetLearnedLimits());

/**
 * A model with a request limit like Groq's free tier: a request bigger than
 * `limitChars` fails with a 413 naming the limit. It prints big.txt once (30,000 characters), then finishes.
 */
function limited(limitChars: number, replies = 3) {
  const requests: { chars: number; maxOutputTokens?: number }[] = [];
  let answered = 0;
  const model: ModelClient = {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    async chat(req: ChatRequest) {
      const chars = requestChars(req.system, req.tools ?? [], req.messages);
      requests.push({ chars, maxOutputTokens: req.maxOutputTokens });
      if (chars > limitChars) throw new ModelError("too_large", `Limit ${limitChars / 4}, Requested ${Math.round(chars / 4)}`, 413);
      answered++;
      const toolCalls =
        answered === 1
          ? [{ id: "v1", name: "bash", input: { command: "cat big.txt" } }]
          : answered < replies
            ? [{ id: `v${answered}`, name: "list_dir", input: {} }]
            : [{ id: "f", name: "finish", input: { outcome: "completed", summary: "Done." } }];
      return { message: { role: "assistant", content: "", toolCalls }, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "tool_use", model: "openai/gpt-oss-120b", durationMs: 1 };
    },
  };
  return { model, requests };
}

const run = (model: ModelClient, notices: string[] = [], extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
  runAgent({
    model,
    tools: createDefaultTools(),
    system: "sys",
    root,
    tracker: new UsageTracker(config.pricing),
    limits: { maxSteps: 10, maxCostUsd: 100 },
    task: "read big.txt",
    events: { onNotice: (t) => notices.push(t) },
    maxOutputTokens: 16000,
    ...extra,
  });

describe("runAgent within a request limit", () => {
  it("learns the limit from the error, shortens the conversation, and goes on", async () => {
    const { model, requests } = limited(20_000);
    const notices: string[] = [];
    const result = await run(model, notices);
    expect(result.status).toBe("finished");
    expect(notices[0]).toMatch(/^The request was too large for openai\/gpt-oss-120b \(\d[\d,]* tokens; limit 5,000\)\. Shortening the conversation and trying again\.$/);
    expect(notices[1]).toMatch(/^Shortened the conversation to fit the model's limit of 5,000 tokens: 1 tool output/);
    const failed = requests.findIndex((r) => r.chars > 20_000);
    expect(failed).toBe(1); // the request after the big output
    const after = requests.slice(failed + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.chars <= 20_000 && r.maxOutputTokens === 1250)).toBe(true); // a quarter of the limit for output
  });

  it("starts within a limit learned earlier in the session, or set in the config", async () => {
    await run(limited(20_000).model);
    const second = limited(20_000);
    const notices: string[] = [];
    expect((await run(second.model, notices)).status).toBe("finished");
    expect(second.requests.every((r) => r.chars <= 20_000)).toBe(true); // no 413 this time
    expect(notices.some((n) => n.startsWith("The request was too large"))).toBe(false);

    forgetLearnedLimits();
    const configured = limited(20_000);
    expect((await run(configured.model, [], { maxRequestTokens: 5000 })).status).toBe("finished");
    expect(configured.requests.every((r) => r.chars <= 20_000 && r.maxOutputTokens === 1250)).toBe(true);
  });

  it("stops with a clear message when even the shortest request is too big", async () => {
    const { model } = limited(600);
    const result = await run(model, [], { system: big(3000, "s") });
    expect(result.status).toBe("error");
    expect(result.error?.kind).toBe("too_large");
    expect(result.error?.message).toMatch(/^The request is larger than this model or plan allows, even after shortening the conversation\. Use a model or plan with higher limits \(Groq's free tier allows about 8,000 tokens per minute\), or lower repo_map_tokens\./);
  });

  it("waits as long as a per-minute rate limit asks, then goes on", async () => {
    let calls = 0;
    const model: ModelClient = {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      async chat() {
        if (calls++ === 0) throw new ModelError("rate_limit", "Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000. Please try again in 0.05s.", 429);
        return { message: { role: "assistant", content: "hi" }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: "end", model: "openai/gpt-oss-120b", durationMs: 1 };
      },
    };
    const notices: string[] = [];
    expect((await run(model, notices)).status).toBe("done");
    expect(notices).toEqual(["Rate limit: waiting 0.1s as the provider asks."]);
  });
});
