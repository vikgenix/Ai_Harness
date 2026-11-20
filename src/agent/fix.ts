import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentResult } from "./loop.js";
import type { FixTask } from "./task.js";

const run = promisify(execFile);

/** Commits made where git has no user.name/user.email configured. */
const FALLBACK_IDENTITY = ["-c", "user.name=AI Harness", "-c", "user.email=ai-harness@localhost"];
const BRANCH_PREFIX = "harness/";
/**
 * Caches that running tests or installing dependencies leaves behind. They are
 * never committed, even in a repository whose .gitignore misses them.
 */
const JUNK_DIRS = ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv", "node_modules", ".cache"];
export const NOT_JUNK = ["--", ".", ...JUNK_DIRS.map((d) => `:(exclude,glob)**/${d}/**`), ":(exclude,glob)**/*.pyc"];

/** A problem the user should read, e.g. uncommitted changes before /fix. */
export class FixError extends Error {
  override name = "FixError";
}

export async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new FixError("git is not installed or not on PATH.");
    throw new FixError(`git ${args[0]} failed: ${(e.stderr ?? e.message).trim().split("\n").pop()}`);
  }
}

const succeeds = (dir: string, args: string[]) =>
  git(dir, args).then(
    () => true,
    () => false,
  );

/** Branch name for a task: harness/fix-123, or harness/<first words of the task>. */
export function branchName(task: FixTask): string {
  if (task.kind === "issue") return `${BRANCH_PREFIX}fix-${task.issue.ref.number}`;
  const slug = task.text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${BRANCH_PREFIX}${slug || "task"}`;
}

export interface FixBranch {
  branch: string;
  /** Commit the branch starts from. */
  base: string;
  /** Branch (or ref) it was created from, for messages. */
  baseName: string;
}

/** The repository's default branch (from origin/HEAD), as a local branch if one exists. */
export async function defaultBranch(dir: string): Promise<string | null> {
  try {
    const remote = await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]); // e.g. origin/main
    const local = remote.replace(/^origin\//, "");
    return (await succeeds(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${local}`])) ? local : remote;
  } catch {
    return null;
  }
}

/**
 * Prepares the repository for a fix: checks it is a clean git work tree and
 * creates a new branch for the task, so the fix never lands on the user's branch.
 */
export async function startFix(dir: string, task: FixTask): Promise<FixBranch> {
  if (!(await succeeds(dir, ["rev-parse", "--is-inside-work-tree"]))) {
    throw new FixError(`${dir} is not a git repository; /fix needs one so the fix can go on its own branch.`);
  }
  if (!(await succeeds(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]))) {
    throw new FixError("The repository has no commits yet; /fix needs a commit to branch from.");
  }
  const dirty = await git(dir, ["status", "--porcelain"]);
  if (dirty) {
    const shown = dirty.split("\n").slice(0, 10).join("\n");
    throw new FixError(
      `The working directory has uncommitted changes:\n${shown}\n` +
        `Commit or discard them first (for example: git -C "${dir}" stash -u), so the fix starts from a clean state.`,
    );
  }

  // Each fix starts from the default branch, not from the previous fix.
  let baseName = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (baseName.startsWith(BRANCH_PREFIX)) baseName = (await defaultBranch(dir)) ?? baseName;
  const base = await git(dir, ["rev-parse", baseName === "HEAD" ? "HEAD" : `${baseName}^{commit}`]);

  const wanted = branchName(task);
  let branch = wanted;
  for (let i = 2; await succeeds(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); i++) branch = `${wanted}-${i}`;
  await git(dir, ["checkout", "-q", "-b", branch, base]);
  return { branch, base, baseName };
}

/** Subject line and body for the fix commit. */
export function commitMessage(task: FixTask, summary: string): string {
  const subject =
    task.kind === "issue" ? `Fix #${task.issue.ref.number}: ${task.issue.title}` : `Fix: ${task.text.split("\n")[0]}`;
  const short = subject.length > 72 ? `${subject.slice(0, 71).trimEnd()}…` : subject;
  const parts = [short, "", summary.trim()];
  if (task.kind === "issue") parts.push("", `Fixes #${task.issue.ref.number}`);
  return parts.join("\n");
}

export interface FixOutcome {
  committed: boolean;
  /** Short hash of the fix commit. */
  commit?: string;
  /** Files changed on the branch (relative paths). */
  files: string[];
  /** What happened, for the user. */
  message: string;
}

const STOP_REASONS: Record<AgentResult["status"], string> = {
  done: "stopped without calling finish",
  finished: "reported it was blocked",
  max_steps: "reached the step limit",
  budget: "reached the cost limit",
  max_tokens: "hit the output token limit",
  refusal: "declined the task",
  cancelled: "was cancelled",
  error: "stopped on a model error",
};

/**
 * After the agent run: commits the changes on the fix branch if the agent
 * finished with outcome "completed"; otherwise leaves them for inspection.
 */
export async function completeFix(dir: string, fix: FixBranch, task: FixTask, result: AgentResult): Promise<FixOutcome> {
  const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== fix.branch) {
    return { committed: false, files: [], message: `The agent switched to '${current}' (expected ${fix.branch}); nothing was committed.` };
  }

  const status = await git(dir, ["status", "--porcelain", "--untracked-files=all", ...NOT_JUNK]);
  const files = status ? status.split("\n").map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "")) : [];
  const where = `branch ${fix.branch}`;

  if (result.finished?.outcome !== "completed") {
    const why = `the agent ${STOP_REASONS[result.status]}`;
    return {
      committed: false,
      files,
      message: files.length
        ? `Not committed: ${why}. ${count(files)} changed on ${where} are left for you to inspect (git -C "${dir}" diff).`
        : `Not committed: ${why}. No files were changed.`,
    };
  }
  if (!files.length) {
    return { committed: false, files, message: `The agent finished without changing any files; nothing to commit (${where}).` };
  }

  await git(dir, ["add", "-A", ...NOT_JUNK]);
  const identity = (await succeeds(dir, ["config", "user.email"])) ? [] : FALLBACK_IDENTITY;
  await git(dir, [...identity, "commit", "-q", "-m", commitMessage(task, result.finished.summary)]);
  const commit = await git(dir, ["rev-parse", "--short", "HEAD"]);
  return { committed: true, commit, files, message: `Committed ${commit} on ${where} (${count(files)}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""}).` };
}

/** The fix commit(s) on the branch as a patch file (git format-patch), for the run record. */
export function fixPatch(dir: string, fix: FixBranch): Promise<string> {
  return git(dir, ["format-patch", "--stdout", `${fix.base}..${fix.branch}`]).then((p) => `${p}\n`);
}

const count = (files: string[]) => `${files.length} ${files.length === 1 ? "file" : "files"}`;
