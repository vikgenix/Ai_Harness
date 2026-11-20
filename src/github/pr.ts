import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultBranch, FIX_BRANCH_PREFIXES, git } from "../agent/fix.js";
import { apiMessage, githubApi, type ApiResponse } from "./api.js";
import { GitHubError, githubRepoOf } from "./issues.js";

/**
 * Publishing a fix: push its branch and open a pull request.
 *
 * The branch goes to the repository itself when the token may push there,
 * otherwise to the user's fork (created if needed). Nothing is force-pushed:
 * if the remote already has a different branch of that name, the next free
 * name (-2, -3, ...) is used. The token is handed to git for the push command
 * only, as an auth header in the environment, so it is never saved in the
 * clone. Callers ask before calling pushAndOpenPullRequest in interactive use.
 */

const run = promisify(execFile);
export const GITHUB_WEB = "https://github.com";
const MAX_BRANCH_TRIES = 5;
const FORK_POLL_TRIES = 20;
const PUSH_TIMEOUT_MS = 5 * 60_000;
/** Says who made the pull request, so reviewers know what they are looking at. */
export const PR_FOOTER = "_Prepared by Shrike, an AI coding agent. Please review it like any other contribution._";

export interface GitHubOptions {
  token: string;
  signal?: AbortSignal;
  /** For tests: the API and the git host (e.g. a file:// directory of bare repositories). */
  apiBase?: string;
  webBase?: string;
  fetchImpl?: typeof fetch;
  /** For tests: time between checks that a new fork is ready. */
  forkPollMs?: number;
}

export interface PullRequestPlan {
  /** The repository the pull request goes to (where the clone came from). */
  repo: { owner: string; name: string };
  /** The local fix branch, and the branch it goes into. */
  branch: string;
  base: string;
  /** Commits on the branch that are not on the base. */
  commits: number;
  title: string;
  body: string;
  draft: boolean;
}

export interface PullRequestResult {
  url: string;
  number: number;
  /** Where the branch was pushed: "owner/name:branch". */
  pushedTo: string;
  /** The fork used, if the token could not push to the repository. */
  fork?: string;
  /** False when a pull request for the branch was already open. */
  created: boolean;
  draft: boolean;
}

/**
 * What /pr would open for the fix branch checked out in `dir`. Throws
 * GitHubError when there is nothing to open (not a GitHub clone, not on a fix
 * branch, no commits).
 */
export async function planPullRequest(dir: string, opts: { draft: boolean }): Promise<PullRequestPlan> {
  const repo = await githubRepoOf(dir);
  if (!repo) throw new GitHubError("This clone did not come from GitHub (its origin remote is not a github.com URL), so there is nowhere to open a pull request.");
  const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!FIX_BRANCH_PREFIXES.some((p) => branch.startsWith(p))) {
    throw new GitHubError(`The checked-out branch is '${branch}', not a fix branch (${FIX_BRANCH_PREFIXES[0]}...). Run /fix first, or check out its branch.`);
  }
  const baseRef = await defaultBranch(dir);
  if (!baseRef) throw new GitHubError("Could not tell the repository's default branch (origin/HEAD is not set).");
  const log = await git(dir, ["log", "--reverse", "--format=%s%x1f%b%x1e", `${baseRef}..HEAD`]);
  const commits = log
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [subject = "", body = ""] = c.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    });
  if (!commits.length) throw new GitHubError(`${branch} has no commits that are not on ${baseRef}; there is nothing to open a pull request for.`);

  const first = commits[0]!;
  const body =
    commits.length === 1
      ? first.body
      : [first.body, "", "Commits:", ...commits.map((c) => `- ${c.subject}`)].join("\n").trim();
  return {
    repo,
    branch,
    base: baseRef.replace(/^origin\//, ""),
    commits: commits.length,
    title: first.subject,
    body: `${body}\n\n---\n${PR_FOOTER}`.trim(),
    draft: opts.draft,
  };
}

/** The preview shown before asking. */
export function describePlan(plan: PullRequestPlan): string {
  const bodyLines = plan.body.split("\n");
  const shown = bodyLines.slice(0, 12).map((l) => `  │ ${l}`);
  if (bodyLines.length > 12) shown.push(`  │ … (${bodyLines.length - 12} more lines)`);
  return [
    `Pull request to ${plan.repo.owner}/${plan.repo.name}${plan.draft ? " (draft)" : ""}:`,
    `  ${plan.branch} → ${plan.base} (${plan.commits} ${plan.commits === 1 ? "commit" : "commits"})`,
    `  Title: ${plan.title}`,
    ...shown,
  ].join("\n");
}

// --- GitHub API ------------------------------------------------------------------

const api = (opts: GitHubOptions, method: string, path: string, body?: unknown) => githubApi(opts, method, path, body);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the token may push: the repository itself, or the user's fork (created if needed). */
async function pushTarget(plan: PullRequestPlan, opts: GitHubOptions): Promise<{ owner: string; name: string; fork: boolean }> {
  const { owner, name } = plan.repo;
  const repo = await api(opts, "GET", `/repos/${owner}/${name}`);
  if (repo.status === 404) throw new GitHubError(`GitHub repository ${owner}/${name} not found, or GITHUB_TOKEN cannot see it.`);
  if (repo.status !== 200) throw new GitHubError(`GitHub returned ${repo.status} for ${owner}/${name}: ${apiMessage(repo)}`);
  if ((repo.data.permissions as { push?: boolean } | undefined)?.push) return { owner, name, fork: false };

  const fork = await api(opts, "POST", `/repos/${owner}/${name}/forks`, { default_branch_only: true });
  if (fork.status !== 202 && fork.status !== 200) {
    throw new GitHubError(`GITHUB_TOKEN cannot push to ${owner}/${name}, and forking it failed (${fork.status}: ${apiMessage(fork)}).`);
  }
  const forkOwner = (fork.data.owner as { login?: string } | undefined)?.login;
  const forkName = fork.data.name as string | undefined;
  if (!forkOwner || !forkName) throw new GitHubError("GitHub did not say where the fork is.");
  // A new fork takes a few seconds to appear.
  for (let i = 0; i < FORK_POLL_TRIES; i++) {
    if ((await api(opts, "GET", `/repos/${forkOwner}/${forkName}`)).status === 200) return { owner: forkOwner, name: forkName, fork: true };
    await sleep(opts.forkPollMs ?? 1500);
  }
  throw new GitHubError(`The fork ${forkOwner}/${forkName} was not ready in time; try /pr again in a minute.`);
}

// --- git push --------------------------------------------------------------------

/** The token as an auth header for one git command (as actions/checkout does), never written to .git/config. */
function pushEnv(token: string, webBase: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  if (webBase.startsWith("https://")) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${webBase}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}

async function gitPush(dir: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ ok: boolean; stderr: string }> {
  try {
    await run("git", args, { cwd: dir, env, timeout: PUSH_TIMEOUT_MS, signal, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stderr: "" };
  } catch (err) {
    if (signal?.aborted) throw new GitHubError("Cancelled.");
    return { ok: false, stderr: String((err as { stderr?: string }).stderr ?? (err as Error).message) };
  }
}

/** Pushes the branch without force; a different branch of the same name on the remote gets the next free name. Returns the remote branch name. */
async function push(dir: string, plan: PullRequestPlan, target: { owner: string; name: string }, opts: GitHubOptions): Promise<string> {
  const webBase = opts.webBase ?? GITHUB_WEB;
  const url = `${webBase}/${target.owner}/${target.name}.git`;
  const env = pushEnv(opts.token, webBase);
  let unshallowed = false;
  for (let i = 1; i <= MAX_BRANCH_TRIES; i++) {
    const remoteBranch = i === 1 ? plan.branch : `${plan.branch}-${i}`;
    const r = await gitPush(dir, ["push", "--quiet", url, `HEAD:refs/heads/${remoteBranch}`], env, opts.signal);
    if (r.ok) return remoteBranch;
    if (/shallow update not allowed/i.test(r.stderr) && !unshallowed) {
      // The clone is shallow (--depth 1) and the remote lacks its base commit: fetch the history, then try again.
      unshallowed = true;
      await gitPush(dir, ["fetch", "--quiet", "--unshallow", "origin"], env, opts.signal);
      i--;
      continue;
    }
    if (/\[rejected\]|non-fast-forward|fetch first|already exists/i.test(r.stderr)) continue; // name taken by different work
    const last = r.stderr.trim().split("\n").filter(Boolean).pop() ?? "unknown error";
    if (/403|permission|denied/i.test(r.stderr)) throw new GitHubError(`GITHUB_TOKEN may not push to ${target.owner}/${target.name} (it needs "contents: write"): ${last}`);
    throw new GitHubError(`Could not push ${plan.branch} to ${target.owner}/${target.name}: ${last.replace(/^(fatal|error):\s*/, "")}`);
  }
  throw new GitHubError(`${target.owner}/${target.name} already has different branches named ${plan.branch} to ${plan.branch}-${MAX_BRANCH_TRIES}.`);
}

// --- pull request ----------------------------------------------------------------

/** Pushes the fix branch (to a fork if needed) and opens the pull request, or finds the one already open. */
export async function pushAndOpenPullRequest(dir: string, plan: PullRequestPlan, opts: GitHubOptions): Promise<PullRequestResult> {
  const target = await pushTarget(plan, opts);
  const remoteBranch = await push(dir, plan, target, opts);
  const head = target.fork ? `${target.owner}:${remoteBranch}` : remoteBranch;
  const { owner, name } = plan.repo;
  const result = (r: ApiResponse, created: boolean, draft: boolean): PullRequestResult => ({
    url: String(r.data.html_url),
    number: Number(r.data.number),
    pushedTo: `${target.owner}/${target.name}:${remoteBranch}`,
    ...(target.fork ? { fork: `${target.owner}/${target.name}` } : {}),
    created,
    draft: Boolean(r.data.draft ?? draft),
  });

  const open = (draft: boolean) =>
    api(opts, "POST", `/repos/${owner}/${name}/pulls`, { title: plan.title, body: plan.body, head, base: plan.base, draft, maintainer_can_modify: true });
  let draft = plan.draft;
  let r = await open(draft);
  if (r.status === 422 && draft && /draft/i.test(apiMessage(r))) {
    draft = false; // some repositories do not allow draft pull requests
    r = await open(false);
  }
  if (r.status === 201) return result(r, true, draft);
  if (r.status === 422 && /already exists/i.test(apiMessage(r))) {
    const found = await api(opts, "GET", `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${target.owner}:${remoteBranch}`)}`);
    const existing = found.list[0] as ApiResponse["data"] | undefined;
    if (existing) return result({ ...found, data: existing }, false, draft);
  }
  if (r.status === 403 || r.status === 404) {
    throw new GitHubError(`The branch was pushed to ${target.owner}/${target.name}:${remoteBranch}, but GITHUB_TOKEN may not open pull requests on ${owner}/${name} (${r.status}: ${apiMessage(r)}).`);
  }
  throw new GitHubError(`The branch was pushed to ${target.owner}/${target.name}:${remoteBranch}, but opening the pull request failed (${r.status}: ${apiMessage(r)}).`);
}

/** One line for the terminal. */
export function describePullRequest(pr: PullRequestResult): string {
  const what = pr.created ? `Opened ${pr.draft ? "draft " : ""}pull request #${pr.number}` : `Pull request #${pr.number} was already open`;
  return `Pushed to ${pr.pushedTo}${pr.fork ? " (your fork)" : ""}. ${what}: ${pr.url}`;
}
