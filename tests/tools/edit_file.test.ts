import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { editFile } from "../../src/tools/edit_file.js";
import { ToolError } from "../../src/tools/types.js";

let base: string;
let root: string;
const run = (input: Parameters<typeof editFile.run>[0]) => editFile.run(input, { root });
const read = (file: string) => readFile(path.join(root, file), "utf8");
const fail = async (input: Parameters<typeof editFile.run>[0]) => {
  const err = await run(input).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ToolError);
  return (err as Error).message;
};

const APP = ["def add(a, b):", "    return a + b", "", "", "def sub(a, b):", "    return a - b", "", "", "def main():", "    print(add(1, 2))", ""].join("\n");

beforeEach(async () => {
  if (base) await rm(base, { recursive: true, force: true });
  base = await mkdtemp(path.join(tmpdir(), "harness-edit-"));
  root = path.join(base, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "src/app.py"), APP);
  await writeFile(path.join(root, ".git/config"), "[core]\n");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("edit_file", () => {
  it("replaces a unique string and shows the edited lines with context", async () => {
    const out = await run({ path: "src/app.py", old_string: "    return a - b", new_string: "    # subtract\n    return a - b" });
    expect(out).toBe(
      [
        "Edited src/app.py: replaced 1 occurrence.",
        " 3\t",
        " 4\t",
        " 5\tdef sub(a, b):",
        " 6\t    # subtract",
        " 7\t    return a - b",
        " 8\t",
        " 9\t",
        "10\tdef main():",
      ].join("\n"),
    );
    expect(await read("src/app.py")).toBe(APP.replace("    return a - b", "    # subtract\n    return a - b"));
  });

  it("deletes text with an empty new_string", async () => {
    await run({ path: "src/app.py", old_string: "def sub(a, b):\n    return a - b\n\n\n", new_string: "" });
    expect(await read("src/app.py")).not.toContain("sub");
  });

  it("refuses an ambiguous old_string and lists where it occurs", async () => {
    const message = await fail({ path: "src/app.py", old_string: "(a, b):", new_string: "(x, y):" });
    expect(message).toContain("occurs 2 times in src/app.py (lines 1, 5)");
    expect(await read("src/app.py")).toBe(APP); // unchanged
  });

  it("replaces every occurrence with replace_all", async () => {
    const out = await run({ path: "src/app.py", old_string: "(a, b):", new_string: "(x, y):", replace_all: true });
    expect(out).toContain("replaced 2 occurrences.");
    expect(out).toContain("(other replacements at lines 5)");
    expect((await read("src/app.py")).match(/\(x, y\):/g)).toHaveLength(2);
  });

  it("explains a miss caused by different indentation", async () => {
    const message = await fail({ path: "src/app.py", old_string: "def main():\n  print(add(1, 2))", new_string: "x" });
    expect(message).toContain("different whitespace or indentation at line 9");
  });

  it("explains a miss caused by copied line numbers", async () => {
    const message = await fail({ path: "src/app.py", old_string: " 9\tdef main():\n10\t    print(add(1, 2))", new_string: "x" });
    expect(message).toContain("remove the \"N<tab>\" prefixes");
  });

  it("keeps CRLF line endings", async () => {
    await writeFile(path.join(root, "win.txt"), "one\r\ntwo\r\nthree\r\n");
    await run({ path: "win.txt", old_string: "one\ntwo", new_string: "one\nTWO\nmore" });
    expect(await read("win.txt")).toBe("one\r\nTWO\r\nmore\r\nthree\r\n");
  });

  it("keeps the file mode and leaves no temporary file", async () => {
    await writeFile(path.join(root, "run.sh"), "echo hi\n");
    await chmod(path.join(root, "run.sh"), 0o755);
    await run({ path: "run.sh", old_string: "hi", new_string: "hello" });
    expect((await stat(path.join(root, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await readdir(root)).filter((f) => f.includes("harness"))).toEqual([]);
  });

  it("edits the target of a symlink inside the repository, keeping the link", async () => {
    await symlink("src/app.py", path.join(root, "link.py"));
    await run({ path: "link.py", old_string: "def main", new_string: "def start" });
    expect(await read("src/app.py")).toContain("def start");
    expect((await readdir(root, { withFileTypes: true })).find((e) => e.name === "link.py")!.isSymbolicLink()).toBe(true);
  });

  it.each([
    [{ path: "nope.py", old_string: "a", new_string: "b" }, "file not found: nope.py"],
    [{ path: "src", old_string: "a", new_string: "b" }, "src is not a file"],
    [{ path: "src/app.py", old_string: "", new_string: "b" }, "old_string must not be empty"],
    [{ path: "src/app.py", old_string: "a", new_string: "a" }, "nothing to change"],
    [{ path: "src/app.py", old_string: "missing", new_string: "b" }, "old_string was not found in src/app.py"],
    [{ path: "../outside.py", old_string: "a", new_string: "b" }, "outside the repository"],
    [{ path: ".git/config", old_string: "core", new_string: "x" }, "inside .git cannot be edited"],
  ])("rejects %j", async (input, message) => {
    expect(await fail(input)).toContain(message);
  });

  it("refuses binary files", async () => {
    await writeFile(path.join(root, "img.bin"), Buffer.from([0x61, 0x00, 0x62]));
    expect(await fail({ path: "img.bin", old_string: "a", new_string: "b" })).toContain("binary file");
  });
});
