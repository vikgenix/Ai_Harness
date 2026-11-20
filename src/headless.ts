import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { completeFix, fixPatch, FixError, startFix, type FixOutcome } from "./agent/fix.js";
import { createSelfReview } from "./agent/review.js";
import { runAgent, type AgentEvents } from "./agent/loop.js";
import { describeDraft, runAudit, saveAudit } from "./agent/audit.js";
import { fixSystemPrompt } from "./agent/prompt.js";
import { describeTask, resolveTask, taskPrompt, taskText, type FixTask } from "./agent/task.js";
import type { HarnessConfig } from "./config.js";
import { GitHubError, githubRepoOf } from "./github/issues.js";
import { describePullRequest, planPullRequest, pushAndOpenPullRequest, type GitHubOptions } from "./github/pr.js";
import { formatUsage, type UsageTracker } from "./model/cost.js";
import type { ModelClient } from "./model/index.js";
import { CloneError, cloneRepo, parseRepoUrl } from "./repo/clone.js";
import { fixMessage, prepareWorkspace, type Workspace } from "./agent/workspace.js";
import { dockerProblem, SandboxError, type DockerSandbox } from "./sandbox/docker.js";
import { DEFAULT_RUNS_DIR, timestamp } from "./runs.js";
import { createDefaultTools } from "./tools/index.js";
import { describeCall } from "./ui/repl.js";

export { DEFAULT_RUNS_DIR } from "./runs.js";

/** Exit codes, so scripts and the eval can tell the cases apart. */
export const EXIT = { committed: 0, noFix: 1, setup: 2, prFailed: 3 } as const;

export interface HeadlessOptions {
  config: HarnessConfig;
  model: ModelClient;
  tracker: UsageTracker;
  /** Repository URL or local directory. */
  repo: string;
  /** Issue number/URL, a described task, or an audit with optional focus words (exactly one). */
  issue?: string;
  task?: string;
  audit?: string;
  githubToken?: string;
  workspacesDir?: string;
  runsDir?: string;
  /** Where dependency environments are kept (default: envs/ in the harness directory). */
  envsDir?: string;
  output?: Writable;
  signal?: AbortSignal;
  /** For tests: replaces the GitHub API's fetch. */
  fetchImpl?: typeof fetch;
  /** After a committed fix, push it and open a pull request (needs githubToken). */
  pr?: boolean;
  /** For tests: other GitHub API and git hosts. */
  githubHosts?: Pick<GitHubOptions, "apiBase" | "webBase" | "forkPollMs">;
}

/** Fixes one issue or task without the UI. Returns the process exit code. */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const held: { sandbox?: DockerSandbox } = {};
  try {
    return await run(opts, held);
  } finally {
    await held.sandbox?.close(); // the container goes, whatever happened
  }
}

async function run(opts: HeadlessOptions, held: { sandbox?: DockerSandbox }): Promise<number> {
  const output = opts.output ?? process.stdout;
  const print = (s = "") => output.write(`${s}\n`);
  const started = Date.now();

  const asked = [opts.issue, opts.task].filter(Boolean).length + (opts.audit !== undefined ? 1 : 0);
  if (asked !== 1) {
    print('Give exactly one of ISSUE=<number|url>, TASK="<description>" or AUDIT=1 (or AUDIT="<focus>").');
    return EXIT.setup;
  }

  // 1. Repository: a local directory as-is, or a clone.
  let dir: string;
  if (isDirectory(opts.repo)) {
    dir = path.resolve(opts.repo);
  } else {
    const spec = parseRepoUrl(opts.repo);
    if (!spec) {
      print(`'${opts.repo}' is not a directory or a repository URL (e.g. https://github.com/owner/repo or owner/repo).`);
      return EXIT.setup;
    }
    print(`Cloning ${spec.label}...`);
    try {
      const cloned = await cloneRepo(spec, { workspacesDir: opts.workspacesDir, githubToken: opts.githubToken, signal: opts.signal });
      dir = cloned.dir;
      print(cloned.reused ? `Using the existing clone in ${dir}.` : `Cloned in ${(cloned.durationMs / 1000).toFixed(1)}s to ${dir}.`);
    } catch (err) {
      if (!(err instanceof CloneError)) throw err;
      print(err.message);
      return EXIT.setup;
    }
  }

  // Checked before the branch is made, so a missing Docker changes nothing.
  if (opts.config.sandbox === "docker") {
    const problem = await dockerProblem();
    if (problem) {
      print(`${problem}. Start Docker, or run without the sandbox (sandbox: none in config/model.yaml).`);
      return EXIT.setup;
    }
  }

  if (opts.audit !== undefined) return audit(opts, dir, held, print, started);

  // 2. Task and branch.
  let task: FixTask;
  let fix;
  try {
    task = await resolveTask((opts.issue ?? opts.task)!, dir, { token: opts.githubToken, signal: opts.signal, fetchImpl: opts.fetchImpl });
    print(describeTask(task));
    fix = await startFix(dir, task);
  } catch (err) {
    if (!(err instanceof GitHubError) && !(err instanceof FixError)) throw err;
    print(err.message);
    return EXIT.setup;
  }
  print(`Working on branch ${fix.branch} (from ${fix.baseName}).`);
  let ws: Workspace;
  try {
    ws = await prepareWorkspace(dir, { config: opts.config, query: taskText(task), envsDir: opts.envsDir, signal: opts.signal, print, step: (fn) => fn(opts.signal) });
  } catch (err) {
    if (!(err instanceof SandboxError)) throw err;
    print(err.message);
    return EXIT.setup;
  }
  held.sandbox = ws.sandbox;
  const { map, project, setup, baseline } = ws;
  print();

  // 3. Agent. Model text is streamed; tool calls are shown one per line.
  const { events, line, endLine } = progress(output);
  const review = opts.config.selfReview ? createSelfReview(dir, fix) : undefined;
  const result = await runAgent({
    model: opts.model,
    tools: createDefaultTools(),
    system: fixSystemPrompt(dir),
    root: dir,
    env: ws.env,
    sandbox: ws.sandbox,
    maxRequestTokens: opts.config.maxRequestTokens,
    maxOutputTokens: opts.config.maxOutputTokens,
    tracker: opts.tracker,
    limits: opts.config.limits,
    task: fixMessage(taskPrompt(task), ws),
    signal: opts.signal,
    events,
    beforeFinish: review
      ? async (input) => {
          const r = await review.check(input);
          if (r) line(`  ↻ ${r.note}`);
          return r?.message;
        }
      : undefined,
  });
  endLine();
  if (result.finished) print(`\n${result.finished.outcome === "completed" ? "✓ Done" : "✗ Blocked"}: ${result.finished.summary}`);
  if (result.status === "error" && result.error) print(`Model error: ${result.error.message}`);
  const cost = result.costIncomplete ? undefined : result.costUsd;
  const durationMs = Date.now() - started;
  print(`[${opts.model.model} · ${result.steps} ${result.steps === 1 ? "step" : "steps"} · ${(durationMs / 1000).toFixed(1)}s · ${formatUsage(result.usage, cost)}]`);

  // 4. Commit, then save the run record.
  let outcome: FixOutcome;
  try {
    outcome = await completeFix(dir, fix, task, result);
  } catch (err) {
    if (!(err instanceof FixError)) throw err;
    outcome = { committed: false, files: [], message: `Could not commit the fix: ${err.message}` };
  }
  print(outcome.message);

  // 5. Pull request, when asked for (--pr / PR=1).
  let pullRequest: Record<string, unknown> | null = null;
  if (opts.pr && outcome.committed) {
    if (!opts.githubToken) {
      print("Not pushed: set GITHUB_TOKEN to push the fix and open a pull request.");
      pullRequest = { error: "GITHUB_TOKEN is not set" };
    } else {
      try {
        const plan = await planPullRequest(dir, { draft: opts.config.prDraft });
        print(`Pushing ${plan.branch} and opening a pull request to ${plan.repo.owner}/${plan.repo.name}...`);
        const pr = await pushAndOpenPullRequest(dir, plan, { token: opts.githubToken, signal: opts.signal, fetchImpl: opts.fetchImpl, ...opts.githubHosts });
        print(describePullRequest(pr));
        pullRequest = { ...pr };
      } catch (err) {
        if (!(err instanceof GitHubError)) throw err;
        print(`Pull request not opened: ${err.message}`);
        pullRequest = { error: err.message };
      }
    }
  }

  const runDir = path.join(opts.runsDir ?? DEFAULT_RUNS_DIR, `${timestamp(new Date(started))}-${fix.branch.replace(/^[^/]+\//, "")}`);
  await mkdir(runDir, { recursive: true });
  const record = {
    repo: opts.repo,
    dir,
    task: task.kind === "issue" ? { kind: "issue", ...task.issue.ref, title: task.issue.title, url: task.issue.url } : task,
    branch: fix.branch,
    base: fix.base,
    status: result.status,
    outcome: result.finished?.outcome ?? null,
    summary: result.finished?.summary ?? null,
    committed: outcome.committed,
    commit: outcome.commit ?? null,
    files: outcome.files,
    message: outcome.message,
    model: opts.model.model,
    steps: result.steps,
    durationMs,
    usage: result.usage,
    costUsd: result.costIncomplete ? null : result.costUsd,
    error: result.error?.message ?? null,
    selfReview: review ? { rounds: review.rounds, findings: review.findings } : null,
    project: project
      ? { ecosystems: project.ecosystems.map((e) => ({ name: e.name, dir: e.dir, packageManager: e.packageManager ?? null, test: e.test?.command ?? null })), tools: project.tools }
      : null,
    sandbox: ws.sandbox ? { image: ws.sandbox.image, network: ws.sandbox.network } : null,
    dependencies: setup
      ? {
          envDir: setup.envDir,
          durationMs: setup.durationMs,
          results: setup.results.map((r) => ({ name: r.name, dir: r.dir, status: r.status, commands: r.commands, durationMs: r.durationMs, failed: r.failed ?? null })),
          restored: setup.restored,
          excluded: setup.excluded,
        }
      : null,
    baseline: baseline
      ? {
          durationMs: baseline.durationMs,
          runs: baseline.runs.map((r) => ({
            name: r.name,
            dir: r.dir,
            command: r.command,
            status: r.status,
            framework: r.framework ?? null,
            counts: r.counts ?? null,
            failing: r.failing,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            cached: r.cached,
          })),
          restored: baseline.restored,
          excluded: baseline.excluded,
        }
      : null,
    pullRequest,
    repoMap: map ? { files: map.files, detailedFiles: map.detailedFiles, symbols: map.symbols, chars: map.text.length, durationMs: map.durationMs } : null,
  };
  const saved = ["result.json", "transcript.json"];
  await writeFile(path.join(runDir, "result.json"), `${JSON.stringify(record, null, 2)}\n`);
  await writeFile(path.join(runDir, "transcript.json"), `${JSON.stringify(result.messages, null, 2)}\n`);
  if (outcome.committed) {
    await writeFile(path.join(runDir, "fix.patch"), await fixPatch(dir, fix));
    saved.push("fix.patch");
  }
  print(`Run saved to ${runDir} (${saved.join(", ")}).`);
  if (!outcome.committed) return EXIT.noFix;
  return pullRequest && "error" in pullRequest ? EXIT.prFailed : EXIT.committed;
}

/** Streams the agent's text and shows each tool call on its own line. */
function progress(output: Writable) {
  let atLineStart = true;
  const line = (s: string) => {
    if (!atLineStart) output.write("\n");
    output.write(`${s}\n`);
    atLineStart = true;
  };
  const events: AgentEvents = {
    onText: (s) => {
      if (!s) return;
      output.write(s);
      atLineStart = s.endsWith("\n");
    },
    onToolCall: (call) => line(`  → ${describeCall(call)}`),
    onToolResult: (r) => {
      if (r.isError) line(`    ✗ ${r.content.split("\n")[0]}`);
    },
    onRejectedToolCall: (detail) => line(`    ✗ tool call rejected by the API, retrying: ${detail}`),
    onNotice: (text) => line(`  ⤓ ${text}`),
  };
  const endLine = () => {
    if (!atLineStart) output.write("\n");
    atLineStart = true;
  };
  return { events, line, endLine };
}

/**
 * --audit without the UI: drafts issues and saves them in runs/; nothing is
 * posted, since posting needs a person to say yes to each issue.
 */
async function audit(opts: HeadlessOptions, dir: string, held: { sandbox?: DockerSandbox }, print: (s?: string) => void, startedMs: number): Promise<number> {
  const output = opts.output ?? process.stdout;
  const focus = /^(1|true|yes)$/i.test(opts.audit ?? "") ? "" : (opts.audit ?? "").trim();
  const github = (await githubRepoOf(dir)) ?? undefined;
  print(`Auditing ${dir}${focus ? ` (focus: ${focus})` : ""}.`);
  const { events, endLine } = progress(output);
  let ws: Workspace | undefined;
  let outcome;
  try {
    outcome = await runAudit(dir, {
      focus,
      github,
      api: { token: opts.githubToken, fetchImpl: opts.fetchImpl, apiBase: opts.githubHosts?.apiBase, signal: opts.signal },
      print,
      prepare: async () => {
        ws = await prepareWorkspace(dir, { config: opts.config, query: focus, envsDir: opts.envsDir, signal: opts.signal, print, step: (fn) => fn(opts.signal) });
        held.sandbox = ws.sandbox;
        print();
        return ws;
      },
      agent: (system, message, tools) =>
        runAgent({
          model: opts.model,
          tools,
          system,
          root: dir,
          env: ws?.env,
          sandbox: ws?.sandbox,
          maxRequestTokens: opts.config.maxRequestTokens,
          maxOutputTokens: opts.config.maxOutputTokens,
          tracker: opts.tracker,
          limits: opts.config.limits,
          task: message,
          signal: opts.signal,
          events,
        }),
    });
  } catch (err) {
    if (!(err instanceof SandboxError)) throw err;
    print(err.message);
    return EXIT.setup;
  }
  endLine();
  const { result, drafts } = outcome;
  if (outcome.summary) print(`\n${outcome.summary}`);
  if (result.status === "error" && result.error) print(`Model error: ${result.error.message}`);
  if (result.status !== "finished") print(`The audit stopped before reporting (${result.status}).`);
  else if (!drafts.length) print("No issues worth reporting were found.");
  if (outcome.duplicateError) print(`Duplicate search incomplete: ${outcome.duplicateError}`);
  drafts.forEach((d, i) => print(`\n${describeDraft(d, i, drafts.length, outcome.duplicates[i] ?? [])}`));
  const cost = result.costIncomplete ? undefined : result.costUsd;
  print(`\n[${opts.model.model} · ${result.steps} ${result.steps === 1 ? "step" : "steps"} · ${((Date.now() - startedMs) / 1000).toFixed(1)}s · ${formatUsage(result.usage, cost)}]`);

  const runDir = await saveAudit(opts.runsDir ?? DEFAULT_RUNS_DIR, new Date(startedMs), outcome, [], { repo: opts.repo, dir, model: opts.model.model, focus });
  print(`Saved to ${runDir} (result.json, issues.md, transcript.json).${drafts.length ? " Nothing was posted: review issues.md, then post the ones you want (or run /audit in an interactive session, which asks about each)." : ""}`);
  return result.status === "finished" ? EXIT.committed : EXIT.noFix;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
