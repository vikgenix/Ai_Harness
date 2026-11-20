import type { UsageTracker } from "../model/cost.js";
import { ModelError } from "../model/errors.js";
import { emptyUsage, type ChatResponse, type Message, type ModelClient, type ToolCall, type ToolResult, type Usage } from "../model/types.js";
import { FINISH_TOOL, type FinishInput } from "../tools/finish.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CommandSandbox } from "../tools/types.js";

/** How many times a turn is re-sent when the model's output can't be parsed. */
const MAX_INVALID_OUTPUT_RETRIES = 2;
/** Tool calls rejected by the provider in a row before the run stops. */
const MAX_REJECTED_TOOL_CALLS = 3;

export type AgentStatus =
  | "done" // the model answered without asking for more tools
  | "finished" // the model called the finish tool
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
  /** The provider rejected the reply because a tool call did not match its schema; the model is told why and retries. */
  onRejectedToolCall?(detail: string): void;
  /** After each model response, with its cost (undefined if the model has no price). */
  onResponse?(response: ChatResponse, costUsd: number | undefined): void;
}

export interface AgentOptions {
  model: ModelClient;
  tools: ToolRegistry;
  system: string;
  /** Repository root the tools work in. */
  root: string;
  /** Extra environment for the agent's commands (the installed dependencies). */
  env?: Record<string, string>;
  /** Runs the agent's commands in a container instead of on this machine. */
  sandbox?: CommandSandbox;
  tracker: UsageTracker;
  limits: { maxSteps: number; maxCostUsd: number };
  /** Earlier conversation; the new task is appended to it. */
  history?: Message[];
  task: string;
  signal?: AbortSignal;
  events?: AgentEvents;
  /**
   * Called when the model calls finish. Returning a message holds the finish
   * back: the message is sent as the tool result and the run goes on (used for
   * the self-review in /fix). Not called when no step or budget is left.
   */
  beforeFinish?(input: FinishInput): Promise<string | undefined>;
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
  /** Text of the last reply, or the finish summary. */
  finalText: string;
  /** Set when the model ended the task with the finish tool. */
  finished?: FinishInput;
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
  let rejectedInARow = 0;

  const end = (status: AgentStatus, error?: ModelError, finished?: FinishInput): AgentResult => {
    closeOpenCalls(messages, status);
    return { status, messages, steps, usage, costUsd, costIncomplete, finalText, error, ...(finished ? { finished } : {}) };
  };

  while (true) {
    if (steps >= limits.maxSteps) return end("max_steps");
    if (costUsd >= limits.maxCostUsd) return end("budget");

    let res: ChatResponse;
    try {
      res = await chatWithRetry(model, { system: opts.system, messages, tools: specs, signal, onText: events?.onText });
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      // The provider refused a tool call that did not match the schema (no tool ran):
      // tell the model what was wrong, as for input the registry rejects, and let it retry.
      if (err.kind === "invalid_tool_call" && rejectedInARow < MAX_REJECTED_TOOL_CALLS && !signal?.aborted) {
        rejectedInARow++;
        steps++;
        events?.onRejectedToolCall?.(err.detail);
        addUserNote(messages, rejectionNote(err.detail));
        continue;
      }
      return end(err.kind === "aborted" ? "cancelled" : "error", err.kind === "aborted" ? undefined : err);
    }

    steps++;
    rejectedInARow = 0;
    messages.push(res.message);
    finalText = res.message.content;
    addUsage(usage, res.usage);
    const cost = tracker.add(res.usage, res.model);
    if (cost === undefined) costIncomplete = true;
    else costUsd += cost;
    events?.onResponse?.(res, cost);

    const calls = res.message.toolCalls ?? [];
    // A cut-off or refused reply may hold incomplete tool input: never run it.
    if (res.stopReason === "refusal") return end("refusal");
    if (res.stopReason === "max_tokens") return end("max_tokens");
    if (calls.length === 0) return end("done");

    const results: ToolResult[] = [];
    const heldBack = new Set<string>();
    for (const call of calls) {
      events?.onToolCall?.(call);
      const started = Date.now();
      let result: ToolResult =
        call.name === FINISH_TOOL && calls.length > 1
          ? // The model has not seen the other results yet (e.g. failing tests), so it cannot know it is done.
            { callId: call.id, name: call.name, content: "Error: call finish on its own, after you have seen the results of your other tool calls", isError: true }
          : await tools.run(call, { root: opts.root, signal, env: opts.env, sandbox: opts.sandbox });
      if (call.name === FINISH_TOOL && !result.isError && opts.beforeFinish && steps < limits.maxSteps && costUsd < limits.maxCostUsd && !signal?.aborted) {
        const objection = await opts.beforeFinish(call.input as FinishInput);
        if (objection !== undefined) {
          result = { callId: call.id, name: call.name, content: objection, isError: false };
          heldBack.add(call.id);
        }
      }
      results.push(result);
      events?.onToolResult?.(result, Date.now() - started);
    }
    messages.push({ role: "tool", results });
    if (signal?.aborted) return end("cancelled");

    const done = results.find((r) => r.name === FINISH_TOOL && !r.isError && !heldBack.has(r.callId));
    if (done) {
      const finished = calls.find((c) => c.id === done.callId)!.input as FinishInput;
      finalText = finished.summary;
      // A closing assistant turn keeps the conversation valid for a follow-up message on every provider.
      messages.push({ role: "assistant", content: finished.summary });
      return end("finished", undefined, finished);
    }
  }
}

function rejectionNote(detail: string): string {
  return [
    `[shrike] Your last reply was rejected by the model API, so no tool ran: ${detail}`,
    "Call each tool only with the parameters listed in its schema (names and types exactly as given), then continue.",
  ].join("\n");
}

/** Adds a note for the model as a user turn, joined to the previous one if that is a user turn too. */
function addUserNote(messages: Message[], note: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === "user") last.content = `${last.content}\n\n${note}`;
  else messages.push({ role: "user", content: note });
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
