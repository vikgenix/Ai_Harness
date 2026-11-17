import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolError } from "../../src/tools/types.js";
import { DEFAULT_MAX_LINES, MAX_LINE_CHARS, viewFile } from "../../src/tools/view_file.js";

let base: string;
let root: string;
const run = (input: Parameters<typeof viewFile.run>[0]) => viewFile.run(input, { root });

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "harness-view-"));
  root = path.join(base, "repo");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/small.ts"), "const a = 1;\r\nconst b = 2;\nexport { a, b };\n");
  await writeFile(path.join(root, "big.txt"), Array.from({ length: 1500 }, (_, i) => `line ${i + 1}`).join("\n"));
  await writeFile(path.join(root, "long.txt"), "x".repeat(MAX_LINE_CHARS + 50));
  await writeFile(path.join(root, "empty.txt"), "");
  await writeFile(path.join(root, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await writeFile(path.join(base, "secret.txt"), "outside");
  await symlink(path.join(base, "secret.txt"), path.join(root, "link.txt"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("view_file", () => {
  it("shows a small file with line numbers, handling CRLF and the final newline", async () => {
    expect(await run({ path: "src/small.ts" })).toBe("1\tconst a = 1;\n2\tconst b = 2;\n3\texport { a, b };");
  });

  it("shows a range, padding line numbers to the same width", async () => {
    const out = await run({ path: "big.txt", start_line: 98, end_line: 101 });
    expect(out.split("\n").slice(0, 4)).toEqual([" 98\tline 98", " 99\tline 99", "100\tline 100", "101\tline 101"]);
    expect(out).toContain("lines 98-101 of 1500. To read more, call view_file with start_line=102.");
  });

  it("limits output without a range and says how to continue", async () => {
    const out = await run({ path: "big.txt" });
    expect(out.split("\n")).toHaveLength(DEFAULT_MAX_LINES + 1);
    expect(out).toContain(`lines 1-${DEFAULT_MAX_LINES} of 1500`);
    expect(out).toContain(`start_line=${DEFAULT_MAX_LINES + 1}`);
  });

  it("caps an explicit range at 1000 lines", async () => {
    const out = await run({ path: "big.txt", start_line: 1, end_line: 1500 });
    expect(out).toContain("lines 1-1000 of 1500");
  });

  it("cuts very long lines", async () => {
    expect(await run({ path: "long.txt" })).toContain(`[line cut, ${MAX_LINE_CHARS + 50} chars]`);
  });

  it("reports empty and binary files instead of dumping them", async () => {
    expect(await run({ path: "empty.txt" })).toBe("empty.txt: (empty file)");
    expect(await run({ path: "image.png" })).toBe("image.png: binary file (4 bytes), not shown");
  });

  it.each([
    [{ path: "nope.ts" }, "file not found: nope.ts"],
    [{ path: "src" }, "src is a directory"],
    [{ path: "big.txt", start_line: 2000 }, "start_line 2000 is past the end of big.txt (1500 lines)"],
    [{ path: "big.txt", start_line: 10, end_line: 5 }, "end_line (5) is before start_line (10)"],
    [{ path: "../secret.txt" }, "outside the repository"],
    [{ path: "/etc/hosts" }, "outside the repository"],
    [{ path: "link.txt" }, "leads outside the repository (symlink)"],
  ])("rejects %j", async (input, message) => {
    const err = await run(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain(message);
  });
});
