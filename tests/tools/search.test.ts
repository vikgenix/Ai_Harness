import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globToRegExp, listFiles, matchesGlob } from "../../src/tools/files.js";
import { MAX_COUNTED, MAX_SHOWN, search } from "../../src/tools/search.js";
import { ToolError } from "../../src/tools/types.js";

let base: string;
let root: string; // plain directory: files are found by walking
let gitRoot: string; // git repository: .gitignore applies
const run = (input: Parameters<typeof search.run>[0], r = root) => search.run(input, { root: r });

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "harness-search-"));
  root = path.join(base, "repo");
  await mkdir(path.join(root, "src/lib"), { recursive: true });
  await mkdir(path.join(root, "node_modules/dep"), { recursive: true });
  await writeFile(
    path.join(root, "src/app.py"),
    ["import os", "", "def parse_args(argv):", "    return argv", "", "def parse_config(path):", "    # TODO: validate", "    return open(path).read()"].join("\n"),
  );
  await writeFile(path.join(root, "src/lib/util.ts"), "export function parseArgs() {}\n// todo later\n");
  await writeFile(path.join(root, "src/lib/util.js"), "function parseArgs() {}\n");
  await writeFile(path.join(root, "node_modules/dep/index.js"), "function parseArgs() {}\n");
  await writeFile(path.join(root, "data.bin"), Buffer.from([0x70, 0x61, 0x72, 0x73, 0x65, 0x00]));
  await writeFile(path.join(root, "notes.txt"), "price is $5 (approx.)\n" + "x".repeat(500) + " parse_here\n");
  await writeFile(path.join(base, "outside.py"), "def parse_secret(): pass\n");
  await symlink(path.join(base, "outside.py"), path.join(root, "link.py"));

  gitRoot = path.join(base, "gitrepo");
  await mkdir(path.join(gitRoot, "build"), { recursive: true });
  await writeFile(path.join(gitRoot, ".gitignore"), "build/\n*.log\n");
  await writeFile(path.join(gitRoot, "main.go"), "func needle() {}\n");
  await writeFile(path.join(gitRoot, "untracked.go"), "// needle too\n");
  await writeFile(path.join(gitRoot, "build/out.go"), "func needle() {}\n");
  await writeFile(path.join(gitRoot, "debug.log"), "needle\n");
  execFileSync("git", ["init", "-q"], { cwd: gitRoot });
  execFileSync("git", ["add", "main.go", ".gitignore"], { cwd: gitRoot });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("search", () => {
  it("finds regex matches as path:line: text, skipping dependencies, binaries and symlinks", async () => {
    expect(await run({ pattern: "def parse_\\w+" })).toBe(
      ["src/app.py:3: def parse_args(argv):", "src/app.py:6: def parse_config(path):", "(2 matches in 1 file)"].join("\n"),
    );
    expect(await run({ pattern: "parse" })).not.toMatch(/node_modules|data\.bin|link\.py/);
  });

  it("filters by glob and path", async () => {
    expect(await run({ pattern: "parseArgs", glob: "*.ts" })).toBe("src/lib/util.ts:1: export function parseArgs() {}\n(1 match in 1 file)");
    expect(await run({ pattern: "parseArgs", glob: "*.{js,ts}" })).toContain("(2 matches in 2 files)");
    expect(await run({ pattern: "parseArgs", glob: "src/**/*.js" })).toContain("src/lib/util.js:1:");
    expect(await run({ pattern: "parse", path: "src/lib" })).not.toContain("app.py");
    expect(await run({ pattern: "parse", path: "src/app.py" })).toContain("(2 matches in 1 file)");
  });

  it("supports case-insensitive and literal search", async () => {
    expect(await run({ pattern: "todo" })).toContain("(1 match in 1 file)");
    expect(await run({ pattern: "todo", case_insensitive: true })).toContain("(2 matches in 2 files)");
    expect(await run({ pattern: "$5 (approx.)", literal: true })).toContain("notes.txt:1: price is $5 (approx.)");
  });

  it("shows context lines grep-style, merging overlapping windows", async () => {
    expect(await run({ pattern: "def parse", context: 1, path: "src/app.py" })).toBe(
      [
        "src/app.py-2- ",
        "src/app.py:3: def parse_args(argv):",
        "src/app.py-4-     return argv",
        "src/app.py-5- ",
        "src/app.py:6: def parse_config(path):",
        "src/app.py-7-     # TODO: validate",
        "(2 matches in 1 file)",
      ].join("\n"),
    );
    const two = await run({ pattern: "import os|parseArgs", context: 1, glob: "*.{py,ts}" });
    expect(two).toContain("src/app.py-2- \n--\nsrc/lib/util.ts:1:");
  });

  it("cuts long lines", async () => {
    expect(await run({ pattern: "parse_here" })).toContain("… [cut]");
  });

  it("says when nothing matched", async () => {
    expect(await run({ pattern: "nothing_like_this", glob: "*.py" })).toBe(
      "No matches for /nothing_like_this/ in the repository (files matching *.py). 1 file searched.",
    );
  });

  it("caps the shown matches and stops counting at the limit", async () => {
    const many = path.join(base, "many");
    await mkdir(many);
    await writeFile(path.join(many, "a.txt"), "hit\n".repeat(MAX_COUNTED + 10));
    const out = await search.run({ pattern: "hit" }, { root: many });
    expect(out.split("\n")).toHaveLength(MAX_SHOWN + 1);
    expect(out).toContain(`showing the first ${MAX_SHOWN} of more than ${MAX_COUNTED} matches in 1 file`);
  });

  it("respects .gitignore in git repositories, including untracked files", async () => {
    const out = await run({ pattern: "needle" }, gitRoot);
    expect(out).toContain("main.go:1:");
    expect(out).toContain("untracked.go:1:");
    expect(out).not.toMatch(/build\/out\.go|debug\.log/);
  });

  it.each([
    [{ pattern: "(" }, "invalid regular expression"],
    [{ pattern: "" }, "pattern must not be empty"],
    [{ pattern: "x", path: "nope" }, "path not found: nope"],
    [{ pattern: "x", path: "../outside.py" }, "outside the repository"],
  ])("rejects %j", async (input, message) => {
    const err = await run(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain(message);
  });
});

describe("globs", () => {
  it.each([
    ["*.ts", "src/a.ts", true],
    ["*.ts", "src/a.tsx", false],
    ["*.{ts,tsx}", "deep/x/a.tsx", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/lib/a.ts", false],
    ["src/**/*.ts", "src/a.ts", true],
    ["src/**/*.ts", "src/lib/deep/a.ts", true],
    ["test_?.py", "tests/test_1.py", true],
    ["a.b", "axb", false],
  ])("%s vs %s -> %s", (glob, file, expected) => {
    expect(matchesGlob(glob, file)).toBe(expected);
  });

  it("matches path globs relative to the searched directory too", () => {
    expect(matchesGlob("lib/*.ts", "src/lib/a.ts", "src")).toBe(true);
  });

  it("escapes regex characters", () => {
    expect(globToRegExp("a+b(1).txt").test("a+b(1).txt")).toBe(true);
  });

  it("listFiles walks plain directories and asks git in repositories", async () => {
    const plain = await listFiles(root, root);
    expect(plain.source).toBe("walk");
    expect(plain.files).toContain("src/lib/util.ts");
    expect(plain.files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    const git = await listFiles(gitRoot, gitRoot);
    expect(git.source).toBe("git");
    expect(git.files).toEqual([".gitignore", "main.go", "untracked.go"]);
  });
});
