import OpenAI from "openai";
import type { Effort, HarnessConfig } from "../config.js";
import type { Provider } from "../providers.js";
import { isQuotaGone, isTooLarge, ModelError } from "./errors.js";
import type { ChatRequest, ChatResponse, Message, ModelClient, StopReason, ToolCall, ToolSpec, Usage } from "./types.js";

/**
 * One adapter for every API that speaks the OpenAI Chat Completions format:
 * OpenAI itself, Groq, OpenRouter, and self-hosted or other compatible
 * endpoints (Ollama, vLLM, DeepSeek, Together, ...). Differences between them
 * are handled in buildParams().
 */

type OpenAIStyle = Extract<Provider, "openai" | "groq" | "openai-compatible">;

type Settings = Pick<HarnessConfig, "model" | "baseUrl" | "apiKey" | "maxOutputTokens" | "effort" | "temperature" | "seed" | "limits"> & {
  provider: OpenAIStyle;
};

/** OpenAI reasoning models reject sampling settings such as temperature. */
function isOpenAIReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/.test(model);
}

/** Models that accept `reasoning_effort` (OpenAI o-series / gpt-5, gpt-oss on any host). */
function acceptsReasoningEffort(model: string): boolean {
  return isOpenAIReasoningModel(model) || /(^|\/)gpt-oss/.test(model);
}

/** Not every model accepts xhigh/max; high is accepted everywhere effort is. */
function toReasoningEffort(e: Effort): "low" | "medium" | "high" {
  return e === "low" || e === "medium" ? e : "high";
}

export class OpenAICompatibleClient implements ModelClient {
  readonly provider: OpenAIStyle;
  readonly model: string;
  private readonly client: OpenAI;

  /** `client` can be injected for tests. */
  constructor(
    private readonly settings: Settings,
    client?: OpenAI,
  ) {
    this.provider = settings.provider;
    this.model = settings.model;
    this.client =
      client ??
      new OpenAI({
        apiKey: settings.apiKey,
        baseURL: settings.baseUrl,
        maxRetries: settings.limits.maxRetries,
        timeout: settings.limits.requestTimeoutS * 1000,
      });
  }

  /** The exact request body sent to the API (exposed for tests). */
  buildParams(request: ChatRequest): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
    const { provider, model, effort, temperature, seed, maxOutputTokens } = this.settings;
    const reasoning = isOpenAIReasoningModel(model);

    return {
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "system", content: request.system }, ...request.messages.flatMap(toParams)],
      ...(request.tools?.length ? { tools: request.tools.map(toTool) } : {}),
      // OpenAI and Groq use the newer name; generic servers mostly know only max_tokens.
      ...(provider === "openai-compatible"
        ? { max_tokens: request.maxOutputTokens ?? maxOutputTokens }
        : { max_completion_tokens: request.maxOutputTokens ?? maxOutputTokens }),
      ...(temperature !== undefined && !(provider === "openai" && reasoning) ? { temperature } : {}),
      ...(seed !== undefined && !(provider === "openai" && reasoning) ? { seed } : {}),
      ...(effort && acceptsReasoningEffort(model) ? { reasoning_effort: toReasoningEffort(effort) } : {}),
      // OpenAI caches long prompt prefixes automatically; a stable key routes
      // our requests to the same cache.
      ...(provider === "openai" ? { prompt_cache_key: "shrike" } : {}),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const stream = await this.client.chat.completions.create(this.buildParams(request), { signal: request.signal });

      let text = "";
      let finish: string | null = null;
      let usage: OpenAI.CompletionUsage | undefined;
      let model = this.model;
      // Tool calls stream in pieces, matched up by index.
      const calls: { id: string; name: string; args: string }[] = [];

      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          request.onText?.(delta);
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const call = (calls[tc.index] ??= { id: "", name: "", args: "" });
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        // Groq has also reported usage under x_groq.usage.
        const u = chunk.usage ?? (chunk as { x_groq?: { usage?: OpenAI.CompletionUsage } }).x_groq?.usage;
        if (u) usage = u;
      }

      const toolCalls = calls.filter(Boolean).map((c, i) => toToolCall(c, i));
      // Some servers report "stop" even when the reply is a tool call.
      const stopReason = toolCalls.length && finish === "stop" ? "tool_use" : toStopReason(finish);

      return {
        message: { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) },
        usage: toUsage(usage),
        stopReason,
        model,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      throw toModelError(err);
    }
  }
}

function toTool(t: ToolSpec): OpenAI.Chat.ChatCompletionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: { ...t.inputSchema } } };
}

function toToolCall(c: { id: string; name: string; args: string }, index: number): ToolCall {
  // Some compatible servers leave out the id; one is needed to match results.
  const id = c.id || `call_${index}`;
  if (!c.args.trim()) return { id, name: c.name, input: {} };
  try {
    return { id, name: c.name, input: JSON.parse(c.args) as unknown };
  } catch {
    return { id, name: c.name, input: undefined, rawInput: c.args };
  }
}

/** One neutral message can become several: each tool result is its own "tool" message. */
function toParams(m: Message): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (m.role === "user") return [{ role: "user", content: m.content }];
  if (m.role === "tool") {
    return m.results.map((r) => ({ role: "tool" as const, tool_call_id: r.callId, content: r.content }));
  }
  if (!m.toolCalls?.length) return [{ role: "assistant", content: m.content }];
  return [
    {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        // Broken JSON is replayed as {} (some servers reject invalid arguments
        // in history); the error result already shows the model what it sent.
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      })),
    },
  ];
}

function toUsage(u: OpenAI.CompletionUsage | undefined): Usage {
  if (!u) return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, u.prompt_tokens - cached),
    outputTokens: u.completion_tokens,
    cacheReadTokens: cached,
    cacheWriteTokens: 0, // OpenAI-style APIs don't charge for cache writes
  };
}

function toStopReason(r: string | null): StopReason {
  switch (r) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "other";
  }
}

/** Most specific SDK error class first: subclasses must be checked before parents. */
export function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  const opts = { cause: err };
  if (err instanceof OpenAI.APIUserAbortError) return new ModelError("aborted", "", undefined, opts);
  if (err instanceof OpenAI.APIConnectionTimeoutError) return new ModelError("timeout", "", undefined, opts);
  if (err instanceof OpenAI.APIConnectionError) return new ModelError("network", err.message, undefined, opts);
  if (err instanceof OpenAI.APIError) {
    const detail = err.message;
    if (isTooLarge(err.status, detail)) return new ModelError("too_large", detail, err.status, opts);
    // Groq (and some other hosts) check tool calls against the schema and reject the whole reply.
    if (err.code === "tool_use_failed" || /tool call validation failed|tool_use_failed/i.test(detail)) {
      return new ModelError("invalid_tool_call", detail, err.status, opts);
    }
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      return new ModelError("auth", detail, err.status, opts);
    }
    if (err instanceof OpenAI.NotFoundError) return new ModelError("not_found", detail, err.status, opts);
    if (err.code === "insufficient_quota" || (err.status === 429 && isQuotaGone(detail))) return new ModelError("quota", detail, err.status, opts);
    if (err instanceof OpenAI.RateLimitError) return new ModelError("rate_limit", detail, err.status, opts);
    if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError) {
      return new ModelError("bad_request", detail, err.status, opts);
    }
    if (err instanceof OpenAI.InternalServerError) return new ModelError("server", detail, err.status, opts);
    return new ModelError("unknown", detail, err.status, opts);
  }
  return new ModelError("unknown", err instanceof Error ? err.message : String(err), undefined, opts);
}
