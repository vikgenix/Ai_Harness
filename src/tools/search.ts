import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { listFiles, matchesGlob } from "./files.js";
import { resolveInRoot } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

/** Matching lines shown per call. */
export const MAX_SHOWN = 100;
/** Scanning stops after this many matches; the total is then reported as "more than". */
export const MAX_COUNTED = 2000;
export const MAX_CONTEXT = 5;
/** Shown lines are cut to this length. */
export const MAX_LINE_CHARS = 300;
/** Larger files (data, bundles) are not searched. */
export const MAX_FILE_BYTES = 1024 * 1024;

interface SearchInput {
  pattern: string;
  path?: string;
  glob?: string;
  literal?: boolean;
  case_insensitive?: boolean;
  context?: number;
}

interface FileMatches {
  file: string;
  lines: string[];
  /** 0-based indexes of matching lines. */
  hits: number[];
}

export const search: Tool<SearchInput> = {
  spec: {
    name: "search",
    description:
      "Search file contents in the repository for a regular expression (JavaScript syntax), like grep. " +
      "Returns matching lines as path:line: text. Files ignored by git, binary files and files over 1 MB are skipped. " +
      `Shows at most ${MAX_SHOWN} matches; narrow with path or glob when there are more.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to look for, e.g. 'def parse_\\w+' or 'TODO'." },
        path: { type: "string", description: "Directory or file to search, relative to the repository root. Default: the root." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. '*.py', 'src/**/*.ts', '*.{js,ts}'." },
        literal: { type: "boolean", description: "Treat the pattern as plain text instead of a regular expression." },
        case_insensitive: { type: "boolean", description: "Ignore upper/lower case." },
        context: { type: "integer", minimum: 0, description: `Lines of context before and after each match (max ${MAX_CONTEXT}). Default 0.` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },

  async run(input, ctx) {
    if (!input.pattern) throw new ToolError("pattern must not be empty");
    const re = compile(input);
    const context = Math.min(input.context ?? 0, MAX_CONTEXT);

    const realRoot = await realpath(ctx.root);
    const { absolute, display } = await resolveInRoot(ctx.root, input.path ?? ".");
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new ToolError(`path not found: ${display}`);
    }

    let files: string[];
    let listTruncated = false;
    if (info.isDirectory()) {
      const listed = await listFiles(realRoot, absolute, ctx.signal);
      files = listed.files;
      listTruncated = listed.truncated;
    } else {
      files = [display];
    }
    if (input.glob) files = files.filter((f) => matchesGlob(input.glob!, f, display));

    const found: FileMatches[] = [];
    let total = 0;
    let searched = 0;
    for (const file of files) {
      if (ctx.signal?.aborted) throw new ToolError("search cancelled");
      const lines = await readTextLines(path.join(realRoot, file));
      if (!lines) continue;
      searched++;
      const hits: number[] = [];
      for (let i = 0; i < lines.length && total < MAX_COUNTED; i++) {
        if (re.test(lines[i]!)) {
          hits.push(i);
          total++;
        }
      }
      if (hits.length) found.push({ file, lines, hits });
      if (total >= MAX_COUNTED) break;
    }

    const where = display === "." ? "the repository" : display;
    const filter = input.glob ? ` (files matching ${input.glob})` : "";
    if (total === 0) {
      return `No matches for ${describe(input)} in ${where}${filter}. ${searched} ${searched === 1 ? "file" : "files"} searched.`;
    }

    const body = format(found, context);
    const totalText = total >= MAX_COUNTED ? `more than ${MAX_COUNTED}` : String(total);
    const fileCount = `${found.length} ${found.length === 1 ? "file" : "files"}`;
    const notes: string[] = [];
    if (total > MAX_SHOWN) {
      notes.push(`showing the first ${MAX_SHOWN} of ${totalText} matches in ${fileCount}; narrow the pattern, path or glob to see the rest`);
    } else {
      notes.push(`${total} ${total === 1 ? "match" : "matches"} in ${fileCount}`);
    }
    if (listTruncated) notes.push("the directory has too many files: only part of it was searched");
    return `${body}\n(${notes.join("; ")})`;
  },
};

function compile(input: SearchInput): RegExp {
  const source = input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
  try {
    return new RegExp(source, input.case_insensitive ? "i" : "");
  } catch (err) {
    throw new ToolError(`invalid regular expression: ${(err as Error).message}. Set literal=true to search for plain text.`);
  }
}

function describe(input: SearchInput): string {
  return input.literal ? JSON.stringify(input.pattern) : `/${input.pattern}/${input.case_insensitive ? "i" : ""}`;
}

/** Lines of a text file, or null for symlinks, binary and oversized files. */
async function readTextLines(file: string): Promise<string[] | null> {
  try {
    const info = await lstat(file); // lstat: symlinks are skipped, they may lead outside the repo
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const buffer = await readFile(file);
    if (buffer.subarray(0, 8192).includes(0)) return null;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return null; // deleted since listing, unreadable...
  }
}

const cut = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [cut]` : line);

/**
 * grep-style output. Without context: `path:12: text`. With context, matches
 * use ':' and surrounding lines use '-', and separate groups are divided by '--'.
 */
function format(found: FileMatches[], context: number): string {
  const out: string[] = [];
  let shown = 0;
  for (const { file, lines, hits } of found) {
    if (shown >= MAX_SHOWN) break;
    const take = hits.slice(0, MAX_SHOWN - shown);
    shown += take.length;

    if (context === 0) {
      for (const i of take) out.push(`${file}:${i + 1}: ${cut(lines[i]!)}`);
      continue;
    }
    // Merge overlapping context windows into groups; "--" between groups and files.
    const isHit = new Set(take);
    let groupEnd = -1;
    for (const i of take) {
      const from = Math.max(0, i - context, groupEnd + 1);
      const to = Math.min(lines.length - 1, i + context);
      if (from > to) continue; // already shown as part of the previous window
      if (out.length && (groupEnd === -1 || from > groupEnd + 1)) out.push("--");
      for (let j = from; j <= to; j++) out.push(`${file}${isHit.has(j) ? ":" : "-"}${j + 1}${isHit.has(j) ? ":" : "-"} ${cut(lines[j]!)}`);
      groupEnd = Math.max(groupEnd, to);
    }
  }
  return out.join("\n");
}
