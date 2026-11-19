import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { completeFix, fixPatch, FixError, startFix, type FixOutcome } from "./agent/fix.js";
import { createSelfReview } from "./agent/review.js";
import { runAgent } from "./agent/loop.js";
import { fixSystemPrompt } from "./agent/prompt.js";
import { describeTask, resolveTask, taskPrompt, taskText, type FixTask } from "./agent/task.js";
import type { HarnessConfig } from "./config.js";
import { GitHubError } from "./github/issues.js";
import { formatUsage, type UsageTracker } from "./model/cost.js";
import type { ModelClient } from "./model/index.js";
import { CloneError, cloneRepo, parseRepoUrl } from "./repo/clone.js";
import { describeProject, projectFor, withProject } from "./repo/detect.js";
import { describeRepoMap, repoMapFor, withRepoMap } from "./repo/map.js";
import { createDefaultTools } from "./tools/index.js";
import { describeCall } from "./ui/repl.js";

/** Run records go here (git-ignored, removed by `make clean`). */
export const DEFAULT_RUNS_DIR = fileURLToPath(new URL("../runs/", import.meta.url));

/** Exit codes, so scripts and the eval can tell the cases apart. */
export const EXIT = { committed: 0, noFix: 1, setup: 2 } as const;

export interface HeadlessOptions {
  config: HarnessConfig;
  model: ModelClient;
  tracker: UsageTracker;
  /** Repository URL or local directory. */
  repo: string;
  /** Issue number/URL, or a described task (exactly one). */
  issue?: string;
  task?: string;
  githubToken?: string;
  workspacesDir?: string;
  runsDir?: string;
  output?: Writable;
  signal?: AbortSignal;
  /** For tests: replaces the GitHub API's fetch. */
  fetchImpl?: typeof fetch;
}

/** Fixes one issue or task without the UI. Returns the process exit code. */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const output = opts.output ?? process.stdout;
  const print = (s = "") => output.write(`${s}\n`);
  const started = Date.now();

  if (Boolean(opts.issue) === Boolean(opts.task)) {
    print("Give exactly one of ISSUE=<number|url> or TASK=\"<description>\".");
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
  const map = await repoMapFor(dir, taskText(task), opts.config.repoMapTokens, opts.signal);
  if (map) print(describeRepoMap(map));
  const project = await projectFor(dir);
  if (project) print(describeProject(project));
  print();

  // 3. Agent. Model text is streamed; tool calls are shown one per line.
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
  const review = opts.config.selfReview ? createSelfReview(dir, fix) : undefined;
  const result = await runAgent({
    model: opts.model,
    tools: createDefaultTools(),
    system: fixSystemPrompt(dir),
    root: dir,
    tracker: opts.tracker,
    limits: opts.config.limits,
    task: withRepoMap(withProject(taskPrompt(task), project), map),
    signal: opts.signal,
    events: {
      onText: write,
      onToolCall: (call) => line(`  → ${describeCall(call)}`),
      onToolResult: (r) => {
        if (r.isError) line(`    ✗ ${r.content.split("\n")[0]}`);
      },
      onRejectedToolCall: (detail) => line(`    ✗ tool call rejected by the API, retrying: ${detail}`),
    },
    beforeFinish: review
      ? async (input) => {
          const r = await review.check(input);
          if (r) line(`  ↻ ${r.note}`);
          return r?.message;
        }
      : undefined,
  });
  if (!atLineStart) output.write("\n");
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

  const runDir = path.join(opts.runsDir ?? DEFAULT_RUNS_DIR, `${timestamp(new Date(started))}-${fix.branch.replace(/^harness\//, "")}`);
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
  return outcome.committed ? EXIT.committed : EXIT.noFix;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 20261118-143005, in local time: sorts by date and is safe in file names. */
function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
