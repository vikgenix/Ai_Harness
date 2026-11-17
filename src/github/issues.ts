import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRepoUrl } from "../repo/clone.js";

const run = promisify(execFile);

export const GITHUB_API = "https://api.github.com";
/** Issue text is written by anyone; these caps keep a huge issue from filling the context. */
export const MAX_BODY_CHARS = 20_000;
export const MAX_COMMENT_CHARS = 4_000;
export const MAX_COMMENTS = 30;

export interface IssueRef {
  owner: string;
  name: string;
  number: number;
}

export interface Issue {
  ref: IssueRef;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  comments: { author: string; body: string }[];
  /** Comments not fetched because of MAX_COMMENTS. */
  moreComments: number;
}

export class GitHubError extends Error {
  override name = "GitHubError";
}

const SAFE = /^[A-Za-z0-9_.-]+$/;

/**
 * Recognises an issue reference, or returns null:
 *   123 or #123                        (needs `current`, the open GitHub repository)
 *   owner/repo#123
 *   https://github.com/owner/repo/issues/123
 */
export function parseIssueRef(input: string, current?: { owner: string; name: string }): IssueRef | null {
  const text = input.trim();
  const make = (owner: string, name: string, n: string): IssueRef | null => {
    const number = Number(n);
    if (!SAFE.test(owner) || !SAFE.test(name) || !Number.isSafeInteger(number) || number < 1) return null;
    return { owner, name, number };
  };

  const bare = /^#?(\d+)$/.exec(text);
  if (bare) return current ? make(current.owner, current.name, bare[1]!) : null;

  const short = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  if (short) return make(short[1]!, short[2]!, short[3]!);

  const url = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?(?:[?#]\S*)?$/.exec(text);
  if (url) return make(url[1]!, url[2]!, url[3]!);
  return null;
}

/** True if `input` looks like an issue reference rather than a described task. */
export function looksLikeIssueRef(input: string): boolean {
  return /^#?\d+$/.test(input.trim()) || parseIssueRef(input) !== null;
}

/** The GitHub repository a local clone came from (its `origin` remote), or null. */
export async function githubRepoOf(dir: string): Promise<{ owner: string; name: string } | null> {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd: dir });
    const spec = parseRepoUrl(stdout.trim());
    return spec?.host === "github.com" ? { owner: spec.owner, name: spec.name } : null;
  } catch {
    return null;
  }
}

export interface FetchIssueOptions {
  token?: string;
  signal?: AbortSignal;
  /** For tests. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

/** Fetches an issue and its first comments from the GitHub REST API. */
export async function fetchIssue(ref: IssueRef, opts: FetchIssueOptions = {}): Promise<Issue> {
  const label = `${ref.owner}/${ref.name}#${ref.number}`;
  const base = `${opts.apiBase ?? GITHUB_API}/repos/${ref.owner}/${ref.name}/issues/${ref.number}`;
  const get = async (url: string) => {
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ai-harness",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new GitHubError("Cancelled.");
      throw new GitHubError(`Could not reach GitHub: ${(err as Error).message}`);
    }
    if (res.ok) return res.json() as Promise<unknown>;
    if (res.status === 404 || res.status === 410) {
      throw new GitHubError(`Issue ${label} not found${opts.token ? "" : " (if the repository is private, set GITHUB_TOKEN)"}.`);
    }
    if (res.status === 401) throw new GitHubError("GitHub rejected GITHUB_TOKEN (401). Check that it is valid.");
    if (res.status === 403 || res.status === 429) {
      const limited = res.headers.get("x-ratelimit-remaining") === "0" || res.status === 429;
      throw new GitHubError(
        limited
          ? `GitHub rate limit reached${opts.token ? "" : " (60 requests/hour without a token; set GITHUB_TOKEN for more)"}.`
          : `GitHub refused access to ${label} (403).`,
      );
    }
    throw new GitHubError(`GitHub returned ${res.status} for ${label}.`);
  };

  const data = (await get(base)) as {
    title?: string;
    body?: string | null;
    state?: string;
    html_url?: string;
    labels?: ({ name?: string } | string)[];
    comments?: number;
    pull_request?: unknown;
  };
  if (data.pull_request) throw new GitHubError(`${label} is a pull request, not an issue.`);

  const total = data.comments ?? 0;
  const raw = total > 0 ? ((await get(`${base}/comments?per_page=${MAX_COMMENTS}`)) as { user?: { login?: string }; body?: string | null }[]) : [];
  return {
    ref,
    title: data.title ?? "",
    body: cap(data.body ?? "", MAX_BODY_CHARS),
    state: data.state ?? "unknown",
    url: data.html_url ?? `https://github.com/${ref.owner}/${ref.name}/issues/${ref.number}`,
    labels: (data.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    comments: raw.map((c) => ({ author: c.user?.login ?? "unknown", body: cap(c.body ?? "", MAX_COMMENT_CHARS) })),
    moreComments: Math.max(0, total - raw.length),
  };
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [cut: ${text.length - max} more characters]` : text;
}
