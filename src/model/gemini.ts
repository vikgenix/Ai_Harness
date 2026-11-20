import {
  ApiError,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type FunctionDeclaration,
  type GenerateContentParameters,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import type { Effort, HarnessConfig } from "../config.js";
import { isTooLarge, ModelError } from "./errors.js";
import type { ChatRequest, ChatResponse, Message, ModelClient, StopReason, ToolCall, ToolSpec, Usage } from "./types.js";

/**
 * Gemini does not always give function calls an id. Calls without one get a
 * local id with this prefix, which is never sent back to the API (results are
 * then matched by name and order, as Gemini expects).
 */
const LOCAL_ID_PREFIX = "gemini-local-";

type Settings = Pick<HarnessConfig, "model" | "baseUrl" | "apiKey" | "maxOutputTokens" | "effort" | "temperature" | "seed" | "limits">;

/** Gemini 3 models use thinking levels and should keep the default temperature. */
function isGemini3(model: string): boolean {
  return /^gemini-3/.test(model);
}

function thinkingConfig(model: string, effort: Effort | undefined): GenerateContentParameters["config"] {
  if (!effort) return {};
  if (isGemini3(model)) {
    const level = effort === "low" ? ThinkingLevel.LOW : effort === "medium" ? ThinkingLevel.MEDIUM : ThinkingLevel.HIGH;
    return { thinkingConfig: { thinkingLevel: level } };
  }
  if (/^gemini-2\.5/.test(model)) {
    // Token budgets; -1 lets the model decide (its default).
    const budget = effort === "low" ? 1024 : effort === "medium" ? 8192 : -1;
    return { thinkingConfig: { thinkingBudget: budget } };
  }
  return {};
}

export class GeminiClient implements ModelClient {
  readonly provider = "gemini" as const;
  readonly model: string;
  private readonly client: GoogleGenAI;

  /** `client` can be injected for tests. */
  constructor(
    private readonly settings: Settings,
    client?: GoogleGenAI,
  ) {
    this.model = settings.model;
    this.client =
      client ??
      new GoogleGenAI({
        apiKey: settings.apiKey,
        httpOptions: {
          baseUrl: settings.baseUrl,
          timeout: settings.limits.requestTimeoutS * 1000,
          retryOptions: { attempts: settings.limits.maxRetries + 1 },
        },
      });
  }

  /** The exact request sent to the API (exposed for tests). */
  buildParams(request: ChatRequest): GenerateContentParameters {
    const { model, maxOutputTokens, temperature, seed, effort } = this.settings;
    return {
      model,
      contents: request.messages.map(toContent),
      config: {
        systemInstruction: request.system,
        maxOutputTokens: request.maxOutputTokens ?? maxOutputTokens,
        ...(temperature !== undefined && !isGemini3(model) ? { temperature } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...thinkingConfig(model, effort),
        ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map(toDeclaration) }] } : {}),
        ...(request.signal ? { abortSignal: request.signal } : {}),
      },
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const stream = await this.client.models.generateContentStream(this.buildParams(request));

      const parts: Part[] = [];
      const toolCalls: ToolCall[] = [];
      let text = "";
      let finish: string | undefined;
      let finishMessage: string | undefined;
      let blocked = false;
      let usage: GenerateContentResponseUsageMetadata | undefined;
      let model = this.model;

      for await (const chunk of stream) {
        if (chunk.modelVersion) model = chunk.modelVersion;
        if (chunk.promptFeedback?.blockReason) blocked = true;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finish = candidate.finishReason;
        if (candidate?.finishMessage) finishMessage = candidate.finishMessage;
        for (const part of candidate?.content?.parts ?? []) {
          addPart(parts, part);
          if (part.text && !part.thought) {
            text += part.text;
            request.onText?.(part.text);
          }
          if (part.functionCall) {
            const fc = part.functionCall;
            toolCalls.push({ id: fc.id ?? `${LOCAL_ID_PREFIX}${toolCalls.length}`, name: fc.name ?? "", input: fc.args ?? {} });
          }
        }
      }

      // A tool call Gemini could not turn into valid arguments: the reply has no usable call.
      if (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") {
        throw new ModelError("invalid_tool_call", finishMessage ?? finish);
      }

      return {
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length ? { toolCalls } : {}),
          // Keep the parts with their thought signatures: Gemini needs them back
          // unchanged to continue its reasoning across turns.
          native: { provider: "gemini", model: this.model, data: parts },
        },
        usage: toUsage(usage),
        // Gemini finishes tool-call replies with STOP; report them as tool use.
        stopReason: blocked ? "refusal" : toolCalls.length && finish === "STOP" ? "tool_use" : toStopReason(finish),
        model,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      throw toModelError(err);
    }
  }
}

/** Streaming splits text into many parts; merge plain text, keep anything carrying a signature or thought as-is. */
function addPart(parts: Part[], part: Part): void {
  const last = parts[parts.length - 1];
  const plain = (p: Part) => p.text !== undefined && !p.thought && !p.thoughtSignature && Object.keys(p).length === 1;
  if (last && plain(last) && plain(part)) {
    last.text = (last.text ?? "") + part.text;
  } else {
    parts.push({ ...part });
  }
}

function toDeclaration(t: ToolSpec): FunctionDeclaration {
  return { name: t.name, description: t.description, parametersJsonSchema: t.inputSchema };
}

const providerId = (id: string) => (id.startsWith(LOCAL_ID_PREFIX) ? {} : { id });

function toContent(m: Message): Content {
  if (m.role === "user") return { role: "user", parts: [{ text: m.content }] };
  if (m.role === "tool") {
    return {
      role: "user",
      parts: m.results.map((r) => ({
        functionResponse: {
          ...providerId(r.callId),
          name: r.name,
          response: r.isError ? { error: r.content } : { output: r.content },
        },
      })),
    };
  }
  // Gemini's own parts carry thought signatures that must come back unchanged.
  if (m.native?.provider === "gemini") return { role: "model", parts: m.native.data as Part[] };
  const calls: Part[] = (m.toolCalls ?? []).map((c) => ({
    functionCall: { ...providerId(c.id), name: c.name, args: (c.input ?? {}) as Record<string, unknown> },
  }));
  // Gemini rejects a turn with no parts, so plain replies always keep their text part.
  return { role: "model", parts: m.content || !calls.length ? [{ text: m.content }, ...calls] : calls };
}

function toUsage(u: GenerateContentResponseUsageMetadata | undefined): Usage {
  const cached = u?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (u?.promptTokenCount ?? 0) - cached),
    // Thinking tokens are billed as output.
    outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0, // implicit caching has no write charge
  };
}

function toStopReason(r: string | undefined): StopReason {
  switch (r) {
    case "STOP":
      return "end";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "refusal";
    default:
      return "other";
  }
}

/**
 * Gemini error messages can be JSON with another JSON document inside its
 * `message`. Dig out the innermost human-readable message.
 */
export function readableGeminiMessage(raw: string): string {
  let text = raw;
  for (let depth = 0; depth < 4; depth++) {
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      const inner = parsed?.error?.message;
      if (typeof inner !== "string") break;
      text = inner;
    } catch {
      break;
    }
  }
  return text;
}

export function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  const opts = { cause: err };
  if (err instanceof ApiError) {
    const s = err.status;
    const detail = readableGeminiMessage(err.message);
    if (isTooLarge(s, detail)) return new ModelError("too_large", detail, s, opts);
    // An invalid key is a 400 with this reason code, not a 401.
    if (s === 401 || s === 403 || err.message.includes("API_KEY_INVALID")) return new ModelError("auth", detail, s, opts);
    if (s === 404) return new ModelError("not_found", detail, s, opts);
    if (s === 429) return new ModelError("rate_limit", detail, s, opts);
    if (s === 400) return new ModelError("bad_request", detail, s, opts);
    if (s >= 500) return new ModelError("server", detail, s, opts);
    return new ModelError("unknown", detail, s, opts);
  }
  if (err instanceof Error && err.name === "AbortError") return new ModelError("aborted", "", undefined, opts);
  if (err instanceof Error && err.name === "TimeoutError") return new ModelError("timeout", "", undefined, opts);
  if (err instanceof TypeError) return new ModelError("network", err.message, undefined, opts); // fetch failed
  return new ModelError("unknown", err instanceof Error ? err.message : String(err), undefined, opts);
}
