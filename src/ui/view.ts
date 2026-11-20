import type { ToolCall, ToolResult } from "../model/types.js";

/**
 * What the interactive session reports beyond the text it prints, for a
 * screen that shows it in panels (the TUI). The plain line mode has no view
 * and prints everything instead.
 */
export type StageState = "running" | "done" | "failed" | "skipped";

export interface UsageInfo {
  /** Model requests in the current run, and the limit. */
  steps: number;
  maxSteps: number;
  /** Cost of the current run (undefined if the model has no price), and the limit. */
  runCostUsd?: number;
  maxCostUsd: number;
  /** Session totals. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  sessionCostUsd: number;
}

export interface SessionView {
  /** Where the tools work; with a branch and its base commit while a fix is under way (for the diff). */
  context(info: { workdir: string; branch?: string; base?: string; sandbox?: string }): void;
  /** What the session works on: a fix's issue or task, an audit, or the chat. Starts a new list of stages. */
  task(info: { kind: "fix" | "audit" | "chat"; title: string; detail?: string }): void;
  /** One step of a fix or an audit (branch, dependencies, baseline, agent, commit...). */
  stage(name: string, state: StageState, detail?: string): void;
  /** Work started (true) or ended (false); calls nest. */
  busy(on: boolean): void;
  toolStarted(call: ToolCall): void;
  toolFinished(result: ToolResult, ms: number): void;
  /** After each model reply. */
  usage(info: UsageInfo): void;
  /** A question the next input line answers. */
  question(text: string): void;
  /** Ctrl-C: the session gives the handler that cancels the work in progress, or quits when idle. */
  onInterrupt(handler: () => void): void;
}
