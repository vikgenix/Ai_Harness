import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentParameters, type GenerateContentResponseUsageMetadata, type Part } from "@google/genai";
import type { Effort, HarnessConfig } from "../config.js";
import { ModelError } from "./errors.js";
import type { ChatRequest, ChatResponse, Message, ModelClient, StopReason, Usage } from "./types.js";

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
        maxOutputTokens,
        ...(temperature !== undefined && !isGemini3(model) ? { temperature } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...thinkingConfig(model, effort),
        ...(request.signal ? { abortSignal: request.signal } : {}),
      },
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    try {
      const stream = await this.client.models.generateContentStream(this.buildParams(request));

      const parts: Part[] = [];
      let text = "";
      let finish: string | undefined;
      let blocked = false;
      let usage: GenerateContentResponseUsageMetadata | undefined;
      let model = this.model;

      for await (const chunk of stream) {
        if (chunk.modelVersion) model = chunk.modelVersion;
        if (chunk.promptFeedback?.blockReason) blocked = true;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finish = candidate.finishReason;
        for (const part of candidate?.content?.parts ?? []) {
          addPart(parts, part);
          if (part.text && !part.thought) {
            text += part.text;
            request.onText?.(part.text);
          }
        }
      }

      return {
        message: {
          role: "assistant",
          content: text,
          // Keep the parts with their thought signatures: Gemini needs them back
          // unchanged to continue its reasoning across turns.
          native: { provider: "gemini", model: this.model, data: parts },
        },
        usage: toUsage(usage),
        stopReason: blocked ? "refusal" : toStopReason(finish),
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

function toContent(m: Message): Content {
  if (m.role === "user") return { role: "user", parts: [{ text: m.content }] };
  if (m.native?.provider === "gemini") return { role: "model", parts: m.native.data as Part[] };
  return { role: "model", parts: [{ text: m.content }] };
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

export function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err;
  const opts = { cause: err };
  if (err instanceof ApiError) {
    const s = err.status;
    // An invalid key is a 400 with this reason code, not a 401.
    if (s === 401 || s === 403 || err.message.includes("API_KEY_INVALID")) return new ModelError("auth", err.message, s, opts);
    if (s === 404) return new ModelError("not_found", err.message, s, opts);
    if (s === 429) return new ModelError("rate_limit", err.message, s, opts);
    if (s === 400) return new ModelError("bad_request", err.message, s, opts);
    if (s >= 500) return new ModelError("server", err.message, s, opts);
    return new ModelError("unknown", err.message, s, opts);
  }
  if (err instanceof Error && err.name === "AbortError") return new ModelError("aborted", "", undefined, opts);
  if (err instanceof Error && err.name === "TimeoutError") return new ModelError("timeout", "", undefined, opts);
  if (err instanceof TypeError) return new ModelError("network", err.message, undefined, opts); // fetch failed
  return new ModelError("unknown", err instanceof Error ? err.message : String(err), undefined, opts);
}
