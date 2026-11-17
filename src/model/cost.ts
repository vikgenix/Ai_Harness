import { emptyUsage, type Usage } from "./types.js";

/** USD per 1 million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PriceTable = Record<string, Price>;

/**
 * Finds the price for a model. Exact name first, then the longest listed name
 * the model starts with, so "gpt-5" also prices "gpt-5-2025-08-07" while
 * "gpt-5-mini" still gets its own entry.
 */
export function findPrice(table: PriceTable, model: string): Price | undefined {
  if (table[model]) return table[model];
  let best: string | undefined;
  for (const name of Object.keys(table)) {
    if (model.startsWith(name) && (!best || name.length > best.length)) best = name;
  }
  return best ? table[best] : undefined;
}

export function costOf(u: Usage, p: Price): number {
  return (
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

/** Adds up tokens and cost across requests (a task or a whole session). */
export class UsageTracker {
  readonly usage: Usage = emptyUsage();
  requests = 0;
  /** Cost of the requests whose model had a price. */
  pricedCostUsd = 0;
  /** Models that ran without a known price (their cost is not counted). */
  readonly unpricedModels = new Set<string>();

  constructor(private readonly prices: PriceTable) {}

  /** Records one response and returns its cost, or undefined if the model has no price. */
  add(usage: Usage, model: string): number | undefined {
    this.requests++;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.cacheReadTokens += usage.cacheReadTokens;
    this.usage.cacheWriteTokens += usage.cacheWriteTokens;

    const price = findPrice(this.prices, model);
    if (!price) {
      this.unpricedModels.add(model);
      return undefined;
    }
    const cost = costOf(usage, price);
    this.pricedCostUsd += cost;
    return cost;
  }

  /** True once the known cost reaches the limit. */
  overBudget(limitUsd: number): boolean {
    return this.pricedCostUsd >= limitUsd;
  }

  reset(): void {
    Object.assign(this.usage, emptyUsage());
    this.requests = 0;
    this.pricedCostUsd = 0;
    this.unpricedModels.clear();
  }
}

const n = (x: number) => x.toLocaleString("en-US");

/** e.g. "1,200 in · 80 out · 9,000 cached · $0.0042" */
export function formatUsage(u: Usage, costUsd: number | undefined): string {
  const parts = [`${n(u.inputTokens)} in`, `${n(u.outputTokens)} out`];
  if (u.cacheReadTokens) parts.push(`${n(u.cacheReadTokens)} cached`);
  if (u.cacheWriteTokens) parts.push(`${n(u.cacheWriteTokens)} cache-write`);
  parts.push(costUsd === undefined ? "cost unknown" : `$${costUsd.toFixed(4)}`);
  return parts.join(" · ");
}
