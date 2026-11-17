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
  unknown: "Unexpected error from the provider.",
};

const MAX_DETAIL = 300;

/** One line, at most MAX_DETAIL characters: provider messages can be long. */
function tidy(detail: string): string {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL ? `${oneLine.slice(0, MAX_DETAIL - 1)}…` : oneLine;
}

export class ModelError extends Error {
  override name = "ModelError";
  readonly detail: string;

  constructor(
    readonly kind: ModelErrorKind,
    detail: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    const clean = tidy(detail);
    super(`${HINTS[kind]}${clean ? ` (${clean})` : ""}`, options);
    this.detail = clean;
  }

  /** Errors worth retrying (the SDKs already retry these a few times). */
  get retryable(): boolean {
    return ["rate_limit", "server", "timeout", "network"].includes(this.kind);
  }
}
