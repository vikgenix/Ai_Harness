import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFiles, MAX_RESULTS } from "../../src/tools/find_files.js";
import { ToolError } from "../../src/tools/types.js";

let base: string;
let root: string;
let gitRoot: string;
const run = (input: Parameters<typeof findFiles.run>[0], r = root) => findFiles.run(input, { root: r });

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "harness-find-"));
  root = path.join(base, "repo");
  for (const dir of ["src/lib", "tests/unit", "node_modules/dep", "config"]) await mkdir(path.join(root, dir), { recursive: true });
  for (const file of [
    "README.md",
    "src/app.py",
    "src/Config.ts",
    "src/lib/util.ts",
    "src/lib/util.js",
    "tests/unit/test_app.py",
    "tests/unit/test_util.ts",
    "config/settings.py",
    "node_modules/dep/index.js",
  ]) {
    await writeFile(path.join(root, file), "x\n");
  }
  await writeFile(path.join(base, "outside.py"), "x\n");
  await symlink(path.join(base, "outside.py"), path.join(root, "link.py"));

  gitRoot = path.join(base, "gitrepo");
  await mkdir(path.join(gitRoot, "build"), { recursive: true });
  await writeFile(path.join(gitRoot, ".gitignore"), "build/\n.env\n");
  for (const file of ["main.go", "extra.go", "build/gen.go", ".env"]) await writeFile(path.join(gitRoot, file), "x\n");
  execFileSync("git", ["init", "-q"], { cwd: gitRoot });
  execFileSync("git", ["add", "main.go", ".gitignore"], { cwd: gitRoot });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("find_files", () => {
  it("finds files by name glob at any depth, skipping dependencies and symlinks", async () => {
    expect(await run({ pattern: "*.py" })).toBe(["config/settings.py", "src/app.py", "tests/unit/test_app.py", "(3 files)"].join("\n"));
  });

  it("supports path globs, ** and {a,b}", async () => {
    expect(await run({ pattern: "src/**/*.ts" })).toBe("src/Config.ts\nsrc/lib/util.ts\n(2 files)");
    expect(await run({ pattern: "src/*.ts" })).toBe("src/Config.ts\n(1 file)");
    expect(await run({ pattern: "util.{js,ts}" })).toBe("src/lib/util.js\nsrc/lib/util.ts\n(2 files)");
    expect(await run({ pattern: "test_???.*" })).toBe("tests/unit/test_app.py\n(1 file)");
  });

  it("matches plain text anywhere in the path, ignoring case", async () => {
    expect(await run({ pattern: "config" })).toBe("config/settings.py\nsrc/Config.ts\n(2 files)");
    expect(await run({ pattern: "unit/test" })).toContain("(2 files)");
  });

  it("limits the search to a directory", async () => {
    expect(await run({ pattern: "*.ts", path: "tests" })).toBe("tests/unit/test_util.ts\n(1 file)");
    expect(await run({ pattern: "unit/*.py", path: "tests" })).toBe("tests/unit/test_app.py\n(1 file)");
  });

  it("says when nothing matched", async () => {
    expect(await run({ pattern: "*.rs" })).toBe('No files matching "*.rs" in the repository (8 files checked).');
  });

  it("respects .gitignore in git repositories, keeping untracked files", async () => {
    expect(await run({ pattern: "*" }, gitRoot)).toBe(".gitignore\nextra.go\nmain.go\n(3 files)");
  });

  it("caps the list", async () => {
    const many = path.join(base, "many");
    await mkdir(many);
    for (let i = 0; i < MAX_RESULTS + 5; i++) await writeFile(path.join(many, `f${String(i).padStart(3, "0")}.txt`), "");
    const out = await findFiles.run({ pattern: "*.txt" }, { root: many });
    expect(out.split("\n")).toHaveLength(MAX_RESULTS + 1);
    expect(out).toContain(`showing the first ${MAX_RESULTS} of ${MAX_RESULTS + 5} files`);
  });

  it.each([
    [{ pattern: " " }, "pattern must not be empty"],
    [{ pattern: "x", path: "nope" }, "directory not found: nope"],
    [{ pattern: "x", path: "src/app.py" }, "is a file, not a directory"],
    [{ pattern: "x", path: ".." }, "outside the repository"],
  ])("rejects %j", async (input, message) => {
    const err = await run(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain(message);
  });
});
