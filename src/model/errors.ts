/**
 * One error type for every provider, so the rest of the harness can react to
 * "rate limited" or "bad key" without knowing which SDK threw it.
 */
export type ModelErrorKind =
  | "auth" // key missing, wrong or without permission
  | "not_found" // usually a wrong model name
  | "rate_limit"
  | "bad_request" // the request itself was rejected
  | "server" // provider error or overload
  | "timeout"
  | "network"
  | "aborted" // cancelled by the user
  | "invalid_output" // the model produced output that could not be parsed (e.g. broken tool JSON)
  | "invalid_tool_call" // the provider rejected a tool call that did not match the tool's parameters
  | "too_large" // the request is bigger than the model's context or the plan's per-request/per-minute token limit
  | "unknown";

const HINTS: Record<ModelErrorKind, string> = {
  auth: "Check that AI_API_KEY is valid for this provider.",
  not_found: "Check the model name in config/model.yaml or AI_MODEL.",
  rate_limit: "The provider is rate-limiting this key. Wait a moment and retry.",
  bad_request: "The provider rejected the request.",
  server: "The provider had an error or is overloaded. Retry shortly.",
  timeout: "The request timed out. Raise limits.request_timeout_s if this repeats.",
  network: "Could not reach the provider. Check the network or base_url.",
  aborted: "The request was cancelled.",
  invalid_output: "The model's reply could not be parsed. Retrying usually helps.",
  invalid_tool_call: "The model kept calling a tool with input that does not match its parameters.",
  too_large:
    "The request is larger than this model or plan allows, even after shortening the conversation. Use a model or plan with higher limits (Groq's free tier allows about 8,000 tokens per minute), or lower repo_map_tokens.",
  unknown: "Unexpected error from the provider.",
};

const MAX_DETAIL = 300;

/** Messages providers use when a request is too big for the model's context or the plan's token limit. */
const TOO_LARGE =
  /request too large|request entity too large|request_too_large|context_length_exceeded|maximum context length|prompt is too long|input is too long|too many (input )?tokens|exceeds the (maximum|context)|input token count .* exceeds/i;

/** True if a provider error says the request is too large (HTTP 413, or a context or token-limit message). */
export function isTooLarge(status: number | undefined, detail: string): boolean {
  return status === 413 || TOO_LARGE.test(detail);
}

/** The limit and the requested size in tokens, when the provider's message gives them. */
export function tooLargeSizes(detail: string): { limit?: number; requested?: number } {
  const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, "")) : undefined);
  let m = /Limit ([\d,]+), Requested ([\d,]+)/i.exec(detail); // Groq
  if (m) return { limit: num(m[1]), requested: num(m[2]) };
  m = /maximum context length is ([\d,]+) tokens[^]*?(?:resulted in|requested|have) ([\d,]+)/i.exec(detail); // OpenAI and compatible
  if (m) return { limit: num(m[1]), requested: num(m[2]) };
  m = /prompt is too long: ([\d,]+) tokens > ([\d,]+)/i.exec(detail); // Anthropic
  if (m) return { limit: num(m[2]), requested: num(m[1]) };
  m = /input token count \(?([\d,]+)\)? exceeds the maximum number of tokens allowed \(?([\d,]+)/i.exec(detail); // Gemini
  if (m) return { limit: num(m[2]), requested: num(m[1]) };
  return {};
}

/** One line, at most MAX_DETAIL characters: provider messages can be long. */
function tidy(detail: string): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL - 1)}…` : oneLine;
}

export class ModelError extends Error {
  override name = "ModelError";
  readonly detail: string;
  /** For too_large: the limit and the requested size in tokens, when the provider says. */
  readonly sizes: { limit?: number; requested?: number };

  constructor(
    readonly kind: ModelErrorKind,
    detail: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    const clean = tidy(detail);
    super(`${HINTS[kind]}${clean ? ` (${clean})` : ""}`, options);
    this.detail = clean;
    this.sizes = kind === "too_large" ? tooLargeSizes(detail) : {}; // from the full message, before it is shortened
  }

  /** Errors worth retrying (the SDKs already retry these a few times). */
  get retryable(): boolean {
    return ["rate_limit", "server", "timeout", "network"].includes(this.kind);
  }
}
