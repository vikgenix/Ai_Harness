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
import { GitHubError, githubRepoOf } from "../github/issues.js";
import { describePlan, describePullRequest, planPullRequest, pushAndOpenPullRequest, type GitHubOptions } from "../github/pr.js";
import { formatUsage, type UsageTracker } from "../model/cost.js";
import type { Message, ModelClient, ToolCall } from "../model/index.js";
import { CloneError, cloneRepo, parseRepoUrl } from "../repo/clone.js";
import { describeProject, projectBlock, projectFor } from "../repo/detect.js";
import { existingEnvironment } from "../repo/env.js";
import { describeRepoMap, repoMapFor } from "../repo/map.js";
import { envsDirOf, fixMessage, openSandbox, prepareWorkspace } from "../agent/workspace.js";
import { describeDraft, runAudit, saveAudit, type PostedIssue } from "../agent/audit.js";
import { postIssue } from "../github/audit.js";
import { DEFAULT_RUNS_DIR } from "../runs.js";
import { SandboxError, type DockerSandbox } from "../sandbox/docker.js";
import { createDefaultTools, type ToolRegistry } from "../tools/index.js";
import type { Workspace } from "../agent/workspace.js";
import type { SessionView } from "./view.js";

const HELP = `Type a request about the code in the working directory, or a command:
  /repo <url|dir>    clone a repository (or open a local directory) to work in
  /fix <n|url|text>  fix an issue number, issue URL or described bug
  /pr                push the fix branch and open a pull request (asks first; needs GITHUB_TOKEN)
  /audit [focus]     look for bugs and draft GitHub issues (each posted only if you say yes)
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
  /** For tests: other GitHub API and git hosts. */
  githubHosts?: Pick<GitHubOptions, "apiBase" | "webBase" | "forkPollMs">;
  /** Where audit records are saved (default: runs/ in the harness directory). */
  runsDir?: string;
  tools?: ToolRegistry;
  input?: Readable;
  output?: Writable & { isTTY?: boolean };
  /** A screen that shows the session in panels (the TUI); without one, everything is printed as lines. */
  view?: SessionView;
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

/** Stages of a fix or an audit, from what the workspace preparation found. */
function reportWorkspace(view: SessionView | undefined, ws: Workspace): void {
  if (!view) return;
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  view.stage("Repo map", ws.map ? "done" : "skipped", ws.map ? `${count(ws.map.files, "file")}, ${count(ws.map.symbols, "symbol")}` : "off");
  view.stage("Project", ws.project?.ecosystems.length ? "done" : "skipped", ws.project?.ecosystems.map((e) => e.name).join(", ") || "none detected");
  if (ws.sandbox) view.stage("Sandbox", "done", ws.sandbox.image);
  if (ws.setup) {
    const failed = ws.setup.results.filter((r) => r.status === "failed").length;
    const fresh = ws.setup.results.filter((r) => r.status === "installed").length;
    view.stage("Dependencies", failed ? "failed" : "done", failed ? `${failed} failed` : fresh ? "installed" : "up to date");
  } else view.stage("Dependencies", "skipped");
  if (ws.baseline) {
    const runs = ws.baseline.runs;
    const broken = runs.find((r) => r.status === "error" || r.status === "timed_out");
    const failing = runs.reduce((n, r) => n + (r.counts ? r.counts.failed + r.counts.errors : 0), 0);
    const passed = runs.reduce((n, r) => n + (r.counts?.passed ?? 0), 0);
    view.stage("Baseline", broken ? "failed" : "done", broken ? (broken.status === "timed_out" ? "too slow" : "could not run") : failing ? `${failing} already failing` : `${passed} passed`);
  } else view.stage("Baseline", "skipped");
}

/**
 * The interactive session: chat, /fix, /audit, /pr and the other commands.
 * It prints as lines, or, given a view, also reports to the full-screen TUI.
 */
export async function startRepl(opts: ReplOptions): Promise<void> {
  const { config, model, tracker, view } = opts;
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
  const interrupt = () => {
    if (inFlight) inFlight.abort();
    else rl.close();
  };
  rl.on("SIGINT", interrupt);
  view?.onInterrupt(interrupt);
  const showContext = (extra: { branch?: string; base?: string } = {}) => view?.context({ workdir, ...extra, sandbox: sandbox?.image });

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
      showContext();
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
    showContext();
  }

  /** Runs the agent on `text` and shows its progress. `mode` replaces the chat's system prompt and history (used by /fix). */
  async function send(text: string, mode: { system?: string; history?: Message[]; review?: SelfReview; tools?: ToolRegistry } = {}): Promise<AgentResult> {
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
    view?.busy(true);
    let steps = 0;
    let runCost: number | undefined = 0;
    try {
      const result = await runAgent({
        model,
        tools: mode.tools ?? tools,
        system: mode.system ?? agentSystemPrompt(workdir),
        root: workdir,
        env: toolEnv,
        sandbox,
        maxRequestTokens: config.maxRequestTokens,
        maxOutputTokens: config.maxOutputTokens,
        tracker,
        limits: config.limits,
        history: mode.history ?? history,
        task: text,
        signal: inFlight.signal,
        events: {
          onText: write,
          onToolCall: (call) => {
            if (view) {
              if (!atLineStart) write("\n");
              view.toolStarted(call);
            } else line(dim(`  → ${describeCall(call)}`));
          },
          onToolResult: (r, ms) => {
            if (view) view.toolFinished(r, ms);
            else if (r.isError) line(dim(`    ✗ ${r.content.split("\n")[0]}`));
          },
          onRejectedToolCall: (detail) => line(dim(`    ✗ tool call rejected by the API, retrying: ${detail}`)),
          onNotice: (text) => line(dim(`  ⤓ ${text}`)),
          onResponse: (_res, cost) => {
            steps++;
            runCost = cost === undefined || runCost === undefined ? undefined : runCost + cost;
            const u = tracker.usage;
            view?.usage({
              steps,
              maxSteps: config.limits.maxSteps,
              runCostUsd: runCost,
              maxCostUsd: config.limits.maxCostUsd,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              sessionCostUsd: tracker.pricedCostUsd,
            });
          },
        },
        beforeFinish: mode.review
          ? async (input) => {
              const r = await mode.review!.check(input);
              if (r) {
                line(dim(`  ↻ ${r.note}`));
                view?.stage("Self-review", "running", `round ${mode.review!.rounds}`);
              }
              return r?.message;
            }
          : undefined,
      });

      // A run that failed before any reply leaves no trace, so the next message starts clean.
      if (!(result.steps === 0 && (result.status === "error" || result.status === "cancelled"))) history = result.messages;

      if (!atLineStart) output.write("\n");
      if (result.finished) {
        const { outcome, summary } = result.finished;
        print(outcome ? `\n${outcome === "completed" ? "✓ Done" : "✗ Blocked"}: ${summary}` : `\n${summary}`); // an audit has no outcome
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
      view?.busy(false);
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
    view?.task({
      kind: "fix",
      title: task.kind === "issue" ? `#${task.issue.ref.number} ${task.issue.title}` : task.text.split("\n")[0]!,
      detail:
        task.kind === "issue"
          ? `${task.issue.ref.owner}/${task.issue.ref.name} · ${task.issue.state}${task.issue.labels.length ? ` · ${task.issue.labels.join(", ")}` : ""}\n\n${task.issue.body}`
          : task.text.includes("\n")
            ? task.text
            : undefined, // a one-line task is the title already
    });
    view?.busy(true);
    try {
      if (!(await ensureSandbox())) return; // before the branch, so a missing Docker changes nothing

      let branch;
      try {
        branch = await startFix(workdir, task);
      } catch (err) {
        if (!(err instanceof FixError)) throw err;
        print(err.message);
        view?.stage("Branch", "failed", "the working tree is not clean");
        return;
      }
      print(`Working on branch ${branch.branch} (from ${branch.baseName}).`);
      view?.stage("Branch", "done", branch.branch);
      showContext({ branch: branch.branch, base: branch.base });
      // Ctrl-C during the install or the baseline skips that step; the fix goes on without it.
      view?.stage("Prepare", "running");
      const prepStarted = Date.now();
      const ws = await prepareWorkspace(workdir, { config, query: taskText(task), envsDir: opts.envsDir, print, step, sandbox });
      view?.stage("Prepare", "done", `${((Date.now() - prepStarted) / 1000).toFixed(1)}s`);
      reportWorkspace(view, ws);
      if (ws.env) toolEnv = ws.env;

      // A fix is its own conversation; afterwards the chat continues from it.
      const review = config.selfReview ? createSelfReview(workdir, branch) : undefined;
      view?.stage("Agent", "running");
      const result = await send(fixMessage(taskPrompt(task), ws), { system: fixSystemPrompt(workdir), history: [], review });
      const completed = result.finished?.outcome === "completed";
      view?.stage("Agent", completed ? "done" : "failed", completed ? `${result.steps} steps` : result.finished ? "blocked" : result.status.replace("_", " "));
      if (review?.rounds) view?.stage("Self-review", "done", `${review.rounds} ${review.rounds === 1 ? "round" : "rounds"}, ${review.findings.length} found`);
      try {
        const outcome = await completeFix(workdir, branch, task, result);
        print(outcome.message);
        view?.stage("Commit", outcome.committed ? "done" : "skipped", outcome.committed ? outcome.commit : "not committed");
        if (outcome.committed && (await githubRepoOf(workdir))) print("To push it and open a pull request: /pr");
      } catch (err) {
        if (!(err instanceof FixError)) throw err;
        print(`Could not commit the fix: ${err.message}`);
        view?.stage("Commit", "failed", err.message);
      }
    } finally {
      view?.busy(false);
    }
  }

  /** Asks a question and waits for the next line typed (empty at the end of input). */
  async function ask(question: string): Promise<string> {
    if (view) view.question(question.trim());
    else output.write(question);
    const next = await lines.next();
    return next.done ? "" : next.value.trim();
  }

  /** /pr: shows the pull request for the checked-out fix branch, and pushes and opens it if the user agrees. */
  async function pullRequest(): Promise<void> {
    if (!opts.githubToken) {
      print('Set GITHUB_TOKEN to push branches and open pull requests: export GITHUB_TOKEN="<token>" (it needs write access to contents and pull requests).');
      return;
    }
    let plan;
    try {
      plan = await planPullRequest(workdir, { draft: config.prDraft });
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      print(err.message);
      return;
    }
    print(describePlan(plan));
    // Others will see it: never without a yes.
    if (!/^y(es)?$/i.test(await ask(`Push ${plan.branch} and open this pull request? [y/N] `))) {
      print("Not pushed.");
      return;
    }
    const token = opts.githubToken;
    try {
      const pr = await step((signal) => pushAndOpenPullRequest(workdir, plan, { token, signal, fetchImpl: opts.fetchImpl, ...opts.githubHosts }));
      print(describePullRequest(pr));
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      print(err.message);
    }
  }

  /** /audit: the agent looks for bugs and drafts issues; each draft is posted only after a yes. */
  async function audit(focus: string): Promise<void> {
    if (!(await ensureSandbox())) return;
    const started = new Date();
    const github = (await githubRepoOf(workdir)) ?? undefined;
    const api = { token: opts.githubToken, fetchImpl: opts.fetchImpl, apiBase: opts.githubHosts?.apiBase };
    print(`Auditing ${workdir}${focus ? ` (focus: ${focus})` : ""}.`);
    view?.task({ kind: "audit", title: focus ? `Audit: ${focus}` : "Audit", detail: github ? `${github.owner}/${github.name}` : workdir });
    view?.busy(true);
    let outcome;
    try {
      outcome = await runAudit(workdir, {
        focus,
        github,
        api,
        print,
        prepare: async () => {
          view?.stage("Prepare", "running");
          const prepStarted = Date.now();
          const ws = await prepareWorkspace(workdir, { config, query: focus, envsDir: opts.envsDir, print, step, sandbox });
          view?.stage("Prepare", "done", `${((Date.now() - prepStarted) / 1000).toFixed(1)}s`);
          reportWorkspace(view, ws);
          view?.stage("Agent", "running");
          return ws;
        },
        agent: (system, message, auditTools) => send(message, { system, history: [], tools: auditTools }),
      });
    } finally {
      view?.busy(false);
    }
    if (outcome.workspace.env) toolEnv = outcome.workspace.env;
    view?.stage("Agent", outcome.result.status === "finished" ? "done" : "failed", outcome.result.status === "finished" ? `${outcome.drafts.length} drafts` : outcome.result.status.replace("_", " "));
    if (github) view?.stage("Duplicates", outcome.duplicateError ? "failed" : "done", outcome.duplicateError ? "search incomplete" : `${outcome.duplicates.filter((d) => d.length).length} with similar issues`);

    const { drafts } = outcome;
    if (outcome.result.status === "finished" && !drafts.length) print("No issues worth reporting were found.");
    if (outcome.duplicateError) print(`Duplicate search incomplete: ${outcome.duplicateError}`);
    const canPost = Boolean(github && opts.githubToken);
    let asking = canPost;
    const posted: PostedIssue[] = [];
    for (let i = 0; i < drafts.length; i++) {
      print();
      print(describeDraft(drafts[i]!, i, drafts.length, outcome.duplicates[i] ?? []));
      if (!asking) continue;
      // Others will see it: never without a yes, one issue at a time.
      const answer = await ask(`Post this issue to ${github!.owner}/${github!.name}? [y/N/q] `);
      if (/^q(uit)?$/i.test(answer)) {
        asking = false;
        print("Not posted. The remaining drafts are shown but not offered.");
        continue;
      }
      if (!/^y(es)?$/i.test(answer)) {
        print("Not posted.");
        continue;
      }
      try {
        const issue = await step((signal) => postIssue(github!, drafts[i]!, { ...api, token: opts.githubToken!, signal }));
        posted.push({ draft: i, ...issue });
        print(`Posted #${issue.number}: ${issue.url}`);
        view?.stage(`Posted #${issue.number}`, "done", drafts[i]!.title);
      } catch (err) {
        if (!(err instanceof GitHubError)) throw err;
        print(`Not posted: ${err.message}`);
      }
    }
    const runDir = await saveAudit(opts.runsDir ?? DEFAULT_RUNS_DIR, started, outcome, posted, { repo: repo ?? workdir, dir: workdir, model: model.model, focus });
    if (drafts.length) {
      const why = !github ? " This directory did not come from GitHub, so they cannot be posted from here." : !opts.githubToken ? " Set GITHUB_TOKEN to post them." : "";
      print(`\nDrafts saved to ${path.join(runDir, "issues.md")}.${why}`);
    }
  }

  // Async iteration (not rl.question) so lines typed or piped in before the
  // prompt appears are queued instead of dropped. Started before the initial
  // clone, which can take a while. The loop ends on EOF / Ctrl-D.
  const lines = rl[Symbol.asyncIterator]();

  print(HELP);
  print();
  showContext();
  if (opts.initialRepo) await openRepo(opts.initialRepo);
  else print(`Working directory: ${workdir}`);

  rl.setPrompt(view ? "" : "\nshrike › "); // the TUI draws its own input line
  prompt();
  try {
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        prompt();
        continue;
      }

      if (!line.startsWith("/")) {
        view?.task({ kind: "chat", title: "Chat", detail: line });
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
        case "/pr":
          await pullRequest();
          break;
        case "/audit":
          await audit(arg);
          break;
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
