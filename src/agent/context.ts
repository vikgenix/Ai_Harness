import type { Message, ToolSpec } from "../model/types.js";

/**
 * Keeping requests under a provider's size limit. Every step sends the whole
 * conversation, so it grows with each tool output; a small limit (Groq's
 * free tier allows about 8,000 tokens per minute) is reached after a few
 * steps. When that happens the conversation is shortened, oldest bulk first:
 *
 *   1. outputs of older tool calls (the model has already acted on them),
 *   2. large inputs of older tool calls (file contents written earlier),
 *   3. the repository map in the first message,
 *   4. outputs of the latest tool calls, down to their first and last lines.
 *
 * The last few turns stay whole, so the model still sees what it just did.
 * Sizes are estimated at about 4 characters per token, calibrated with the
 * provider's own count when its error message gives one.
 */

export const CHARS_PER_TOKEN = 4;
/** Turns at the end that keep their tool outputs whole (unless nothing else is left to cut). */
const KEEP_RECENT_TURNS = 2;
/** What an older tool output becomes. */
const STUB_CHARS = 160;
/** Tool call inputs shorter than this are kept. */
const BIG_INPUT_CHARS = 400;
/** What the latest outputs are cut down to, as a last resort. */
const TAIL_CHARS = 1200;

export const REMOVED_NOTE = "[shortened by Shrike to fit the model's request limit; run the tool again if you need this output]";

/** Characters a request sends: system prompt, tool definitions and messages. */
export function requestChars(system: string, tools: ToolSpec[], messages: Message[]): number {
  return system.length + JSON.stringify(tools).length + messages.reduce((n, m) => n + messageChars(m), 0);
}

function messageChars(m: Message): number {
  if (m.role === "user") return m.content.length;
  if (m.role === "tool") return m.results.reduce((n, r) => n + r.content.length + r.name.length + 20, 0);
  return m.content.length + (m.toolCalls ?? []).reduce((n, c) => n + c.name.length + JSON.stringify(c.input ?? "").length, 0);
}

export interface ShrinkResult {
  /** Characters the messages had before and have now. */
  before: number;
  after: number;
  /** What was shortened, for one line in the terminal. */
  outputs: number;
  inputs: number;
  repoMap: boolean;
}

/**
 * Shortens `messages` in place until they take at most `targetChars`.
 * Returns what was done; `after` > target means it could not get there.
 */
export function shrinkMessages(messages: Message[], targetChars: number): ShrinkResult {
  const total = () => messages.reduce((n, m) => n + messageChars(m), 0);
  const result: ShrinkResult = { before: total(), after: 0, outputs: 0, inputs: 0, repoMap: false };
  let size = result.before;
  const done = () => size <= targetChars;

  // The turns at the end that stay whole: from the last KEEP_RECENT_TURNS assistant messages on.
  let recentFrom = messages.length;
  for (let seen = 0, i = messages.length - 1; i >= 0 && seen < KEEP_RECENT_TURNS; i--) {
    if (messages[i]!.role === "assistant") {
      seen++;
      recentFrom = i;
    }
  }

  // 1. Older tool outputs, oldest first.
  for (let i = 0; i < recentFrom && !done(); i++) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    m.results = m.results.map((r) => {
      if (done() || r.content.length <= STUB_CHARS + REMOVED_NOTE.length || r.content.endsWith(REMOVED_NOTE)) return r;
      const content = `${r.content.slice(0, STUB_CHARS).trimEnd()}\n${REMOVED_NOTE}`;
      size -= r.content.length - content.length;
      result.outputs++;
      return { ...r, content };
    });
  }

  // 2. Large inputs of older tool calls (create_file contents, long edits).
  for (let i = 0; i < recentFrom && !done(); i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    let shortened = false;
    m.toolCalls = m.toolCalls.map((c) => {
      if (done() || !c.input || typeof c.input !== "object") return c;
      const input: Record<string, unknown> = { ...(c.input as Record<string, unknown>) };
      let changed = false;
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === "string" && v.length > BIG_INPUT_CHARS) {
          input[k] = `${v.slice(0, 80)}… [${v.length} characters, shortened by Shrike]`;
          size -= v.length - (input[k] as string).length;
          changed = true;
        }
      }
      if (!changed) return c;
      result.inputs++;
      shortened = true;
      return { ...c, input };
    });
    // Adapters send the provider's raw copy of a reply when there is one; it would bring the old size back.
    if (shortened) delete m.native;
  }

  // 3. The repository map in the first message.
  const first = messages[0];
  if (!done() && first?.role === "user") {
    const shorter = first.content.replace(/<repo_map>[^]*?<\/repo_map>\n(The map above[^\n]*\n)?/, "<repo_map>\n(Left out to fit the model's request limit: use find_files, list_dir and grep to find the code.)\n</repo_map>\n");
    if (shorter !== first.content) {
      size -= first.content.length - shorter.length;
      first.content = shorter;
      result.repoMap = true;
    }
  }

  // 4. Last resort: the latest tool outputs, down to their start and end.
  for (let i = recentFrom; i < messages.length && !done(); i++) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    m.results = m.results.map((r) => {
      if (done() || r.content.length <= TAIL_CHARS * 2) return r;
      const content = `${r.content.slice(0, TAIL_CHARS)}\n[... ${r.content.length - TAIL_CHARS * 2} characters cut by Shrike to fit the request limit ...]\n${r.content.slice(-TAIL_CHARS)}`;
      size -= r.content.length - content.length;
      result.outputs++;
      return { ...r, content };
    });
  }

  result.after = total();
  return result;
}

/** One line for the terminal. */
export function describeShrink(r: ShrinkResult, limitTokens: number): string {
  const parts = [
    r.outputs && `${r.outputs} tool ${r.outputs === 1 ? "output" : "outputs"}`,
    r.inputs && `${r.inputs} tool ${r.inputs === 1 ? "input" : "inputs"}`,
    r.repoMap && "the repository map",
  ].filter(Boolean);
  const kb = (n: number) => `${Math.round(n / 1000)}k`;
  return `Shortened the conversation to fit the model's limit of ${limitTokens.toLocaleString("en-US")} tokens: ${parts.join(", ") || "nothing left to cut"} (${kb(r.before)} → ${kb(r.after)} characters).`;
}
