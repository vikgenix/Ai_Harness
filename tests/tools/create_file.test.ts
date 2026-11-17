import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFile, MAX_CREATE_BYTES } from "../../src/tools/create_file.js";
import { ToolError } from "../../src/tools/types.js";

let base: string;
let root: string;
const run = (input: Parameters<typeof createFile.run>[0]) => createFile.run(input, { root });
const read = (file: string) => readFile(path.join(root, file), "utf8");
const fail = async (input: Parameters<typeof createFile.run>[0]) => {
  const err = await run(input).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ToolError);
  return (err as Error).message;
};

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "harness-create-"));
  root = path.join(base, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "src/app.py"), "original\n");
  await mkdir(path.join(base, "outside"));
  await symlink(path.join(base, "outside"), path.join(root, "escape"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("create_file", () => {
  it("creates a file with the exact content", async () => {
    expect(await run({ path: "src/util.py", content: "def f():\n    return 1\n" })).toBe("Created src/util.py (2 lines, 22 bytes).");
    expect(await read("src/util.py")).toBe("def f():\n    return 1\n");
    expect((await stat(path.join(root, "src/util.py"))).mode & 0o111).toBe(0);
  });

  it("creates missing parent directories", async () => {
    expect(await run({ path: "tests/unit/test_util.py", content: "x = 1\n" })).toBe(
      "Created tests/unit/test_util.py (1 line, 6 bytes, created directory tests/unit/).",
    );
  });

  it("notes a missing final newline and allows empty files", async () => {
    expect(await run({ path: "a.txt", content: "one\ntwo" })).toBe("Created a.txt (2 lines, 7 bytes, no newline at end).");
    expect(await run({ path: "src/__init__.py", content: "" })).toBe("Created src/__init__.py (0 lines, 0 bytes).");
  });

  it("makes scripts with a shebang executable", async () => {
    await run({ path: "run.sh", content: "#!/bin/sh\necho hi\n" });
    expect((await stat(path.join(root, "run.sh"))).mode & 0o111).not.toBe(0);
  });

  it("never overwrites an existing file", async () => {
    expect(await fail({ path: "src/app.py", content: "new\n" })).toBe("src/app.py already exists; use edit_file to change it");
    expect(await read("src/app.py")).toBe("original\n");
  });

  it.each([
    [{ path: "src", content: "x" }, "src is a directory"],
    [{ path: "new/", content: "x" }, "must name a file"],
    [{ path: "src/app.py/x.py", content: "x" }, "src/app.py is a file"],
    [{ path: "../x.py", content: "x" }, "outside the repository"],
    [{ path: "escape/x.py", content: "x" }, "leads outside the repository"],
    [{ path: ".git/hooks/pre-commit", content: "x" }, "inside .git cannot be created"],
    [{ path: "big.txt", content: "x".repeat(MAX_CREATE_BYTES + 1) }, "content is too large"],
  ])("rejects %#", async (input, message) => {
    expect(await fail(input)).toContain(message);
  });
});
