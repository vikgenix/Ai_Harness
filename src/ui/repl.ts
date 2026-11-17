import { statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { runAgent, type AgentResult } from "../agent/loop.js";
import { agentSystemPrompt } from "../agent/prompt.js";
import { describeConfig, type HarnessConfig } from "../config.js";
import { formatUsage, type UsageTracker } from "../model/cost.js";
import type { Message, ModelClient, ToolCall } from "../model/index.js";
import { createDefaultTools, type ToolRegistry } from "../tools/index.js";

const HELP = `Type a request about the code in the working directory, or a command:
  /repo <dir|url>    work in a local directory, or set the GitHub repository
  /fix <n|url|text>  fix an issue number, issue URL or described bug
  /cost              tokens and cost so far this session
  /clear             start a new conversation
  /config            show the active model configuration
  /help              show this help
  /exit              quit
Ctrl-C cancels a reply in progress.`;

export interface ReplOptions {
  config: HarnessConfig;
  model: ModelClient;
  tracker: UsageTracker;
  /** GitHub URL or local directory. */
  initialRepo?: string;
  /** Directory the tools work in when no local repository is given (default: current directory). */
  workdir?: string;
  tools?: ToolRegistry;
  input?: Readable;
  output?: Writable & { isTTY?: boolean };
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** e.g. view_file(path=src/index.ts, start_line=10) */
export function describeCall(call: ToolCall): string {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const args = Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  const text = `${call.name}(${call.rawInput !== undefined ? "<invalid JSON>" : args})`.replace(/\s+/g, " ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

const STATUS_NOTES: Partial<Record<AgentResult["status"], string>> = {
  max_tokens: "(reply cut off at max_output_tokens)",
  refusal: "(the model declined to answer)",
  cancelled: "(cancelled)",
};

/**
 * Interactive session. Replaced by the full TUI in Phase 6; the /fix
 * workflow arrives in Phase 3.
 */
export async function startRepl(opts: ReplOptions): Promise<void> {
  const { config, model, tracker } = opts;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const tty = Boolean(output.isTTY);
  const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const print = (s = "") => output.write(`${s}\n`);

  const rl = createInterface({ input, output, terminal: tty && Boolean((input as { isTTY?: boolean }).isTTY) });
  const tools = opts.tools ?? createDefaultTools();
  let repo = opts.initialRepo;
  let workdir = path.resolve(repo && isDirectory(repo) ? repo : (opts.workdir ?? process.cwd()));
  let history: Message[] = [];
  let inFlight: AbortController | undefined;

  // With piped input, stdin can end while a reply is still streaming;
  // re-drawing the prompt after that would throw.
  let closed = false;
  rl.on("close", () => (closed = true));
  const prompt = () => {
    if (!closed) rl.prompt();
  };

  // Ctrl-C: cancel the reply in progress, or quit when idle.
  rl.on("SIGINT", () => {
    if (inFlight) inFlight.abort();
    else rl.close();
  });

  async function send(text: string): Promise<void> {
    inFlight = new AbortController();
    const started = Date.now();
    // Tool lines must start on a fresh line even if streamed text didn't end with one.
    let atLineStart = true;
    const write = (s: string) => {
      if (!s) return;
      output.write(s);
      atLineStart = s.endsWith("\n");
    };
    const line = (s: string) => {
      if (!atLineStart) output.write("\n");
      print(s);
      atLineStart = true;
    };

    output.write("\n");
    try {
      const result = await runAgent({
        model,
        tools,
        system: agentSystemPrompt(workdir),
        root: workdir,
        tracker,
        limits: config.limits,
        history,
        task: text,
        signal: inFlight.signal,
        events: {
          onText: write,
          onToolCall: (call) => line(dim(`  → ${describeCall(call)}`)),
          onToolResult: (r) => {
            if (r.isError) line(dim(`    ✗ ${r.content.split("\n")[0]}`));
          },
        },
      });

      // A run that failed before any reply leaves no trace, so the next message starts clean.
      if (!(result.steps === 0 && (result.status === "error" || result.status === "cancelled"))) history = result.messages;

      if (!atLineStart) output.write("\n");
      if (result.status === "error" && result.error) print(`Model error: ${result.error.message}`);
      if (result.status === "max_steps") print(`(stopped: reached limits.max_steps = ${config.limits.maxSteps})`);
      if (result.status === "budget") print(`(stopped: reached the $${config.limits.maxCostUsd.toFixed(2)} cost limit per task)`);
      const note = STATUS_NOTES[result.status];
      if (note) print(note);
      if (result.steps > 0) {
        const steps = result.steps === 1 ? "1 step" : `${result.steps} steps`;
        const cost = result.costIncomplete ? undefined : result.costUsd;
        print(dim(`[${model.model} · ${steps} · ${((Date.now() - started) / 1000).toFixed(1)}s · ${formatUsage(result.usage, cost)}]`));
      }
    } finally {
      inFlight = undefined;
    }
  }

  print(HELP);
  print(`\nWorking directory: ${workdir}`);
  if (repo && !isDirectory(repo)) print(`Repository: ${repo}`);

  // Async iteration (not rl.question) so lines piped in before the prompt
  // appears are queued instead of dropped. The loop ends on EOF / Ctrl-D.
  rl.setPrompt("\nharness › ");
  prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }

      if (!line.startsWith("/")) {
        await send(line);
        prompt();
        continue;
      }

      const [cmd = "", ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");

      switch (cmd) {
        case "/exit":
        case "/quit":
          return;
        case "/help":
          print(HELP);
          break;
        case "/config":
          print(describeConfig(config));
          break;
        case "/cost": {
          const unknown = tracker.unpricedModels.size ? ` (no price for: ${[...tracker.unpricedModels].join(", ")})` : "";
          print(`${tracker.requests} requests · ${formatUsage(tracker.usage, tracker.pricedCostUsd)}${unknown}`);
          break;
        }
        case "/clear":
          history = [];
          print("Started a new conversation.");
          break;
        case "/repo":
          if (!arg) {
            print(`Working directory: ${workdir}${repo && !isDirectory(repo) ? `\nRepository: ${repo}` : ""}`);
          } else if (isDirectory(arg)) {
            repo = arg;
            workdir = path.resolve(arg);
            history = []; // earlier tool results refer to the old directory
            print(`Working directory: ${workdir} (new conversation)`);
          } else {
            repo = arg;
            print(`Repository set: ${repo}`);
          }
          break;
        case "/fix":
          if (!repo) print("Set a repository first: /repo <github url>");
          else if (!arg) print("Usage: /fix <issue number | issue url | description>");
          else print(`Not implemented yet: the agent that fixes "${arg}" arrives in Phase 3.`);
          break;
        default:
          print(`Unknown command '${cmd}'. Type /help.`);
      }
      prompt();
    }
  } finally {
    rl.close();
  }
}
