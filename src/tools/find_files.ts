import { realpath, stat } from "node:fs/promises";
import { listFiles, matchesGlob } from "./files.js";
import { resolveInRoot } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

/** Paths shown per call. */
export const MAX_RESULTS = 200;

interface FindFilesInput {
  pattern: string;
  path?: string;
}

const GLOB_CHARS = /[*?{]/;

export const findFiles: Tool<FindFilesInput> = {
  spec: {
    name: "find_files",
    description:
      "Find files in the repository by name or path. The pattern is a glob ('*.py', 'src/**/test_*.ts', '*.{js,ts}'); " +
      "a glob without '/' matches the file name at any depth. A pattern without * ? or { is matched as plain text " +
      "anywhere in the path, ignoring case (e.g. 'config' finds src/Config.ts and config/settings.py). " +
      `Files ignored by git are skipped. Shows at most ${MAX_RESULTS} paths.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob such as '*.py' or 'tests/**/*.ts', or plain text such as 'parser'." },
        path: { type: "string", description: "Directory to look in, relative to the repository root. Default: the root." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },

  async run(input, ctx) {
    const pattern = input.pattern.trim();
    if (!pattern) throw new ToolError("pattern must not be empty");

    const realRoot = await realpath(ctx.root);
    const { absolute, display } = await resolveInRoot(ctx.root, input.path ?? ".");
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`directory not found: ${display}`);
    }
    if (!info.isDirectory()) throw new ToolError(`${display} is a file, not a directory; use view_file to read it`);

    const listed = await listFiles(realRoot, absolute, ctx.signal);
    const matches = listed.files.filter(matcher(pattern, display));

    const where = display === "." ? "the repository" : display;
    const partial = listed.truncated ? "; the directory has too many files: only part of it was checked" : "";
    if (matches.length === 0) {
      const checked = `${listed.files.length} ${listed.files.length === 1 ? "file" : "files"} checked`;
      return `No files matching ${JSON.stringify(pattern)} in ${where} (${checked}${partial}).`;
    }

    const shown = matches.slice(0, MAX_RESULTS);
    const count = `${matches.length} ${matches.length === 1 ? "file" : "files"}`;
    const summary =
      matches.length > MAX_RESULTS ? `showing the first ${MAX_RESULTS} of ${count}; use a narrower pattern or path to see the rest` : count;
    return `${shown.join("\n")}\n(${summary}${partial})`;
  },
};

function matcher(pattern: string, base: string): (file: string) => boolean {
  if (GLOB_CHARS.test(pattern)) return (file) => matchesGlob(pattern, file, base);
  const needle = pattern.toLowerCase();
  return (file) => file.toLowerCase().includes(needle);
}
