import type { UsageTracker } from "../model/cost.js";
import { ModelError } from "../model/errors.js";
import { emptyUsage, type ChatResponse, type Message, type ModelClient, type ToolCall, type ToolResult, type Usage } from "../model/types.js";
import { FINISH_TOOL, type FinishInput } from "../tools/finish.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { CommandSandbox } from "../tools/types.js";
import { CHARS_PER_TOKEN, describeShrink, requestChars, shrinkMessages } from "./context.js";

/** How many times a turn is re-sent when the model's output can't be parsed. */
const MAX_INVALID_OUTPUT_RETRIES = 2;
/** Tool calls rejected by the provider in a row before the run stops. */
const MAX_REJECTED_TOOL_CALLS = 3;
/** "Request too large" errors in a row before the run stops (each one shortens the conversation further). */
const MAX_TOO_LARGE = 3;
/** Rate-limit waits in a row, and the longest wait, before the run stops. */
const MAX_RATE_WAITS = 6;
const MAX_RATE_WAIT_MS = 90_000;
/** Share of a learned limit a request may use: the estimate of its size is rough. */
const SAFETY = 0.85;

/**
 * Request limits learned from providers' "too large" errors, per model, for
 * the rest of the session: later requests are shortened before they are sent.
 */
const learnedLimits = new Map<string, { tokens: number; charsPerToken: number }>();

/** For tests. */
export function forgetLearnedLimits(): void {
  learnedLimits.clear();
}

/** The wait a rate-limit message asks for ("try again in 6.665s", "in 1m2.5s", "in 450ms"), or undefined. */
export function retryAfterMs(detail: string): number | undefined {
  const m = /try again in (?:(\d+)m)?([\d.]+)(ms|s)\b/i.exec(detail);
  if (!m) return undefined;
  return (Number(m[1] ?? 0) * 60 + Number(m[2]) / (m[3] === "ms" ? 1000 : 1)) * 1000;
}

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
  /** Something the user should know that the loop handled: the conversation was shortened, or it waits for a rate limit. */
  onNotice?(text: string): void;
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
  /** Keep each request under this many tokens (config max_request_tokens); learned from the provider when unset. */
  maxRequestTokens?: number;
  /** The configured output limit, never raised when a request has to fit a limit. */
  maxOutputTokens?: number;
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
  let tooLargeInARow = 0;
  let rateWaits = 0;

  /**
   * The request limit in force (learned, or configured) and what it means for
   * this request: the output cap, and the conversation shortened to fit.
   * Returns the output cap, or a ModelError if even the shortest request is too big.
   */
  const fit = (): { maxOutputTokens?: number } | ModelError => {
    const known = learnedLimits.get(model.model) ?? (opts.maxRequestTokens ? { tokens: opts.maxRequestTokens, charsPerToken: CHARS_PER_TOKEN } : undefined);
    if (!known) return {};
    const outputCap = Math.max(256, Math.min(opts.maxOutputTokens ?? Infinity, Math.floor(known.tokens * 0.25)));
    const budgetChars = (known.tokens * SAFETY - outputCap) * known.charsPerToken;
    const fixed = requestChars(opts.system, specs, []);
    const target = budgetChars - fixed;
    const current = requestChars("", [], messages);
    if (current > target) {
      const shrunk = shrinkMessages(messages, Math.max(0, target));
      if (shrunk.outputs || shrunk.inputs || shrunk.repoMap) events?.onNotice?.(describeShrink(shrunk, known.tokens));
      if (shrunk.after > target) {
        return new ModelError("too_large", `the system prompt, tools and latest turn need about ${Math.round((fixed + shrunk.after) / known.charsPerToken)} tokens; the limit is ${known.tokens}`);
      }
    }
    return { maxOutputTokens: outputCap };
  };

  const end = (status: AgentStatus, error?: ModelError, finished?: FinishInput): AgentResult => {
    closeOpenCalls(messages, status);
    return { status, messages, steps, usage, costUsd, costIncomplete, finalText, error, ...(finished ? { finished } : {}) };
  };

  while (true) {
    if (steps >= limits.maxSteps) return end("max_steps");
    if (costUsd >= limits.maxCostUsd) return end("budget");

    const fitted = fit();
    if (fitted instanceof ModelError) return end("error", fitted);

    let res: ChatResponse;
    try {
      res = await chatWithRetry(model, { system: opts.system, messages, tools: specs, signal, onText: events?.onText, ...fitted });
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      // Too big for the model or the plan: learn the limit, shorten the conversation, try again.
      if (err.kind === "too_large" && tooLargeInARow < MAX_TOO_LARGE && !signal?.aborted) {
        tooLargeInARow++;
        const chars = requestChars(opts.system, specs, messages);
        const estimated = chars / CHARS_PER_TOKEN;
        const previous = learnedLimits.get(model.model);
        // Without numbers in the message, aim for 60% of the request that failed (or of the last limit tried).
        const limit = err.sizes.limit ?? Math.floor(Math.min(previous?.tokens ?? Infinity, estimated) * 0.6);
        const charsPerToken = err.sizes.requested ? Math.min(5, Math.max(2.5, chars / err.sizes.requested)) : CHARS_PER_TOKEN;
        learnedLimits.set(model.model, { tokens: Math.min(limit, previous?.tokens ?? Infinity), charsPerToken: Math.min(charsPerToken, previous?.charsPerToken ?? Infinity) });
        events?.onNotice?.(`The request was too large for ${model.model} (${err.sizes.requested ? `${err.sizes.requested.toLocaleString("en-US")} tokens; ` : ""}limit ${limit.toLocaleString("en-US")}). Shortening the conversation and trying again.`);
        continue;
      }
      // A per-minute limit: wait as long as the provider says, then try again.
      const wait = err.kind === "rate_limit" ? retryAfterMs(err.detail) : undefined;
      if (wait !== undefined && wait <= MAX_RATE_WAIT_MS && rateWaits < MAX_RATE_WAITS && !signal?.aborted) {
        rateWaits++;
        events?.onNotice?.(`Rate limit: waiting ${(wait / 1000).toFixed(1)}s as the provider asks.`);
        if (!(await sleep(wait + 250, signal))) return end("cancelled");
        continue;
      }
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
    tooLargeInARow = 0;
    rateWaits = 0;
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
/** Waits, or stops early when cancelled. Returns false if cancelled. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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
