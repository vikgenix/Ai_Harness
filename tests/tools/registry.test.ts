import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/model/types.js";
import { MAX_TOOL_OUTPUT_CHARS, ToolRegistry } from "../../src/tools/registry.js";
import { ToolError, type Tool } from "../../src/tools/types.js";
import { validateInput } from "../../src/tools/validate.js";

const echo: Tool<{ text: string; times?: number }> = {
  spec: {
    name: "echo",
    description: "Repeats text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, times: { type: "integer", minimum: 1 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  async run({ text, times = 1 }) {
    if (text === "fail") throw new ToolError("asked to fail");
    if (text === "crash") throw Object.assign(new Error("disk on fire"), { code: "EIO" });
    return text.repeat(times);
  },
};

const registry = new ToolRegistry([echo]);
const ctx = { root: "/tmp" };
const call = (input: unknown, extra: Partial<ToolCall> = {}): ToolCall => ({ id: "c1", name: "echo", input, ...extra });

describe("ToolRegistry", () => {
  it("lists specs and runs a valid call", async () => {
    expect(registry.specs().map((s) => s.name)).toEqual(["echo"]);
    expect(await registry.run(call({ text: "ab", times: 2 }), ctx)).toEqual({ callId: "c1", name: "echo", content: "abab", isError: false });
  });

  it("turns every problem into an error result instead of throwing", async () => {
    const cases: [ToolCall, string][] = [
      [call({ text: "x" }, { name: "nope" }), "unknown tool 'nope'. Available: echo"],
      [call(undefined, { rawInput: '{"text": "a' }), 'not valid JSON. Received: {"INVALID_JSON":"{\\"text\\": \\"a"}'],
      [call({}), "missing required field 'text'"],
      [call({ text: 1 }), "'text' must be a string, got number"],
      [call({ text: "fail" }), "Error: asked to fail"],
      [call({ text: "crash" }), "echo failed: EIO disk on fire"],
    ];
    for (const [c, message] of cases) {
      const r = await registry.run(c, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toContain(message);
      expect(r.content.startsWith("Error: ")).toBe(true);
    }
  });

  it("does not start a tool once cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    expect((await registry.run(call({ text: "a" }), { ...ctx, signal: abort.signal })).content).toContain("cancelled");
  });

  it("caps huge output", async () => {
    const r = await registry.run(call({ text: "y", times: MAX_TOOL_OUTPUT_CHARS + 10 }), ctx);
    expect(r.content.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 200);
    expect(r.content).toContain("[output truncated");
  });

  it("rejects duplicate tool names", () => {
    expect(() => new ToolRegistry([echo, echo])).toThrow("duplicate tool name");
  });
});

describe("validateInput", () => {
  const schema = {
    type: "object" as const,
    properties: {
      n: { type: "integer" as const, minimum: 1 },
      mode: { type: "string" as const, enum: ["a", "b"] },
      tags: { type: "array" as const, items: { type: "string" as const } },
    },
    additionalProperties: false as const,
  };

  it.each([
    [[], "input must be a JSON object"],
    [{ n: 1.5 }, "'n' must be an integer"],
    [{ n: 0 }, "'n' must be at least 1"],
    [{ mode: "c" }, "'mode' must be one of: a, b"],
    [{ tags: ["x", 2] }, "'tags[1]' must be a string"],
    [{ other: 1 }, "unknown field 'other' (expected: n, mode, tags)"],
  ])("%j -> %s", (input, message) => {
    expect(validateInput(schema, input)).toContain(message);
  });

  it("accepts valid input, and null for optional fields", () => {
    expect(validateInput(schema, { n: 3, mode: "a", tags: [] })).toBeNull();
    expect(validateInput(schema, { n: null })).toBeNull();
  });
});
