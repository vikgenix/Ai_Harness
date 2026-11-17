import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { describeConfig, type HarnessConfig } from "../config.js";
import { formatUsage, type UsageTracker } from "../model/cost.js";
import { ModelError, type Message, type ModelClient } from "../model/index.js";

const HELP = `Type a message to chat with the model, or a command:
  /repo <url>        set the GitHub repository to work on
  /fix <n|url|text>  fix an issue number, issue URL or described bug
  /cost              tokens and cost so far this session
  /clear             start a new conversation
  /config            show the active model configuration
  /help              show this help
  /exit              quit
Ctrl-C cancels a reply in progress.`;

/** Kept identical across requests so providers can cache it. */
const CHAT_SYSTEM =
  "You are AI Harness, a coding assistant running in a terminal. Answer concisely. " +
  "You cannot read or change files or run commands yet.";

export interface ReplOptions {
  config: HarnessConfig;
  model: ModelClient;
  tracker: UsageTracker;
  initialRepo?: string;
  input?: Readable;
  output?: Writable & { isTTY?: boolean };
}

/**
 * Interactive session. Replaced by the full TUI in Phase 6; the agent behind
 * /fix arrives in Phase 3.
 */
export async function startRepl(opts: ReplOptions): Promise<void> {
  const { config, model, tracker } = opts;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const tty = Boolean(output.isTTY);
  const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
  const print = (s = "") => output.write(`${s}\n`);

  const rl = createInterface({ input, output, terminal: tty && Boolean((input as { isTTY?: boolean }).isTTY) });
  let repo = opts.initialRepo;
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
    const pending: Message[] = [...history, { role: "user", content: text }];
    inFlight = new AbortController();
    output.write("\n");
    try {
      const res = await model.chat({
        system: CHAT_SYSTEM,
        messages: pending,
        signal: inFlight.signal,
        onText: (d) => output.write(d),
      });
      history = [...pending, res.message];
      const cost = tracker.add(res.usage, res.model);
      print();
      if (res.stopReason === "max_tokens") print("(reply cut off at max_output_tokens)");
      if (res.stopReason === "refusal") print("(the model declined to answer)");
      print(dim(`[${res.model} · ${(res.durationMs / 1000).toFixed(1)}s · ${formatUsage(res.usage, cost)}]`));
    } catch (err) {
      // The failed turn is not added to history, so the next message starts clean.
      print();
      if (err instanceof ModelError && err.kind === "aborted") print("(cancelled)");
      else if (err instanceof ModelError) print(`Model error: ${err.message}`);
      else throw err;
    } finally {
      inFlight = undefined;
    }
  }

  print(HELP);
  if (repo) print(`\nRepository: ${repo}`);

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
            print(repo ? `Repository: ${repo}` : "Usage: /repo <github url>");
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
