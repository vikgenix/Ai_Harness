import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findDuplicates, ISSUE_FOOTER, issueBody, listOpenIssues, postIssue, searchQuery, similarity, words, type IssueDraft } from "../../src/github/audit.js";
import { fakeGitHub, type FakeGitHubOptions } from "./fake-github.js";

const savedEnv = { ...process.env };
let base: string;
let n = 0;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await realpath(await mkdtemp(path.join(tmpdir(), "harness-audit-gh-")));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

const setup = (opts: FakeGitHubOptions = {}) => fakeGitHub(path.join(base, `gh${n++}`), opts);
const repo = { owner: "acme", name: "demo" };
const draft: IssueDraft = {
  title: "parse_date() returns None for ISO dates ending in Z",
  body: "parse_date('2024-01-01T00:00:00Z') returns None.\n\n**Where**: src/dates.py:12",
  severity: "medium",
  confidence: "confirmed",
  files: ["src/dates.py"],
};

describe("similarity", () => {
  it("splits identifiers, drops stopwords and short words, and stems lightly", () => {
    expect([...words("parseDate crashes when the_input_value is EMPTY")]).toEqual(["parse", "date", "crash", "input", "value", "empty"]);
  });

  it("scores issues about the same thing high, others low", () => {
    expect(similarity(draft, { title: "parse_date crashes on ISO dates ending in Z", body: "parse_date('2024-01-01T00:00:00Z') fails." })).toBeGreaterThanOrEqual(0.6);
    expect(similarity(draft, { title: "Docs: typo in the README install section" })).toBeLessThan(0.1);
  });

  it("searches for the title's words with OR, in this repository's issues", () => {
    expect(searchQuery(repo, draft)).toBe("repo:acme/demo is:issue parse OR date OR return OR none OR iso");
  });
});

describe("GitHub calls", () => {
  it("lists open issues without pull requests", async () => {
    const gh = await setup();
    expect(await listOpenIssues(repo, { fetchImpl: gh.fetchImpl, apiBase: gh.hosts.apiBase })).toEqual([
      { number: 15, title: "Docs: typo in the README install section", state: "open", url: "https://github.com/acme/demo/issues/15" },
    ]);
  });

  it("finds likely duplicates among open and closed issues", async () => {
    const gh = await setup();
    const found = await findDuplicates(repo, draft, { fetchImpl: gh.fetchImpl, apiBase: gh.hosts.apiBase });
    expect(found.map((c) => [c.number, c.state])).toEqual([[12, "closed"]]); // the pull request and the unrelated issue are left out
    expect(found[0]!.score).toBeGreaterThanOrEqual(0.6);
    expect(gh.calls[0]!.path).toBe(`/search/issues?${new URLSearchParams({ q: searchQuery(repo, draft), per_page: "20" })}`);
  });

  it("says when the search is rate limited", async () => {
    const gh = await setup({ searchStatus: 403 });
    await expect(findDuplicates(repo, draft, { fetchImpl: gh.fetchImpl, apiBase: gh.hosts.apiBase })).rejects.toThrow("GitHub's search rate limit was reached");
  });

  it("posts an issue with the footer, and explains refusals", async () => {
    const gh = await setup();
    const opts = { token: "ghp_x", fetchImpl: gh.fetchImpl, apiBase: gh.hosts.apiBase };
    expect(await postIssue(repo, draft, opts)).toEqual({ number: 99, url: "https://github.com/acme/demo/issues/99" });
    expect(gh.calls.at(-1)).toMatchObject({ method: "POST", path: "/repos/acme/demo/issues", body: { title: draft.title, body: issueBody(draft) }, auth: "Bearer ghp_x" });
    expect(issueBody(draft).endsWith(`\n\n---\n${ISSUE_FOOTER}`)).toBe(true);

    const refused = await setup({ issueReply: { status: 403, message: "Resource not accessible by integration" } });
    await expect(postIssue(repo, draft, { ...opts, fetchImpl: refused.fetchImpl })).rejects.toThrow("GITHUB_TOKEN may not open issues on acme/demo (403: Resource not accessible by integration)");
    const off = await setup({ issueReply: { status: 410, message: "Issues are disabled" } });
    await expect(postIssue(repo, draft, { ...opts, fetchImpl: off.fetchImpl })).rejects.toThrow("acme/demo has issues turned off.");
  });
});
