import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloneError, cloneRepo, gitEnv, parseRepoUrl } from "../../src/repo/clone.js";
import { makeSourceRepo } from "../helpers.js";

let base: string;
let sourceUrl: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "harness-clone-"));
  sourceUrl = await makeSourceRepo(path.join(base, "demo-repo"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/owner/repo", "https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo.git", "https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo/tree/main/src?x=1", "https://github.com/owner/repo.git", "owner/repo"],
    ["https://user:secret@github.com/owner/repo", "https://github.com/owner/repo.git", "owner/repo"],
    ["owner/my.repo", "https://github.com/owner/my.repo.git", "owner/my.repo"],
    ["git@github.com:owner/repo.git", "git@github.com:owner/repo.git", "owner/repo"],
    ["https://gitlab.com/group/proj", "https://gitlab.com/group/proj.git", "gitlab.com/group/proj"],
  ])("%s", (input, cloneUrl, label) => {
    expect(parseRepoUrl(input)).toMatchObject({ cloneUrl, label });
  });

  it("accepts file:// URLs for local repositories", () => {
    expect(parseRepoUrl("file:///tmp/x/demo.git")).toMatchObject({ owner: "local", name: "demo", cloneUrl: "file:///tmp/x/demo.git" });
  });

  it.each(["", "hello", "https://example.com/a/b", "https://github.com/onlyowner", "../x/y", "owner/..", "a/b c", "owner/re$po"])(
    "rejects %j",
    (input) => {
      expect(parseRepoUrl(input)).toBeNull();
    },
  );
});

describe("cloneRepo", () => {
  it("clones shallowly into workspaces/<owner>__<name>, then reuses the clone", async () => {
    const workspacesDir = path.join(base, "ws1");
    const spec = parseRepoUrl(sourceUrl)!;

    const first = await cloneRepo(spec, { workspacesDir });
    expect(first.reused).toBe(false);
    expect(first.dir).toBe(path.join(workspacesDir, "local__demo-repo"));
    expect(readFileSync(path.join(first.dir, "src/app.py"), "utf8")).toBe("print('hi')\n");
    const commits = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: first.dir }).toString().trim();
    expect(commits).toBe("1"); // --depth 1
    expect(readdirSync(workspacesDir)).toEqual(["local__demo-repo"]); // no partial dir left

    const second = await cloneRepo(spec, { workspacesDir });
    expect(second).toMatchObject({ dir: first.dir, reused: true });
  });

  it("reports a missing repository clearly and leaves nothing behind", async () => {
    const workspacesDir = path.join(base, "ws2");
    const spec = parseRepoUrl(pathToFileURL(path.join(base, "does-not-exist")).href)!;
    const err = await cloneRepo(spec, { workspacesDir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloneError);
    expect((err as Error).message).toMatch(/Could not clone local\/does-not-exist/);
    expect(readdirSync(workspacesDir)).toEqual([]);
  });

  it("can be cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    const err = await cloneRepo(parseRepoUrl(sourceUrl)!, { workspacesDir: path.join(base, "ws3"), signal: abort.signal }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("Clone cancelled.");
    expect(existsSync(path.join(base, "ws3", "local__demo-repo"))).toBe(false);
  });
});

describe("gitEnv", () => {
  it("never prompts, and passes a GitHub token as a one-off header", () => {
    const gh = parseRepoUrl("owner/repo")!;
    const env = gitEnv(gh, "tok123");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:tok123").toString("base64")}`);
  });

  it("does not send the GitHub token to other hosts or without a token", () => {
    expect(gitEnv(parseRepoUrl("https://gitlab.com/a/b")!, "tok123").GIT_CONFIG_COUNT).toBeUndefined();
    expect(gitEnv(parseRepoUrl("owner/repo")!, undefined).GIT_CONFIG_COUNT).toBeUndefined();
  });
});
