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
const finishCall = (id: string, outcome = "completed", summary = "Changed hello.py; tests pass.") => ({ id, name: "finish", input: { outcome, summary } });

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
    expect(requests[0]!.tools!.map((t) => t.name)).toEqual(["view_file", "list_dir", "grep", "find_files", "edit_file", "create_file", "bash", "finish"]);
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

  it("stops when the model calls finish, with its summary", async () => {
    const { model, requests } = scripted([{ toolCalls: [view("t1")] }, { content: "Done.", toolCalls: [finishCall("f1")] }, { content: "never asked" }]);
    const result = await runAgent(options(model));
    expect(result.status).toBe("finished");
    expect(result.finished).toEqual({ outcome: "completed", summary: "Changed hello.py; tests pass." });
    expect(result.finalText).toBe("Changed hello.py; tests pass.");
    expect(requests).toHaveLength(2);
    // Ends with an assistant turn, so a follow-up message can be sent on any provider.
    expect(result.messages.slice(-2).map((m) => m.role)).toEqual(["tool", "assistant"]);
  });

  it("refuses finish called together with other tools, and keeps going", async () => {
    const { model, requests } = scripted([{ toolCalls: [view("t1"), finishCall("f1")] }, { toolCalls: [finishCall("f2", "blocked", "Tests fail.")] }]);
    const result = await runAgent(options(model));
    expect(requests[1]!.messages[2]).toMatchObject({
      role: "tool",
      results: [{ callId: "t1", isError: false }, { callId: "f1", isError: true, content: expect.stringContaining("call finish on its own") }],
    });
    expect(result.status).toBe("finished");
    expect(result.finished?.outcome).toBe("blocked");
  });

  it("keeps going when finish is called with invalid input", async () => {
    const { model } = scripted([{ toolCalls: [{ id: "f1", name: "finish", input: { outcome: "maybe", summary: "x" } }] }, { content: "ok" }]);
    const result = await runAgent(options(model));
    expect(result.status).toBe("done");
    expect(result.messages[2]).toMatchObject({ role: "tool", results: [{ isError: true }] });
  });

  it("lets beforeFinish hold a finish back once, sending its message as the result", async () => {
    const { model, requests } = scripted([{ toolCalls: [finishCall("f1")] }, { toolCalls: [finishCall("f2", "completed", "Revised.")] }]);
    const asked: string[] = [];
    const result = await runAgent(
      options(model, {
        beforeFinish: async (input) => {
          asked.push(input.summary);
          return asked.length === 1 ? "Review your diff first." : undefined;
        },
      }),
    );
    expect(asked).toEqual(["Changed hello.py; tests pass.", "Revised."]);
    expect(requests[1]!.messages[2]).toMatchObject({ role: "tool", results: [{ callId: "f1", content: "Review your diff first.", isError: false }] });
    expect(result).toMatchObject({ status: "finished", steps: 2, finished: { summary: "Revised." } });
  });

  it("does not ask beforeFinish when no step is left, or when finish failed", async () => {
    let calls = 0;
    const beforeFinish = async () => (calls++, "again");
    const last = await runAgent(options(scripted([{ toolCalls: [view("t1")] }, { toolCalls: [finishCall("f1")] }]).model, { beforeFinish, limits: { maxSteps: 2, maxCostUsd: 100 } }));
    expect(last.status).toBe("finished");
    const invalid = await runAgent(options(scripted([{ toolCalls: [{ id: "f1", name: "finish", input: { outcome: "maybe", summary: "x" } }] }, { content: "ok" }]).model, { beforeFinish }));
    expect(invalid.status).toBe("done");
    expect(calls).toBe(0);
  });

  it("tells the model when the provider rejects its tool call, and lets it retry", async () => {
    const rejected = new ModelError("invalid_tool_call", "parameters for tool grep did not match schema: missing properties: 'pattern'");
    const { model, requests } = scripted([{ error: rejected }, { toolCalls: [view("t1")] }, { error: rejected }, { content: "It prints hi." }]);
    const seen: string[] = [];
    const result = await runAgent(options(model, { events: { onRejectedToolCall: (d) => seen.push(d) } }));

    expect(result).toMatchObject({ status: "done", steps: 4, finalText: "It prints hi." });
    expect(seen).toHaveLength(2);
    // First rejection: joined to the task message; later: its own user turn after the tool results.
    const first = requests[1]!.messages;
    expect(first).toHaveLength(1);
    expect(first[0]!.role === "user" && first[0]!.content).toMatch(/^what does hello\.py print\?\n\n\[harness\] Your last reply was rejected by the model API, so no tool ran: .*missing properties: 'pattern'/);
    const later = requests[3]!.messages;
    expect(later.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(later[3]!.role === "user" && later[3]!.content).toContain("Call each tool only with the parameters listed in its schema");
  });

  it("stops after too many rejected tool calls in a row", async () => {
    const rejected = new ModelError("invalid_tool_call", "bad call");
    const result = await runAgent(options(scripted([{ error: rejected }, { error: rejected }, { error: rejected }, { error: rejected }, { content: "never" }]).model));
    expect(result.status).toBe("error");
    expect(result.error?.kind).toBe("invalid_tool_call");
    expect(result.steps).toBe(3);
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
