import OpenAI from "openai";
import type { Effort, HarnessConfig } from "../config.js";
import type { Provider } from "../providers.js";
import { ModelError } from "./errors.js";
import type { ChatRequest, ChatResponse, Message, ModelClient, StopReason, Usage } from "./types.js";

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
      messages: [{ role: "system", content: request.system }, ...request.messages.map(toParam)],
      // OpenAI and Groq use the newer name; generic servers mostly know only max_tokens.
      ...(provider === "openai-compatible" ? { max_tokens: maxOutputTokens } : { max_completion_tokens: maxOutputTokens }),
      ...(temperature !== undefined && !(provider === "openai" && reasoning) ? { temperature } : {}),
      ...(seed !== undefined && !(provider === "openai" && reasoning) ? { seed } : {}),
      ...(effort && acceptsReasoningEffort(model) ? { reasoning_effort: toReasoningEffort(effort) } : {}),
      // OpenAI caches long prompt prefixes automatically; a stable key routes
      // our requests to the same cache.
      ...(provider === "openai" ? { prompt_cache_key: "ai-harness" } : {}),
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

      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          request.onText?.(delta);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        // Groq has also reported usage under x_groq.usage.
        const u = chunk.usage ?? (chunk as { x_groq?: { usage?: OpenAI.CompletionUsage } }).x_groq?.usage;
        if (u) usage = u;
      }

      return {
        message: { role: "assistant", content: text },
        usage: toUsage(usage),
        stopReason: toStopReason(finish),
        model,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      throw toModelError(err);
    }
  }
}

function toParam(m: Message): OpenAI.Chat.ChatCompletionMessageParam {
  return { role: m.role, content: m.content };
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
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      return new ModelError("auth", detail, err.status, opts);
    }
    if (err instanceof OpenAI.NotFoundError) return new ModelError("not_found", detail, err.status, opts);
    if (err instanceof OpenAI.RateLimitError) return new ModelError("rate_limit", detail, err.status, opts);
    if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError) {
      return new ModelError("bad_request", detail, err.status, opts);
    }
    if (err instanceof OpenAI.InternalServerError) return new ModelError("server", detail, err.status, opts);
    return new ModelError("unknown", detail, err.status, opts);
  }
  return new ModelError("unknown", err instanceof Error ? err.message : String(err), undefined, opts);
}
