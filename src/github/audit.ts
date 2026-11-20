import { apiMessage, githubApi, rateLimited, type ApiOptions } from "./api.js";
import { GitHubError } from "./issues.js";

/**
 * The GitHub side of /audit: the open issues the agent should not report
 * again, a duplicate search for each draft (open and closed issues), and
 * posting a draft once the user has said yes to it.
 */

export interface IssueDraft {
  title: string;
  /** Markdown: what happens, where, how to reproduce, expected and actual, a suggested fix. */
  body: string;
  severity: "high" | "medium" | "low";
  /** "confirmed": shown by running something; "likely": from reading the code. */
  confidence: "confirmed" | "likely";
  /** Files involved, relative to the repository root. */
  files: string[];
}

export interface KnownIssue {
  number: number;
  title: string;
  state?: string;
  url?: string;
}

export interface DuplicateCandidate extends KnownIssue {
  /** 0 to 1: how alike the titles and texts are. */
  score: number;
}

export type Repo = { owner: string; name: string };

/** Open issues listed for the agent at most. */
const MAX_OPEN_ISSUES = 100;
/** Candidates shown per draft, and the score below which an issue is not shown. */
const MAX_CANDIDATES = 3;
export const SHOW_SCORE = 0.3;
/** At or above this, a candidate is called a likely duplicate. */
export const LIKELY_DUPLICATE = 0.6;
/** Says how the issue came about, so maintainers can weigh it. */
export const ISSUE_FOOTER = "_Found by Shrike, an AI coding agent, and reviewed by a person before posting._";

const STOPWORDS = new Set(
  "the and for with when that this from into not are was were has have had but can cannot does doesn't don't its it's than then there their they them which while will would should could on in of to a an is be by or as at if no".split(" "),
);

/** Lowercase words of a text, with camelCase and snake_case split, without stopwords and short words. */
export function words(text: string): Set<string> {
  const split = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w)); // crude stemming: crash, crashes, crashed
  return new Set(split);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** How alike a draft and an existing issue are: mostly the titles, partly the texts. */
export function similarity(draft: { title: string; body: string }, issue: { title: string; body?: string }): number {
  const titles = dice(words(draft.title), words(issue.title));
  const texts = dice(words(`${draft.title} ${draft.body.slice(0, 600)}`), words(`${issue.title} ${(issue.body ?? "").slice(0, 600)}`));
  return Math.round((0.7 * titles + 0.3 * texts) * 100) / 100;
}

/** Open issues (not pull requests), newest first, for the agent to skip. Empty if GitHub cannot be read. */
export async function listOpenIssues(repo: Repo, opts: ApiOptions): Promise<KnownIssue[]> {
  const r = await githubApi(opts, "GET", `/repos/${repo.owner}/${repo.name}/issues?state=open&per_page=${MAX_OPEN_ISSUES}`).catch(() => undefined);
  if (!r || r.status !== 200) return [];
  return r.list
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: Number(i.number), title: String(i.title ?? ""), state: "open", url: String(i.html_url ?? "") }));
}

/** The draft's most telling title words, as an OR search (GitHub ANDs words by default). */
export function searchQuery(repo: Repo, draft: IssueDraft): string {
  const terms = [...words(draft.title)].slice(0, 5);
  return `repo:${repo.owner}/${repo.name} is:issue ${terms.join(" OR ")}`;
}

/** Existing issues (open or closed) that look like the draft, most alike first. */
export async function findDuplicates(repo: Repo, draft: IssueDraft, opts: ApiOptions): Promise<DuplicateCandidate[]> {
  const q = new URLSearchParams({ q: searchQuery(repo, draft), per_page: "20" });
  const r = await githubApi(opts, "GET", `/search/issues?${q}`);
  if (r.status !== 200) {
    throw new GitHubError(rateLimited(r) ? "GitHub's search rate limit was reached; set GITHUB_TOKEN or wait a minute." : `GitHub search failed (${r.status}: ${apiMessage(r)}).`);
  }
  const items = (r.data.items as Record<string, unknown>[] | undefined) ?? [];
  return items
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: Number(i.number),
      title: String(i.title ?? ""),
      state: String(i.state ?? ""),
      url: String(i.html_url ?? ""),
      score: similarity(draft, { title: String(i.title ?? ""), body: String(i.body ?? "") }),
    }))
    .filter((c) => c.score >= SHOW_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

/** The issue text as posted: the draft's body and the footer. */
export function issueBody(draft: IssueDraft): string {
  return `${draft.body.trim()}\n\n---\n${ISSUE_FOOTER}`;
}

/** Posts the draft as an issue. */
export async function postIssue(repo: Repo, draft: IssueDraft, opts: ApiOptions & { token: string }): Promise<{ number: number; url: string }> {
  const r = await githubApi(opts, "POST", `/repos/${repo.owner}/${repo.name}/issues`, { title: draft.title, body: issueBody(draft) });
  if (r.status === 201) return { number: Number(r.data.number), url: String(r.data.html_url) };
  if (r.status === 410) throw new GitHubError(`${repo.owner}/${repo.name} has issues turned off.`);
  if (r.status === 403 || r.status === 404) {
    throw new GitHubError(
      rateLimited(r) ? "GitHub rate limit reached; try again later." : `GITHUB_TOKEN may not open issues on ${repo.owner}/${repo.name} (${r.status}: ${apiMessage(r)}).`,
    );
  }
  throw new GitHubError(`Posting the issue failed (${r.status}: ${apiMessage(r)}).`);
}
