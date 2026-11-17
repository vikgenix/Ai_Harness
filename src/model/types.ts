import type { Provider } from "../providers.js";

/**
 * Provider-neutral conversation types. The agent works only with these; each
 * adapter translates them to and from its provider's API.
 */

export interface UserMessage {
  role: "user";
  content: string;
}

/** JSON Schema subset used to describe tool inputs (understood by every provider). */
export interface JsonSchemaProperty {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  minimum?: number;
  items?: JsonSchemaProperty;
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: false;
}

/** A tool the model may call. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/** A tool call requested by the model. */
export interface ToolCall {
  /** Provider-assigned id, echoed back in the matching ToolResult. */
  id: string;
  name: string;
  /** Parsed arguments. Not validated: the tool registry checks them against the schema. */
  input: unknown;
  /** Set when the arguments were not valid JSON; holds the raw text. */
  rawInput?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

export interface AssistantMessage {
  role: "assistant";
  /** The visible text of the reply. */
  content: string;
  /** Tools the model asked to run, in order. */
  toolCalls?: ToolCall[];
  /**
   * The provider's raw reply, kept so it can be sent back unchanged on the next
   * request. Some providers require this: Claude's thinking blocks and Gemini's
   * thought signatures are rejected or lost if rebuilt from text. An adapter
   * uses it only when `provider` (and `model`) match its own.
   */
  native?: { provider: Provider; model: string; data: unknown };
}

/** Results of the tool calls in the preceding assistant message, one per call. */
export interface ToolResultsMessage {
  role: "tool";
  results: ToolResult[];
}

export type Message = UserMessage | AssistantMessage | ToolResultsMessage;

export interface ChatRequest {
  /** Instructions that stay the same across the conversation (cached). */
  system: string;
  messages: Message[];
  /** Tools the model may call (also part of the cached prefix: keep them stable). */
  tools?: ToolSpec[];
  /** Called with each piece of text as it streams in. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

/** Token counts, normalised: inputTokens never includes cached tokens. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason =
  | "end" // finished normally
  | "max_tokens" // hit the output limit
  | "refusal" // declined by a safety filter
  | "tool_use" // wants to call a tool
  | "other";

export interface ChatResponse {
  message: AssistantMessage;
  usage: Usage;
  stopReason: StopReason;
  /** The model that actually answered (can differ after a fallback). */
  model: string;
  durationMs: number;
}

export interface ModelClient {
  readonly provider: Provider;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
