import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgent, type AgentOptions } from "../../src/agent/loop.js";
import { loadConfig } from "../../src/config.js";
import { UsageTracker } from "../../src/model/cost.js";
import { ModelError, type AssistantMessage, type ChatRequest, type ChatResponse, type ModelClient, type StopReason } from "../../src/model/index.js";
import { createDefaultTools } from "../../src/tools/index.js";

const config = loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } });
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "harness-agent-"));
  await writeFile(path.join(root, "hello.py"), "print('hi')\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type Step = Partial<AssistantMessage> & { stop?: StopReason; error?: unknown };

/** Fake model that plays back scripted replies and records each request. */
function scripted(steps: Step[]) {
  const requests: ChatRequest[] = [];
  const model: ModelClient = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    async chat(req) {
      requests.push(structuredClone({ ...req, onText: undefined, signal: undefined }));
      const step = steps[requests.length - 1] ?? { content: "out of script" };
      if (step.error) throw step.error;
      const content = step.content ?? "";
      req.onText?.(content);
      return {
        message: { role: "assistant", content, ...(step.toolCalls ? { toolCalls: step.toolCalls } : {}) },
        usage: { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, // $0.40 each
        stopReason: step.stop ?? (step.toolCalls ? "tool_use" : "end"),
        model: "claude-opus-5-5",
        durationMs: 1,
      } satisfies ChatResponse;
    },
  };
  return { model, requests };
}

const view = (id: string, file = "hello.py") => ({ id, name: "view_file", input: { path: file } });

function options(model: ModelClient, extra: Partial<AgentOptions> = {}): AgentOptions {
  return {
    model,
    tools: createDefaultTools(),
    system: "sys",
    root,
    tracker: new UsageTracker(config.pricing),
    limits: { maxSteps: 10, maxCostUsd: 100 },
    task: "what does hello.py print?",
    ...extra,
  };
}

describe("runAgent", () => {
  it("runs requested tools, sends results back, and stops at the answer", async () => {
    const { model, requests } = scripted([{ content: "Let me look.", toolCalls: [view("t1")] }, { content: "It prints hi." }]);
    const seen: string[] = [];
    const result = await runAgent(
      options(model, {
        events: { onToolCall: (c) => seen.push(`call ${c.name}`), onToolResult: (r) => seen.push(`result ${r.isError}`) },
      }),
    );

    expect(result.status).toBe("done");
    expect(result.steps).toBe(2);
    expect(result.finalText).toBe("It prints hi.");
    expect(result.costUsd).toBeCloseTo(0.8);
    expect(seen).toEqual(["call view_file", "result false"]);
    // Second request: task, assistant tool call, tool result; same tools and system.
    expect(requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(requests[1]!.messages[2]).toEqual({
      role: "tool",
      results: [{ callId: "t1", name: "view_file", content: "1\tprint('hi')", isError: false }],
    });
    expect(requests[0]!.tools!.map((t) => t.name)).toEqual(["view_file", "list_dir"]);
    expect(requests[1]!.tools).toEqual(requests[0]!.tools);
  });

  it("continues an earlier conversation", async () => {
    const { model, requests } = scripted([{ content: "ok" }]);
    await runAgent(options(model, { history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "yes" }] }));
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("returns tool errors to the model instead of failing the run", async () => {
    const { model, requests } = scripted([{ toolCalls: [view("t1", "missing.py")] }, { content: "No such file." }]);
    const result = await runAgent(options(model));
    expect(result.status).toBe("done");
    const toolMsg = requests[1]!.messages[2];
    expect(toolMsg).toMatchObject({ role: "tool", results: [{ isError: true, content: "Error: file not found: missing.py" }] });
  });

  it("stops at max_steps and answers the open tool call", async () => {
    const { model } = scripted(Array.from({ length: 5 }, (_, i) => ({ toolCalls: [view(`t${i}`)] })));
    const result = await runAgent(options(model, { limits: { maxSteps: 3, maxCostUsd: 100 } }));
    expect(result.status).toBe("max_steps");
    expect(result.steps).toBe(3);
    // Every tool call has a result, so the conversation can be continued.
    const last = result.messages[result.messages.length - 1];
    expect(last?.role).toBe("tool");
  });

  it("stops when the cost limit is reached", async () => {
    const { model } = scripted(Array.from({ length: 5 }, (_, i) => ({ toolCalls: [view(`t${i}`)] })));
    const result = await runAgent(options(model, { limits: { maxSteps: 10, maxCostUsd: 1 } }));
    expect(result.status).toBe("budget");
    expect(result.steps).toBe(3); // $0.40 per step: stops once $1.20 >= $1
  });

  it("never runs tools from a cut-off reply", async () => {
    const { model } = scripted([{ toolCalls: [view("t1")], stop: "max_tokens" }]);
    let ran = false;
    const result = await runAgent(options(model, { events: { onToolCall: () => (ran = true) } }));
    expect(result.status).toBe("max_tokens");
    expect(ran).toBe(false);
    expect(result.messages[result.messages.length - 1]).toMatchObject({
      role: "tool",
      results: [{ callId: "t1", isError: true, content: expect.stringContaining("output limit") }],
    });
  });

  it("re-sends a turn whose tool JSON could not be parsed", async () => {
    const broken = new ModelError("invalid_output", "Unable to parse tool parameter JSON");
    const { model, requests } = scripted([{ error: broken }, { content: "fine" }]);
    const result = await runAgent(options(model));
    expect(result.status).toBe("done");
    expect(requests).toHaveLength(2);
  });

  it("reports model errors and cancellation as a status", async () => {
    const auth = await runAgent(options(scripted([{ error: new ModelError("auth", "bad key", 401) }]).model));
    expect(auth.status).toBe("error");
    expect(auth.error?.kind).toBe("auth");
    expect(auth.steps).toBe(0);

    const cancelled = await runAgent(options(scripted([{ error: new ModelError("aborted", "") }]).model));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.error).toBeUndefined();
  });
});
