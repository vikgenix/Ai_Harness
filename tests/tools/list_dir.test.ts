import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ENTRIES, MAX_PER_DIR, formatSize, listDir } from "../../src/tools/list_dir.js";
import { ToolError } from "../../src/tools/types.js";

let base: string;
let root: string;
const run = (input: Parameters<typeof listDir.run>[0]) => listDir.run(input, { root });

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "harness-ls-"));
  root = path.join(base, "repo");
  await mkdir(path.join(root, "src/utils/deep"), { recursive: true });
  await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
  await mkdir(path.join(root, ".git"), { recursive: true });
  await mkdir(path.join(root, "empty"));
  await writeFile(path.join(root, "README.md"), "x".repeat(2048));
  await writeFile(path.join(root, ".env.example"), "A=\n");
  await writeFile(path.join(root, "src/index.ts"), "export {};\n");
  await writeFile(path.join(root, "src/utils/a.ts"), "");
  await writeFile(path.join(root, "src/utils/deep/b.ts"), "");
  await symlink(path.join(base), path.join(root, "escape"));
  await mkdir(path.join(root, "many"));
  for (let i = 0; i < MAX_PER_DIR + 5; i++) await writeFile(path.join(root, "many", `f${String(i).padStart(3, "0")}.txt`), "");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("list_dir", () => {
  it("lists two levels by default: dirs first, sizes, skipped and collapsed dirs, symlinks", async () => {
    expect(await run({})).toBe(
      [
        "./",
        "  .git/ (not expanded)",
        "  empty/",
        "  many/",
        ...Array.from({ length: MAX_PER_DIR }, (_, i) => `    f${String(i).padStart(3, "0")}.txt (0 B)`),
        "    ... and 5 more",
        "  node_modules/ (not expanded)",
        "  src/",
        "    utils/ (2 entries)",
        "    index.ts (11 B)",
        "  .env.example (3 B)",
        "  README.md (2.0 KB)",
        `  escape -> ${base}`,
      ].join("\n"),
    );
  });

  it("lists a subdirectory with a chosen depth", async () => {
    expect(await run({ path: "src", depth: 5 })).toBe(
      ["src/", "  utils/", "    deep/", "      b.ts (0 B)", "    a.ts (0 B)", "  index.ts (11 B)"].join("\n"),
    );
  });

  it("shows the count of entries for directories at the depth limit", async () => {
    expect(await run({ depth: 1 })).toContain("  many/ (105 entries)\n");
    expect(await run({ depth: 1 })).toContain("  empty/ (empty)\n");
  });

  it("says when a directory is empty", async () => {
    expect(await run({ path: "empty" })).toBe("empty/ (empty)");
  });

  it("stops at the total entry limit", async () => {
    const big = path.join(base, "big");
    for (let d = 0; d < 6; d++) {
      await mkdir(path.join(big, `d${d}`), { recursive: true });
      for (let i = 0; i < 99; i++) await writeFile(path.join(big, `d${d}`, `f${i}`), "");
    }
    const out = await listDir.run({}, { root: big });
    expect(out).toContain(`listing stopped at ${MAX_ENTRIES} entries`);
    expect(out.split("\n").length).toBeLessThanOrEqual(MAX_ENTRIES + 3);
  });

  it.each([
    [{ path: "nope" }, "directory not found: nope"],
    [{ path: "README.md" }, "README.md is not a directory; use view_file to read it"],
    [{ path: ".." }, "outside the repository"],
    [{ path: "escape" }, "leads outside the repository (symlink)"],
  ])("rejects %j", async (input, message) => {
    const err = await run(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain(message);
  });

  it("formats sizes", () => {
    expect([formatSize(0), formatSize(1536), formatSize(5 * 1024 * 1024)]).toEqual(["0 B", "1.5 KB", "5.0 MB"]);
  });
});
