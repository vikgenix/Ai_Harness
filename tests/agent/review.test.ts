import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFix, type FixBranch } from "../../src/agent/fix.js";
import { collectChanges, createSelfReview, findProblems, MAX_REVIEW_DIFF_CHARS, patchLines, reviewMessage, type Changes } from "../../src/agent/review.js";
import type { FixTask } from "../../src/agent/task.js";

const task: FixTask = { kind: "text", text: "make it louder" };
const savedEnv = { ...process.env };
let base: string;
let source: string;
let dir: string;
let n = 0;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir }).toString();
const write = async (file: string, content: string) => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), content);
};

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await mkdtemp(path.join(tmpdir(), "harness-review-"));
  source = path.join(base, "source");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "tests"), { recursive: true });
  await writeFile(path.join(source, "src/app.py"), "def greet(name):\n    return 'hi ' + name\n");
  await writeFile(path.join(source, "src/util.py"), "def add(a, b):\n    return a + b\n");
  await writeFile(path.join(source, "tests/test_app.py"), "from app import greet\n\ndef test_greet():\n    assert greet('a') == 'hi a'\n\ndef test_other():\n    assert True\n");
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: source });
  g("init", "-q");
  g("add", ".");
  g("commit", "-qm", "init");
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

let fix: FixBranch;
beforeEach(async () => {
  dir = path.join(base, `clone${n++}`);
  execFileSync("git", ["clone", "-q", source, dir]);
  fix = await startFix(dir, task);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectChanges", () => {
  it("lists changed, new and deleted files with their diff, without touching the index", async () => {
    await write("src/app.py", "def greet(name):\n    return 'HI ' + name.upper()\n");
    await write("src/new_helper.py", "X = 1\n");
    await unlink(path.join(dir, "src/util.py"));
    await write("src/__pycache__/app.cpython-312.pyc", "junk");

    const changes = await collectChanges(dir, fix);
    expect(changes.files).toEqual([
      { path: "src/app.py", status: "M", added: 1, removed: 1, whitespaceOnly: false },
      { path: "src/new_helper.py", status: "A", added: 1, removed: 0, whitespaceOnly: false },
      { path: "src/util.py", status: "D", added: 0, removed: 2, whitespaceOnly: false },
    ]);
    expect(changes.patch).toContain("+    return 'HI ' + name.upper()");
    expect(changes.patch).toContain("+++ b/src/new_helper.py");
    expect(git("diff", "--cached", "--name-only")).toBe(""); // the real index is untouched
    expect(git("status", "--porcelain")).toContain("?? src/new_helper.py");
  });

  it("spots files that only changed in whitespace", async () => {
    await write("src/util.py", "def add(a,  b):\n    return a  +  b\n");
    const changes = await collectChanges(dir, fix);
    expect(changes.files[0]).toMatchObject({ path: "src/util.py", whitespaceOnly: true });
  });
});

describe("patchLines", () => {
  it("gives added lines their line number in the new file", () => {
    const patch = ["--- a/x.py", "+++ b/x.py", "@@ -1,3 +1,4 @@", " a", "-b", "+B", "+c", " d", "@@ -10,1 +11,1 @@", "-y", "+z"].join("\n");
    expect(patchLines(patch).map((l) => `${l.kind}${l.file}:${l.line} ${l.text}`)).toEqual(["-x.py:2 b", "+x.py:2 B", "+x.py:3 c", "-x.py:11 y", "+x.py:11 z"]);
  });
});

describe("findProblems", () => {
  const changes = (files: Changes["files"], patch: string): Changes => ({ files, patch });
  const file = (p: string, status = "M", added = 1, removed = 0) => ({ path: p, status, added, removed, whitespaceOnly: false });
  const diffOf = (p: string, lines: string[]) => [`--- a/${p}`, `+++ b/${p}`, "@@ -1,1 +1,9 @@", ...lines].join("\n");

  it("finds debugging leftovers in code, but allows prints in tests", () => {
    const patch = [
      diffOf("src/app.py", ["+    print('DEBUG', x)", "+    breakpoint()", "+    # TODO handle None"]),
      diffOf("tests/test_app.py", ["+    print(result)", "+    assert greet('') == ''"]),
    ].join("\n");
    const found = findProblems(changes([file("src/app.py"), file("tests/test_app.py")], patch));
    expect(found).toEqual([
      "Added debugger call (remove it unless the fix needs it): src/app.py:2 `breakpoint()`",
      "Added print/log statement (remove it unless the fix needs it): src/app.py:1 `print('DEBUG', x)`",
      "Added TODO/FIXME note (remove it unless the fix needs it): src/app.py:3 `# TODO handle None`",
    ]);
  });

  it("finds scratch files, formatting-only files and a missing test", () => {
    const found = findProblems(
      changes([file("repro_issue.py", "A"), file("src/app.py"), { ...file("src/util.py"), whitespaceOnly: true }, file("src/app.py.orig", "A")], ""),
    );
    expect(found).toEqual([
      "New file that looks temporary (delete it, or keep it only as a real test): repro_issue.py; src/app.py.orig",
      "Only whitespace or formatting changed (revert these files): src/util.py",
      "No test file was added or changed. Add a regression test in the project's test suite, or say in the summary why there is none.",
    ]);
  });

  it("finds deleted and weakened tests", () => {
    const patch = diffOf("tests/test_app.py", ["-def test_other():", "-    assert True", "+    pass"]);
    const found = findProblems(changes([file("tests/test_app.py", "M", 1, 2), file("tests/test_old.py", "D", 0, 9), file("src/app.py")], patch));
    expect(found).toEqual([
      "Test file deleted (tests must not be removed to make the suite pass): tests/test_old.py",
      "Tests lost 2 assertion lines: make sure no existing test was deleted or weakened.",
    ]);
  });

  it("finds nothing in a clean fix with a test", () => {
    const patch = [diffOf("src/app.py", ["+    if not name: return ''"]), diffOf("tests/test_app.py", ["+def test_empty():", "+    assert greet('') == ''"])].join("\n");
    expect(findProblems(changes([file("src/app.py"), file("tests/test_app.py")], patch))).toEqual([]);
  });

  it("notices when many files changed", () => {
    const files = Array.from({ length: 9 }, (_, i) => file(`src/m${i}.py`));
    expect(findProblems(changes([...files, file("tests/test_x.py")], ""))).toEqual(["9 non-test files changed: make sure each one is needed for this task."]);
  });
});

describe("reviewMessage", () => {
  const fixInfo: FixBranch = { branch: "shrike/x", base: "abc", baseName: "main" };

  it("shows the changes, the findings, a checklist and the diff", () => {
    const message = reviewMessage({ files: [{ path: "src/app.py", status: "M", added: 2, removed: 1, whitespaceOnly: false }], patch: "+x" }, ["Something to check"], fixInfo, 1);
    expect(message).toMatch(/^Self-review: your finish call was held back/);
    expect(message).toContain("Changes since main: 1 file, +2 -1\n  M src/app.py (+2 -1)");
    expect(message).toContain("Automatic checks found:\n- Something to check");
    expect(message).toContain("call finish again");
    expect(message).toMatch(/<diff>\n\+x\n<\/diff>$/);
  });

  it("cuts a huge diff and handles no changes", () => {
    const long = reviewMessage({ files: [{ path: "a", status: "M", added: 1, removed: 0, whitespaceOnly: false }], patch: "x".repeat(MAX_REVIEW_DIFF_CHARS + 10) }, [], fixInfo, 2);
    expect(long).toMatch(/^Self-review \(round 2\)/);
    expect(long).toContain("Automatic checks found nothing.");
    expect(long).toContain("… (diff cut: 10 more characters");
    expect(reviewMessage({ files: [], patch: "" }, [], fixInfo, 1)).toContain("no file has changed since the task started");
  });
});

describe("createSelfReview", () => {
  const completed = { outcome: "completed" as const, summary: "done" };

  it("reviews the first completed finish, then accepts", async () => {
    const review = createSelfReview(dir, fix);
    expect(await review.check({ outcome: "blocked", summary: "stuck" })).toBeUndefined();

    await write("src/app.py", "def greet(name):\n    return 'HI ' + name\n");
    const first = await review.check(completed);
    expect(first?.note).toBe("Self-review: 1 file changed, 1 to check (No test file was added or changed).");
    expect(first?.message).toContain("-    return 'hi ' + name\n+    return 'HI ' + name");

    expect(await review.check(completed)).toBeUndefined(); // nothing changed since the review
    expect(review.rounds).toBe(1);
    expect(review.findings).toHaveLength(1);
  });

  it("reviews again only if the agent changed files and problems remain, at most twice", async () => {
    const review = createSelfReview(dir, fix);
    await write("src/app.py", "def greet(name):\n    print(name)\n    return 'HI ' + name\n");
    expect(await review.check(completed)).toBeDefined();

    await write("src/app.py", "def greet(name):\n    print('x', name)\n    return 'HI ' + name\n");
    expect((await review.check(completed))?.message).toMatch(/^Self-review \(round 2\)/);

    await write("src/app.py", "def greet(name):\n    print('y', name)\n    return 'HI ' + name\n");
    expect(await review.check(completed)).toBeUndefined(); // the limit
    expect(review.rounds).toBe(2);
  });

  it("accepts a changed, clean fix after the first review", async () => {
    const review = createSelfReview(dir, fix);
    await write("src/app.py", "def greet(name):\n    print(name)\n    return 'HI ' + name\n");
    expect(await review.check(completed)).toBeDefined();
    await write("src/app.py", "def greet(name):\n    return 'HI ' + name\n");
    await write("tests/test_app.py", "from app import greet\n\ndef test_greet():\n    assert greet('a') == 'HI a'\n\ndef test_other():\n    assert True\n");
    expect(await review.check(completed)).toBeUndefined();
  });
});
