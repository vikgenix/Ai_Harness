import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { UsageTracker, costOf, findPrice, formatUsage, type PriceTable } from "../../src/model/cost.js";

const table: PriceTable = {
  "gpt-5": { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

describe("findPrice", () => {
  it("matches exact names, dated versions, and prefers the longest match", () => {
    expect(findPrice(table, "claude-opus-5-5")?.input).toBe(4);
    expect(findPrice(table, "gpt-5-2025-08-07")?.input).toBe(1);
    expect(findPrice(table, "gpt-5-mini-2025-08-07")?.input).toBe(0.25);
    expect(findPrice(table, "llama-4")).toBeUndefined();
  });
});

describe("costOf", () => {
  it("prices each token type separately", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 200_000 };
    // 4 + 2 + 0.4 + 1
    expect(costOf(u, table["claude-opus-5-5"]!)).toBeCloseTo(7.4, 6);
  });
});

describe("UsageTracker", () => {
  it("adds up usage and cost, and remembers unpriced models", () => {
    const t = new UsageTracker(table);
    const u = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(t.add(u, "gpt-5")).toBeCloseTo(0.002, 9);
    expect(t.add(u, "mystery-model")).toBeUndefined();
    expect(t.requests).toBe(2);
    expect(t.usage.inputTokens).toBe(2000);
    expect(t.pricedCostUsd).toBeCloseTo(0.002, 9);
    expect([...t.unpricedModels]).toEqual(["mystery-model"]);
    expect(t.overBudget(0.001)).toBe(true);
    expect(t.overBudget(1)).toBe(false);
    t.reset();
    expect(t.requests).toBe(0);
    expect(t.usage.inputTokens).toBe(0);
  });
});

describe("formatUsage", () => {
  it("shows only the token types that were used", () => {
    expect(formatUsage({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 9000, cacheWriteTokens: 0 }, 0.0042)).toBe(
      "1,200 in · 80 out · 9,000 cached · $0.0042",
    );
    expect(formatUsage({ inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, undefined)).toBe(
      "5 in · 1 out · cost unknown",
    );
  });
});

describe("pricing config", () => {
  it("loads the committed price table, defaulting cache prices to the input price", () => {
    const c = loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } });
    expect(c.pricing["claude-opus-5-5"]).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    expect(c.pricing["openai/gpt-oss-120b"]).toEqual({ input: 0.15, output: 0.75, cacheRead: 0.15, cacheWrite: 0.15 });
  });
});
