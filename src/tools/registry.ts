import type { ToolCall, ToolResult, ToolSpec } from "../model/types.js";
import { ToolError, type Tool, type ToolContext } from "./types.js";
import { validateInput } from "./validate.js";

/** Upper bound on any tool output sent to the model (tools should stay well below it). */
export const MAX_TOOL_OUTPUT_CHARS = 50_000;

/** Holds the available tools and runs the model's tool calls safely. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool<never>[]) {
    for (const t of tools) {
      if (this.tools.has(t.spec.name)) throw new Error(`duplicate tool name: ${t.spec.name}`);
      this.tools.set(t.spec.name, t as unknown as Tool);
    }
  }

  /** Specs in a fixed order, so the request prefix stays cacheable. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  /**
   * Runs one call. Never throws: every problem becomes an error result the
   * model can read and react to.
   */
  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const fail = (message: string): ToolResult => ({ callId: call.id, name: call.name, content: `Error: ${message}`, isError: true });

    const tool = this.tools.get(call.name);
    if (!tool) return fail(`unknown tool '${call.name}'. Available: ${[...this.tools.keys()].join(", ")}`);
    if (call.rawInput !== undefined) {
      // Wrapped with JSON.stringify so quotes in the broken input stay escaped.
      return fail(`the arguments were not valid JSON. Received: ${JSON.stringify({ INVALID_JSON: call.rawInput })}`);
    }
    const invalid = validateInput(tool.spec.inputSchema, call.input);
    if (invalid) return fail(`invalid input for ${call.name}: ${invalid}`);
    if (ctx.signal?.aborted) return fail("cancelled before running");

    try {
      const output = await tool.run(call.input as Record<string, unknown>, ctx);
      return { callId: call.id, name: call.name, content: capOutput(output), isError: false };
    } catch (err) {
      if (err instanceof ToolError) return fail(err.message);
      const code = (err as NodeJS.ErrnoException).code;
      return fail(`${call.name} failed: ${code ? `${code} ` : ""}${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function capOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const cut = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
  return `${cut}\n... [output truncated: ${text.length.toLocaleString("en-US")} characters, showing the first ${MAX_TOOL_OUTPUT_CHARS.toLocaleString("en-US")}]`;
}
