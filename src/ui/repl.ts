import { statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { runAgent, type AgentResult } from "../agent/loop.js";
import { completeFix, FixError, startFix } from "../agent/fix.js";
import { createSelfReview, type SelfReview } from "../agent/review.js";
import { agentSystemPrompt, fixSystemPrompt } from "../agent/prompt.js";
import { describeTask, resolveTask, taskPrompt, taskText } from "../agent/task.js";
import { describeConfig, type HarnessConfig } from "../config.js";
import { GitHubError } from "../github/issues.js";
import { formatUsage, type UsageTracker } from "../model/cost.js";
import type { Message, ModelClient, ToolCall } from "../model/index.js";
import { CloneError, cloneRepo, parseRepoUrl } from "../repo/clone.js";
import { describeProject, projectBlock, projectFor } from "../repo/detect.js";
import { existingEnvironment } from "../repo/env.js";
import { describeRepoMap, repoMapFor } from "../repo/map.js";
import { envsDirOf, fixMessage, openSandbox, prepareWorkspace } from "../agent/workspace.js";
import { SandboxError, type DockerSandbox } from "../sandbox/docker.js";
import { createDefaultTools, type ToolRegistry } from "../tools/index.js";

const HELP = `Type a request about the code in the working directory, or a command:
  /repo <url|dir>    clone a repository (or open a local directory) to work in
  /fix <n|url|text>  fix an issue number, issue URL or described bug
  /map [words]       show the repository map (files most related to the words first)
  /project           show how the project is built and tested (detected from its files)
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
  /** Repository URL (cloned at start) or local directory. */
  initialRepo?: string;
  /** Directory the tools work in until a repository is opened (default: current directory). */
  workdir?: string;
  /** Where clones are kept (default: workspaces/ in the harness directory). */
  workspacesDir?: string;
  /** Where dependency environments are kept (default: envs/ in the harness directory). */
  envsDir?: string;
  /** Lets git clone private GitHub repositories and read their issues. */
  githubToken?: string;
  /** For tests: replaces the GitHub API's fetch. */
  fetchImpl?: typeof fetch;
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
  let repo: string | undefined;
  let workdir = path.resolve(opts.workdir ?? process.cwd());
  /** The Docker container for the working directory, when config.sandbox is "docker" (started on first use). */
  let sandbox: DockerSandbox | undefined;
  /** The installed dependencies of the working directory, active in the agent's commands. */
  let toolEnv = config.sandbox === "docker" ? undefined : existingEnvironment(workdir, opts.envsDir);
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

  /** Runs one slow step that Ctrl-C can cancel without leaving the session. */
  async function step<T>(fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    inFlight = new AbortController();
    try {
      return await fn(inFlight.signal);
    } finally {
      inFlight = undefined;
    }
  }

  /** Starts the sandbox for the working directory if it is wanted and not running. False if it cannot start. */
  async function ensureSandbox(): Promise<boolean> {
    if (config.sandbox !== "docker" || sandbox) return true;
    try {
      sandbox = await step((signal) => openSandbox(workdir, config, { envsDir: opts.envsDir, signal, print }));
      toolEnv = existingEnvironment(workdir, envsDirOf(sandbox, opts.envsDir));
      return true;
    } catch (err) {
      if (!(err instanceof SandboxError)) throw err;
      print(err.message);
      return false;
    }
  }

  /** Switches the tools to another directory: a new sandbox and environment for it. */
  async function setWorkdir(dir: string): Promise<void> {
    await sandbox?.close();
    sandbox = undefined;
    workdir = dir;
    toolEnv = config.sandbox === "docker" ? undefined : existingEnvironment(workdir, opts.envsDir);
    history = []; // earlier tool results refer to the old directory
  }

  /** Runs the agent on `text` and shows its progress. `mode` replaces the chat's system prompt and history (used by /fix). */
  async function send(text: string, mode: { system?: string; history?: Message[]; review?: SelfReview } = {}): Promise<AgentResult> {
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
        system: mode.system ?? agentSystemPrompt(workdir),
        root: workdir,
        env: toolEnv,
        sandbox,
        tracker,
        limits: config.limits,
        history: mode.history ?? history,
        task: text,
        signal: inFlight.signal,
        events: {
          onText: write,
          onToolCall: (call) => line(dim(`  → ${describeCall(call)}`)),
          onToolResult: (r) => {
            if (r.isError) line(dim(`    ✗ ${r.content.split("\n")[0]}`));
          },
          onRejectedToolCall: (detail) => line(dim(`    ✗ tool call rejected by the API, retrying: ${detail}`)),
        },
        beforeFinish: mode.review
          ? async (input) => {
              const r = await mode.review!.check(input);
              if (r) line(dim(`  ↻ ${r.note}`));
              return r?.message;
            }
          : undefined,
      });

      // A run that failed before any reply leaves no trace, so the next message starts clean.
      if (!(result.steps === 0 && (result.status === "error" || result.status === "cancelled"))) history = result.messages;

      if (!atLineStart) output.write("\n");
      if (result.finished) {
        const label = result.finished.outcome === "completed" ? "✓ Done" : "✗ Blocked";
        print(`\n${label}: ${result.finished.summary}`);
      }
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
      return result;
    } finally {
      inFlight = undefined;
    }
  }

  /** Switches to a local directory, or clones a repository URL and switches to the clone. */
  async function openRepo(target: string): Promise<void> {
    if (isDirectory(target)) {
      repo = target;
      await setWorkdir(path.resolve(target));
      print(`Working directory: ${workdir} (new conversation)`);
      return;
    }
    const spec = parseRepoUrl(target);
    if (!spec) {
      print(`'${target}' is not a directory or a repository URL (e.g. https://github.com/owner/repo or owner/repo).`);
      return;
    }
    inFlight = new AbortController();
    print(`Cloning ${spec.label}...`);
    try {
      const cloned = await cloneRepo(spec, { workspacesDir: opts.workspacesDir, githubToken: opts.githubToken, signal: inFlight.signal });
      repo = target;
      await setWorkdir(cloned.dir);
      print(cloned.reused ? "Using the existing clone (make clean removes it for a fresh copy)." : `Cloned in ${(cloned.durationMs / 1000).toFixed(1)}s.`);
      print(`Working directory: ${workdir} (new conversation)`);
    } catch (err) {
      if (!(err instanceof CloneError)) throw err;
      print(err.message);
    } finally {
      inFlight = undefined;
    }
  }

  /** /fix: turns the argument into a task (fetching the issue if it is one) and runs the agent on it. */
  async function fix(arg: string): Promise<void> {
    inFlight = new AbortController();
    let task;
    try {
      task = await resolveTask(arg, workdir, { token: opts.githubToken, signal: inFlight.signal, fetchImpl: opts.fetchImpl });
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      print(err.message);
      return;
    } finally {
      inFlight = undefined;
    }
    print(describeTask(task));

    if (!(await ensureSandbox())) return; // before the branch, so a missing Docker changes nothing

    let branch;
    try {
      branch = await startFix(workdir, task);
    } catch (err) {
      if (!(err instanceof FixError)) throw err;
      print(err.message);
      return;
    }
    print(`Working on branch ${branch.branch} (from ${branch.baseName}).`);
    // Ctrl-C during the install or the baseline skips that step; the fix goes on without it.
    const ws = await prepareWorkspace(workdir, { config, query: taskText(task), envsDir: opts.envsDir, print, step, sandbox });
    if (ws.env) toolEnv = ws.env;

    // A fix is its own conversation; afterwards the chat continues from it.
    const review = config.selfReview ? createSelfReview(workdir, branch) : undefined;
    const result = await send(fixMessage(taskPrompt(task), ws), { system: fixSystemPrompt(workdir), history: [], review });
    try {
      print((await completeFix(workdir, branch, task, result)).message);
    } catch (err) {
      if (!(err instanceof FixError)) throw err;
      print(`Could not commit the fix: ${err.message}`);
    }
  }

  // Async iteration (not rl.question) so lines typed or piped in before the
  // prompt appears are queued instead of dropped. Started before the initial
  // clone, which can take a while. The loop ends on EOF / Ctrl-D.
  const lines = rl[Symbol.asyncIterator]();

  print(HELP);
  print();
  if (opts.initialRepo) await openRepo(opts.initialRepo);
  else print(`Working directory: ${workdir}`);

  rl.setPrompt("\nharness › ");
  prompt();
  try {
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }

      if (!line.startsWith("/")) {
        if (await ensureSandbox()) await send(line);
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
          if (!arg) print(`Working directory: ${workdir}${repo && !isDirectory(repo) ? `\nRepository: ${repo}` : ""}`);
          else await openRepo(arg);
          break;
        case "/map": {
          // Shown even when the map is turned off for /fix, at the default size.
          const map = await repoMapFor(workdir, arg, config.repoMapTokens || 3000);
          print(map ? `${map.text}\n\n${describeRepoMap(map)}` : "Could not build the repository map.");
          break;
        }
        case "/project": {
          const project = await projectFor(workdir, sandbox && ((tool) => sandbox!.toolVersion(tool)));
          print(project ? `${projectBlock(project).replace(/^<project>\n|\n<\/project>$/g, "")}\n\n${describeProject(project)}` : "Could not read the project files.");
          break;
        }
        case "/fix":
          if (!repo) print("Open a repository first: /repo <url>");
          else if (!arg) print("Usage: /fix <issue number | issue url | description>");
          else await fix(arg);
          break;
        default:
          print(`Unknown command '${cmd}'. Type /help.`);
      }
      prompt();
    }
  } finally {
    rl.close();
    await sandbox?.close();
  }
}
