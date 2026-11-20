import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeSourceRepo } from "../helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd }).toString().trim();

export interface FakeGitHubOptions {
  /** Whether the token may push to acme/demo (else the harness forks to me/demo). */
  canPush?: boolean;
  /** Status and message for opening a pull request, instead of 201. */
  pullsReply?: { status: number; message: string }[];
  /** Status for posting an issue, instead of 201. */
  issueReply?: { status: number; message: string };
  /** Status for the issue search, instead of 200. */
  searchStatus?: number;
}

/** The issues acme/demo already has (#12 is closed, #20 is a pull request). */
export const KNOWN_ISSUES = [
  { number: 12, title: "parse_date crashes on ISO dates ending in Z", state: "closed", body: "Calling parse_date('2024-01-01T00:00:00Z') fails.", html_url: "https://github.com/acme/demo/issues/12" },
  { number: 15, title: "Docs: typo in the README install section", state: "open", body: "", html_url: "https://github.com/acme/demo/issues/15" },
  { number: 20, title: "Fix parse_date for Z suffix", state: "open", body: "", html_url: "https://github.com/acme/demo/pull/20", pull_request: {} },
];

export interface ApiCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  auth?: string;
}

/**
 * A pretend GitHub: bare repositories in `<dir>/gh/<owner>/<name>.git` play the
 * git host (webBase is its file:// URL), and fetchImpl plays the REST API for
 * acme/demo and the fork me/demo. `clone` is a shallow clone of acme/demo with
 * a GitHub origin URL, checked out on a fix branch with one fix commit.
 */
export async function fakeGitHub(dir: string, opts: FakeGitHubOptions = {}) {
  const source = path.join(dir, "source");
  await makeSourceRepo(source);
  const gh = path.join(dir, "gh");
  await mkdir(path.join(gh, "acme"), { recursive: true });
  await mkdir(path.join(gh, "me"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", source, path.join(gh, "acme", "demo.git")]);
  const base = git(source, "rev-parse", "--abbrev-ref", "HEAD");

  const clone = path.join(dir, "clone");
  execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(path.join(gh, "acme", "demo.git")).href, clone]);
  git(clone, "remote", "set-url", "origin", "https://github.com/acme/demo.git");
  git(clone, "checkout", "-q", "-b", "shrike/fix-7");
  await writeFile(path.join(clone, "loud.py"), "print('HI')\n");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "Fix #7: Greeting is too quiet\n\nMade the greeting loud. Tests: none.\n\nFixes #7");

  const calls: ApiCall[] = [];
  const pullsReply = [...(opts.pullsReply ?? [])];
  let forked = false;
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: `${u.pathname}${u.search}`, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const route = `${method} ${u.pathname}`;
    if (route === "GET /repos/acme/demo") return json(200, { full_name: "acme/demo", default_branch: base, permissions: { push: opts.canPush ?? true } });
    if (route === "POST /repos/acme/demo/forks") {
      if (!forked) execFileSync("git", ["clone", "-q", "--bare", path.join(gh, "acme", "demo.git"), path.join(gh, "me", "demo.git")]);
      forked = true;
      return json(202, { name: "demo", owner: { login: "me" } });
    }
    if (route === "GET /repos/me/demo") return forked ? json(200, { full_name: "me/demo" }) : json(404, { message: "Not Found" });
    if (route === "POST /repos/acme/demo/pulls") {
      const reply = pullsReply.shift();
      if (reply) return json(reply.status, { message: "Validation Failed", errors: [{ message: reply.message }] });
      return json(201, { number: 42, html_url: "https://github.com/acme/demo/pull/42", draft: body?.draft });
    }
    if (route === "GET /repos/acme/demo/pulls") return json(200, [{ number: 41, html_url: "https://github.com/acme/demo/pull/41", draft: false }]);
    if (route === "GET /repos/acme/demo/issues") return json(200, KNOWN_ISSUES.filter((i) => i.state === "open"));
    if (route === "GET /search/issues") {
      if (opts.searchStatus) return json(opts.searchStatus, { message: "API rate limit exceeded" });
      return json(200, { total_count: KNOWN_ISSUES.length, items: KNOWN_ISSUES });
    }
    if (route === "POST /repos/acme/demo/issues") {
      if (opts.issueReply) return json(opts.issueReply.status, { message: opts.issueReply.message });
      return json(201, { number: 99, html_url: "https://github.com/acme/demo/issues/99" });
    }
    return json(404, { message: `no route for ${route}` });
  }) as typeof fetch;

  return {
    clone,
    base,
    calls,
    fetchImpl,
    hosts: { webBase: pathToFileURL(gh).href.replace(/\/$/, ""), apiBase: "https://api.fake", forkPollMs: 1 },
    /** Branches of a pretend-GitHub repository. */
    branches: (owner: string) => git(path.join(gh, owner, "demo.git"), "branch", "--format=%(refname:short)").split("\n").filter(Boolean),
    /** Puts a different commit on a branch of acme/demo, as if someone had pushed one there. */
    occupy: (branch: string) => {
      const other = path.join(dir, "other");
      execFileSync("git", ["clone", "-q", pathToFileURL(path.join(gh, "acme", "demo.git")).href, other]);
      git(other, "checkout", "-q", "-b", branch);
      git(other, "commit", "-q", "--allow-empty", "-m", "someone else's work");
      git(other, "push", "-q", "origin", branch);
    },
  };
}
