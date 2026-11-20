import Anthropic from "@anthropic-ai/sdk";
import type { HarnessConfig } from "../config.js";
import { DEFAULT_BASE_URLS } from "../providers.js";
import { isQuotaGone, isTooLarge, ModelError } from "./errors.js";
import type { ChatRequest, ChatResponse, Message, ModelClient, StopReason, ToolCall, ToolSpec, Usage } from "./types.js";

/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`).
 * For other models the parameter is left out.
 */
const FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type Settings = Pick<HarnessConfig, "model" | "baseUrl" | "apiKey" | "maxOutputTokens" | "effort" | "refusalFallback" | "limits">;

export class AnthropicClient implements ModelClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;

  /** `client` can be injected for tests. */
  constructor(
    private readonly settings: Settings,
    client?: Anthropic,
  ) {
    this.model = settings.model;
    this.client =
      client ??
      new Anthropic({
        apiKey: settings.apiKey,
        baseURL: settings.baseUrl,
        maxRetries: settings.limits.maxRetries,
        timeout: settings.limits.requestTimeoutS * 1000,
      });
  }

  /** The exact request body sent to the API (exposed for tests). */
  buildParams(request: ChatRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
    const useFallback = this.settings.refusalFallback && FALLBACK_MODELS.has(this.model);
    return {
      model: this.model,
      max_tokens: request.maxOutputTokens ?? this.settings.maxOutputTokens,
      // Automatic prompt caching: caches the longest stable prefix
      // (system prompt + earlier turns), so each new turn pays full price only
      // for what is new.
      cache_control: { type: "ephemeral" },
      system: request.system,
      messages: request.messages.map((m) => this.toParam(m)),
      ...(request.tools?.length ? { tools: request.tools.map((t) => this.toTool(t)) } : {}),
      ...(this.settings.effort ? { output_config: { effort: this.settings.effort } } : {}),
      ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const stream = this.client.beta.messages.stream(this.buildParams(request), { signal: request.signal });
      if (request.onText) {
        const onText = request.onText;
        stream.on("text", (delta) => onText(delta));
      }
      const msg = await stream.finalMessage();

      const text = msg.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls: ToolCall[] = msg.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      return {
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length ? { toolCalls } : {}),
          native: { provider: "anthropic", model: msg.model, data: msg.content },
        },
        usage: toUsage(msg.usage),
        stopReason: toStopReason(msg.stop_reason),
        model: msg.model,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      throw toModelError(err);
    }
  }

  private toTool(t: ToolSpec): Anthropic.Beta.BetaTool {
    return {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      // Stream tool input as it is generated instead of after server-side
      // buffering (large file edits otherwise arrive in one late burst). The
      // input is then not validated by the API: the tool registry validates it,
      // and the agent loop never runs tools from a cut-off reply. Proxies may
      // reject the field, so only send it to the real API.
      ...(this.settings.baseUrl === DEFAULT_BASE_URLS.anthropic ? { eager_input_streaming: true } : {}),
    };
  }

  private toParam(m: Message): Anthropic.Beta.BetaMessageParam {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
    }
    // Send Claude's own reply back unchanged (thinking and tool_use blocks
    // included). The API drops blocks a different model can't read, so this
    // is safe even after a fallback switched models.
    if (m.native?.provider === "anthropic") {
      return { role: "assistant", content: m.native.data as Anthropic.Beta.BetaContentBlockParam[] };
    }
    if (!m.toolCalls?.length) return { role: "assistant", content: m.content };
    return {
      role: "assistant",
      content: [
        ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
        ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input ?? {} })),
      ],
    };
  }
}

function toUsage(u: Anthropic.Beta.BetaUsage): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function toStopReason(r: Anthropic.Beta.BetaStopReason | null): StopReason {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "tool_use":
      return "tool_use";
    default:
      return "other";
  }
}

/** Most specific SDK error class first: subclasses must be checked before parents. */
export function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  const opts = { cause: err };
  if (err instanceof Anthropic.APIUserAbortError) return new ModelError("aborted", "", undefined, opts);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ModelError("timeout", "", undefined, opts);
  if (err instanceof Anthropic.APIConnectionError) return new ModelError("network", err.message, undefined, opts);
  if (err instanceof Anthropic.APIError) {
    const detail = err.apiMessage ?? err.message;
    if (isTooLarge(err.status, detail)) return new ModelError("too_large", detail, err.status, opts);
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return new ModelError("auth", detail, err.status, opts);
    }
    if (err instanceof Anthropic.NotFoundError) return new ModelError("not_found", detail, err.status, opts);
    if (isQuotaGone(detail)) return new ModelError("quota", detail, err.status, opts);
    if (err instanceof Anthropic.RateLimitError) return new ModelError("rate_limit", detail, err.status, opts);
    if (err instanceof Anthropic.BadRequestError) return new ModelError("bad_request", detail, err.status, opts);
    if (err instanceof Anthropic.InternalServerError) return new ModelError("server", detail, err.status, opts);
    return new ModelError("unknown", detail, err.status, opts);
  }
  // Raised by the SDK when streamed tool input is not valid JSON at all.
  if (err instanceof Anthropic.AnthropicError && err.message.startsWith("Unable to parse tool parameter JSON")) {
    return new ModelError("invalid_output", err.message, undefined, opts);
  }
  return new ModelError("unknown", err instanceof Error ? err.message : String(err), undefined, opts);
}
