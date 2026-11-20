import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { branchName, commitMessage, completeFix, FixError, startFix } from "../../src/agent/fix.js";
import type { AgentResult } from "../../src/agent/loop.js";
import type { FixTask } from "../../src/agent/task.js";
import { emptyUsage } from "../../src/model/types.js";
import { makeSourceRepo } from "../helpers.js";

const issueTask: FixTask = {
  kind: "issue",
  issue: { ref: { owner: "acme", name: "widget", number: 12 }, title: "Crash on empty input", body: "", state: "open", url: "", labels: [], comments: [], moreComments: 0 },
};
const textTask: FixTask = { kind: "text", text: "Make the greeting LOUDER, please!" };

const result = (extra: Partial<AgentResult>): AgentResult => ({
  status: "finished",
  messages: [],
  steps: 3,
  usage: emptyUsage(),
  costUsd: 0,
  costIncomplete: false,
  finalText: "",
  ...extra,
});
const completed = (summary = "Handled empty input in src/app.py; added a test. pytest: 3 passed.") =>
  result({ finished: { outcome: "completed", summary } });

let base: string;
let source: string;
let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir }).toString().trim();
const savedEnv = { ...process.env };

beforeAll(async () => {
  // No global or system git config: the tests must not depend on this machine's identity or settings.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await mkdtemp(path.join(tmpdir(), "harness-fix-"));
  source = await makeSourceRepo(path.join(base, "source"));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

let n = 0;
beforeEach(() => {
  dir = path.join(base, `clone${n++}`);
  execFileSync("git", ["clone", "-q", source, dir]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("branchName and commitMessage", () => {
  it("names branches after the issue or the task's first words", () => {
    expect(branchName(issueTask)).toBe("shrike/fix-12");
    expect(branchName(textTask)).toBe("shrike/make-the-greeting-louder-please");
    expect(branchName({ kind: "text", text: "!!!" })).toBe("shrike/task");
  });

  it("writes a subject, the summary, and a closing reference for issues", () => {
    expect(commitMessage(issueTask, "Did it.\n")).toBe("Fix #12: Crash on empty input\n\nDid it.\n\nFixes #12");
    expect(commitMessage(textTask, "Did it.")).toBe("Fix: Make the greeting LOUDER, please!\n\nDid it.");
    expect(commitMessage({ kind: "text", text: "x".repeat(100) }, "s").split("\n")[0]).toHaveLength(72);
  });
});

describe("startFix", () => {
  it("creates a branch for the task from the current commit", async () => {
    const head = git("rev-parse", "HEAD");
    const fix = await startFix(dir, issueTask);
    expect(fix).toEqual({ branch: "shrike/fix-12", base: head, baseName: git("rev-parse", "--abbrev-ref", "origin/HEAD").replace("origin/", "") });
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("shrike/fix-12");
  });

  it("picks a new name when the branch exists, and starts from the default branch, not the previous fix", async () => {
    await startFix(dir, issueTask);
    await writeFile(path.join(dir, "first.txt"), "first fix\n");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "first fix");

    const second = await startFix(dir, issueTask);
    expect(second.branch).toBe("shrike/fix-12-2");
    expect(second.base).toBe(git("rev-parse", "origin/HEAD"));
    expect(git("ls-files")).not.toContain("first.txt");
  });

  it("refuses to start with uncommitted changes", async () => {
    await writeFile(path.join(dir, "README.md"), "changed\n");
    const err = await startFix(dir, issueTask).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FixError);
    expect((err as Error).message).toContain("uncommitted changes:\n M README.md");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).not.toContain("shrike/");
  });

  it("refuses a directory that is not a git repository", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "harness-plain-"));
    try {
      await expect(startFix(plain, issueTask)).rejects.toThrow("is not a git repository");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("completeFix", () => {
  it("commits all changes when the agent completed the task", async () => {
    const fix = await startFix(dir, issueTask);
    await writeFile(path.join(dir, "src/app.py"), "print('HI')\n");
    await writeFile(path.join(dir, "test_app.py"), "def test(): pass\n");

    const outcome = await completeFix(dir, fix, issueTask, completed());
    expect(outcome.committed).toBe(true);
    expect(outcome.files.sort()).toEqual(["src/app.py", "test_app.py"]);
    expect(outcome.message).toMatch(/^Committed [0-9a-f]+ on branch shrike\/fix-12 \(2 files: /);
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "-1", "--format=%B")).toBe(commitMessage(issueTask, completed().finished!.summary));
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("Shrike <shrike@localhost>"); // no identity configured
    expect(git("rev-parse", "HEAD~1")).toBe(fix.base);
  });

  it("never commits caches left by running tests, and lists new files individually", async () => {
    const fix = await startFix(dir, issueTask);
    await mkdir(path.join(dir, "src/__pycache__"), { recursive: true });
    await mkdir(path.join(dir, "node_modules/dep"), { recursive: true });
    await mkdir(path.join(dir, "tests/unit"), { recursive: true });
    await writeFile(path.join(dir, "src/__pycache__/app.cpython-312.pyc"), "junk");
    await writeFile(path.join(dir, "node_modules/dep/index.js"), "junk");
    await writeFile(path.join(dir, "src/app.pyc"), "junk");
    await writeFile(path.join(dir, "tests/unit/test_app.py"), "def test(): pass\n");

    const outcome = await completeFix(dir, fix, issueTask, completed());
    expect(outcome.files).toEqual(["tests/unit/test_app.py"]);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("tests/unit/test_app.py");
  });

  it("uses the configured git identity when there is one", async () => {
    git("config", "user.name", "Dev");
    git("config", "user.email", "dev@example.com");
    const fix = await startFix(dir, textTask);
    await writeFile(path.join(dir, "src/app.py"), "print('HI')\n");
    await completeFix(dir, fix, textTask, completed());
    expect(git("log", "-1", "--format=%an <%ae>")).toBe("Dev <dev@example.com>");
  });

  it("leaves changes uncommitted when the agent was blocked or stopped", async () => {
    const fix = await startFix(dir, issueTask);
    await writeFile(path.join(dir, "src/app.py"), "half done\n");
    const blocked = await completeFix(dir, fix, issueTask, result({ finished: { outcome: "blocked", summary: "no tests" } }));
    expect(blocked).toMatchObject({ committed: false, files: ["src/app.py"] });
    expect(blocked.message).toMatch(/^Not committed: the agent reported it was blocked\. 1 file changed on branch shrike\/fix-12/);

    const limited = await completeFix(dir, fix, issueTask, result({ status: "max_steps" }));
    expect(limited.message).toContain("the agent reached the step limit");
    expect(git("status", "--porcelain")).toBe("M src/app.py");
  });

  it("says when there was nothing to commit", async () => {
    const fix = await startFix(dir, issueTask);
    expect((await completeFix(dir, fix, issueTask, completed())).message).toContain("finished without changing any files");
    expect((await completeFix(dir, fix, issueTask, result({ status: "done" }))).message).toBe(
      "Not committed: the agent stopped without calling finish. No files were changed.",
    );
  });

  it("does not commit if the agent switched branches", async () => {
    const fix = await startFix(dir, issueTask);
    git("checkout", "-q", "-b", "elsewhere");
    await writeFile(path.join(dir, "x.txt"), "x\n");
    const outcome = await completeFix(dir, fix, issueTask, completed());
    expect(outcome.committed).toBe(false);
    expect(outcome.message).toContain("switched to 'elsewhere'");
  });
});
