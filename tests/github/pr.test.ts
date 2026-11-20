import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubError } from "../../src/github/issues.js";
import { describePlan, describePullRequest, planPullRequest, PR_FOOTER, pushAndOpenPullRequest } from "../../src/github/pr.js";
import { fakeGitHub, type FakeGitHubOptions } from "./fake-github.js";

const savedEnv = { ...process.env };
let base: string;
let n = 0;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await realpath(await mkdtemp(path.join(tmpdir(), "harness-pr-")));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

const setup = (opts: FakeGitHubOptions = {}) => fakeGitHub(path.join(base, `gh${n++}`), opts);
const TOKEN = "ghp_test_token_123";

describe("planPullRequest", () => {
  it("takes the title and body from the fix commit", async () => {
    const gh = await setup();
    const plan = await planPullRequest(gh.clone, { draft: true });
    expect(plan).toEqual({
      repo: { owner: "acme", name: "demo" },
      branch: "harness/fix-7",
      base: gh.base,
      commits: 1,
      title: "Fix #7: Greeting is too quiet",
      body: `Made the greeting loud. Tests: none.\n\nFixes #7\n\n---\n${PR_FOOTER}`,
      draft: true,
    });
    expect(describePlan(plan)).toBe(
      [
        "Pull request to acme/demo (draft):",
        `  harness/fix-7 → ${gh.base} (1 commit)`,
        "  Title: Fix #7: Greeting is too quiet",
        "  │ Made the greeting loud. Tests: none.",
        "  │ ",
        "  │ Fixes #7",
        "  │ ",
        "  │ ---",
        `  │ ${PR_FOOTER}`,
      ].join("\n"),
    );
  });

  it("says why there is nothing to open", async () => {
    const gh = await setup();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: gh.clone });
    git("checkout", "-q", gh.base);
    await expect(planPullRequest(gh.clone, { draft: true })).rejects.toThrow(`The checked-out branch is '${gh.base}', not a fix branch (harness/...)`);
    git("checkout", "-q", "-b", "harness/empty");
    await expect(planPullRequest(gh.clone, { draft: true })).rejects.toThrow("harness/empty has no commits that are not on");
    git("remote", "set-url", "origin", "https://gitlab.com/acme/demo.git");
    await expect(planPullRequest(gh.clone, { draft: true })).rejects.toThrow(/did not come from GitHub/);
  });
});

describe("pushAndOpenPullRequest", () => {
  it("pushes to the repository when the token may, and opens a draft pull request", async () => {
    const gh = await setup();
    const plan = await planPullRequest(gh.clone, { draft: true });
    const pr = await pushAndOpenPullRequest(gh.clone, plan, { token: TOKEN, fetchImpl: gh.fetchImpl, ...gh.hosts });

    expect(pr).toEqual({ url: "https://github.com/acme/demo/pull/42", number: 42, pushedTo: "acme/demo:harness/fix-7", created: true, draft: true });
    expect(gh.branches("acme")).toContain("harness/fix-7");
    const open = gh.calls.find((c) => c.method === "POST" && c.path === "/repos/acme/demo/pulls")!;
    expect(open.body).toEqual({ title: plan.title, body: plan.body, head: "harness/fix-7", base: gh.base, draft: true, maintainer_can_modify: true });
    expect(open.auth).toBe(`Bearer ${TOKEN}`);
    expect(await readFile(path.join(gh.clone, ".git/config"), "utf8")).not.toContain(TOKEN); // never saved in the clone
    expect(describePullRequest(pr)).toBe("Pushed to acme/demo:harness/fix-7. Opened draft pull request #42: https://github.com/acme/demo/pull/42");
  });

  it("forks when the token may not push, and opens the pull request from the fork", async () => {
    const gh = await setup({ canPush: false });
    const pr = await pushAndOpenPullRequest(gh.clone, await planPullRequest(gh.clone, { draft: false }), { token: TOKEN, fetchImpl: gh.fetchImpl, ...gh.hosts });
    expect(pr).toMatchObject({ pushedTo: "me/demo:harness/fix-7", fork: "me/demo", created: true, draft: false });
    expect(gh.branches("me")).toContain("harness/fix-7");
    expect(gh.branches("acme")).not.toContain("harness/fix-7");
    expect(gh.calls.find((c) => c.path === "/repos/acme/demo/pulls")?.body).toMatchObject({ head: "me:harness/fix-7", draft: false });
    expect(describePullRequest(pr)).toMatch(/^Pushed to me\/demo:harness\/fix-7 \(your fork\)\. Opened pull request #42/);
  });

  it("never overwrites someone else's branch: takes the next free name", async () => {
    const gh = await setup();
    gh.occupy("harness/fix-7");
    const pr = await pushAndOpenPullRequest(gh.clone, await planPullRequest(gh.clone, { draft: true }), { token: TOKEN, fetchImpl: gh.fetchImpl, ...gh.hosts });
    expect(pr.pushedTo).toBe("acme/demo:harness/fix-7-2");
    expect(gh.calls.find((c) => c.path === "/repos/acme/demo/pulls")?.body?.head).toBe("harness/fix-7-2");
  });

  it("finds the pull request already open for the branch", async () => {
    const gh = await setup({ pullsReply: [{ status: 422, message: "A pull request already exists for acme:harness/fix-7." }] });
    const pr = await pushAndOpenPullRequest(gh.clone, await planPullRequest(gh.clone, { draft: true }), { token: TOKEN, fetchImpl: gh.fetchImpl, ...gh.hosts });
    expect(pr).toMatchObject({ number: 41, created: false });
    expect(gh.calls.at(-1)?.path).toBe(`/repos/acme/demo/pulls?state=open&head=${encodeURIComponent("acme:harness/fix-7")}`);
    expect(describePullRequest(pr)).toBe("Pushed to acme/demo:harness/fix-7. Pull request #41 was already open: https://github.com/acme/demo/pull/41");
  });

  it("opens a normal pull request where drafts are not allowed", async () => {
    const gh = await setup({ pullsReply: [{ status: 422, message: "Draft pull requests are not supported in this repository." }] });
    const pr = await pushAndOpenPullRequest(gh.clone, await planPullRequest(gh.clone, { draft: true }), { token: TOKEN, fetchImpl: gh.fetchImpl, ...gh.hosts });
    expect(pr).toMatchObject({ number: 42, draft: false });
    expect(gh.calls.filter((c) => c.method === "POST" && c.path === "/repos/acme/demo/pulls").map((c) => c.body?.draft)).toEqual([true, false]);
  });

  it("says what happened when the pull request cannot be opened", async () => {
    const gh = await setup({ pullsReply: [{ status: 403, message: "Resource not accessible by personal access token" }] });
    const attempt = pushAndOpenPullRequest(gh.clone, await planPullRequest(gh.clone, { draft: false }), { token: TOKEN, fetchImpl: gh.fetchImpl, ...gh.hosts });
    await expect(attempt).rejects.toThrow(GitHubError);
    await expect(attempt).rejects.toThrow("The branch was pushed to acme/demo:harness/fix-7, but GITHUB_TOKEN may not open pull requests on acme/demo (403: Validation Failed: Resource not accessible by personal access token).");
    await expect(
      pushAndOpenPullRequest(gh.clone, await planPullRequest(gh.clone, { draft: false }), { token: TOKEN, fetchImpl: gh.fetchImpl, ...gh.hosts }),
    ).resolves.toMatchObject({ number: 42 }); // the replies ran out: the second try works, and the branch is not pushed twice under new names
    expect(gh.branches("acme").filter((b) => b.startsWith("harness/"))).toEqual(["harness/fix-7"]);
  });
});
