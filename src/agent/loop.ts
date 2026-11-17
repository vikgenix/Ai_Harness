import type { UsageTracker } from "../model/cost.js";
import { ModelError } from "../model/errors.js";
import { emptyUsage, type ChatResponse, type Message, type ModelClient, type ToolCall, type ToolResult, type Usage } from "../model/types.js";
import type { ToolRegistry } from "../tools/registry.js";

/** How many times a turn is re-sent when the model's output can't be parsed. */
const MAX_INVALID_OUTPUT_RETRIES = 2;

export type AgentStatus =
  | "done" // the model answered without asking for more tools
  | "max_steps" // limits.max_steps reached
  | "budget" // limits.max_cost_usd reached
  | "max_tokens" // the reply hit the output limit
  | "refusal" // declined by a safety filter
  | "cancelled" // stopped by the user
  | "error"; // a model error the SDK could not recover from

export interface AgentEvents {
  /** Streamed reply text. */
  onText?(delta: string): void;
  onToolCall?(call: ToolCall): void;
  onToolResult?(result: ToolResult, durationMs: number): void;
  /** After each model response, with its cost (undefined if the model has no price). */
  onResponse?(response: ChatResponse, costUsd: number | undefined): void;
}

export interface AgentOptions {
  model: ModelClient;
  tools: ToolRegistry;
  system: string;
  /** Repository root the tools work in. */
  root: string;
  tracker: UsageTracker;
  limits: { maxSteps: number; maxCostUsd: number };
  /** Earlier conversation; the new task is appended to it. */
  history?: Message[];
  task: string;
  signal?: AbortSignal;
  events?: AgentEvents;
}

export interface AgentResult {
  status: AgentStatus;
  /** Full conversation including this run. Every tool call has a result, so it can be continued. */
  messages: Message[];
  /** Model requests made in this run. */
  steps: number;
  usage: Usage;
  /** Cost of this run (priced models only). */
  costUsd: number;
  /** True if a model without a price was used, so costUsd is incomplete. */
  costIncomplete: boolean;
  /** Text of the last reply. */
  finalText: string;
  error?: ModelError;
}

/**
 * The agent loop: ask the model, run the tools it calls, send back the
 * results, repeat until it answers without tools or a limit is reached.
 */
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const { model, tools, tracker, limits, signal, events } = opts;
  const specs = tools.specs();
  const messages: Message[] = [...(opts.history ?? []), { role: "user", content: opts.task }];
  const usage = emptyUsage();
  let costUsd = 0;
  let costIncomplete = false;
  let steps = 0;
  let finalText = "";

  const finish = (status: AgentStatus, error?: ModelError): AgentResult => {
    closeOpenCalls(messages, status);
    return { status, messages, steps, usage, costUsd, costIncomplete, finalText, error };
  };

  while (true) {
    if (steps >= limits.maxSteps) return finish("max_steps");
    if (costUsd >= limits.maxCostUsd) return finish("budget");

    let res: ChatResponse;
    try {
      res = await chatWithRetry(model, { system: opts.system, messages, tools: specs, signal, onText: events?.onText });
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      return finish(err.kind === "aborted" ? "cancelled" : "error", err.kind === "aborted" ? undefined : err);
    }

    steps++;
    messages.push(res.message);
    finalText = res.message.content;
    addUsage(usage, res.usage);
    const cost = tracker.add(res.usage, res.model);
    if (cost === undefined) costIncomplete = true;
    else costUsd += cost;
    events?.onResponse?.(res, cost);

    const calls = res.message.toolCalls ?? [];
    // A cut-off or refused reply may hold incomplete tool input: never run it.
    if (res.stopReason === "refusal") return finish("refusal");
    if (res.stopReason === "max_tokens") return finish("max_tokens");
    if (calls.length === 0) return finish("done");

    const results: ToolResult[] = [];
    for (const call of calls) {
      events?.onToolCall?.(call);
      const started = Date.now();
      const result = await tools.run(call, { root: opts.root, signal });
      results.push(result);
      events?.onToolResult?.(result, Date.now() - started);
    }
    messages.push({ role: "tool", results });
    if (signal?.aborted) return finish("cancelled");
  }
}

/** Re-sends a turn whose output could not be parsed (e.g. broken streamed tool JSON). */
async function chatWithRetry(model: ModelClient, request: Parameters<ModelClient["chat"]>[0]): Promise<ChatResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await model.chat(request);
    } catch (err) {
      if (err instanceof ModelError && err.kind === "invalid_output" && attempt < MAX_INVALID_OUTPUT_RETRIES) continue;
      throw err;
    }
  }
}

/**
 * Providers reject a conversation where a tool call has no result. When a run
 * stops early, answer any open calls so the conversation can be continued.
 */
function closeOpenCalls(messages: Message[], status: AgentStatus): void {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || !last.toolCalls?.length) return;
  const reason =
    status === "max_tokens"
      ? "your reply hit the output limit before this tool call was complete; retry with smaller input"
      : `the run stopped (${status}) before this tool ran`;
  messages.push({
    role: "tool",
    results: last.toolCalls.map((c) => ({ callId: c.id, name: c.name, content: `Error: not run: ${reason}`, isError: true })),
  });
}

function addUsage(total: Usage, u: Usage): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens += u.cacheReadTokens;
  total.cacheWriteTokens += u.cacheWriteTokens;
}
