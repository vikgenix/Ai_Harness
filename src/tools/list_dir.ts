import type { Dirent } from "node:fs";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { NOT_EXPANDED } from "./files.js";
import { resolveInRoot } from "./paths.js";
import { ToolError, type Tool } from "./types.js";

export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 5;
/** Entries shown per directory before "... and N more". */
export const MAX_PER_DIR = 100;
/** Entries shown in total per call. */
export const MAX_ENTRIES = 500;

interface ListDirInput {
  path?: string;
  depth?: number;
}

export const listDir: Tool<ListDirInput> = {
  spec: {
    name: "list_dir",
    description:
      "List a directory in the repository as an indented tree. Directories end with '/', files show their size. " +
      `Goes ${DEFAULT_DEPTH} levels deep by default (max ${MAX_DEPTH}). ` +
      `Dependency, cache and build directories (${["node_modules", ".git", "dist", "__pycache__"].join(", ")}, ...) are listed but not opened.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory, relative to the repository root. Default: the root." },
        depth: { type: "integer", minimum: 1, description: `How many levels to show. Default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}.` },
      },
      additionalProperties: false,
    },
  },

  async run(input, ctx) {
    const { absolute, display } = await resolveInRoot(ctx.root, input.path ?? ".");
    let info;
    try {
      info = await stat(absolute); // follows a symlinked directory; resolveInRoot checked it stays inside
    } catch {
      throw new ToolError(`directory not found: ${display}`);
    }
    if (!info.isDirectory()) throw new ToolError(`${display} is not a directory${info.isFile() ? "; use view_file to read it" : ""}`);

    const depth = Math.min(input.depth ?? DEFAULT_DEPTH, MAX_DEPTH);
    const state = { lines: [] as string[], shown: 0, truncated: false };
    await walk(absolute, depth, "", state);

    const header = `${display === "." ? "." : display}/`;
    if (state.lines.length === 0) return `${header} (empty)`;
    const footer = state.truncated
      ? `\n(listing stopped at ${MAX_ENTRIES} entries; list a subdirectory or use a smaller depth to see the rest)`
      : "";
    return `${header}\n${state.lines.join("\n")}${footer}`;
  },
};

interface WalkState {
  lines: string[];
  shown: number;
  truncated: boolean;
}

async function walk(dir: string, depthLeft: number, indent: string, state: WalkState): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    state.lines.push(`${indent}  (unreadable: ${(err as NodeJS.ErrnoException).code ?? "error"})`);
    return;
  }

  // Directories first, then files; each group in a fixed (byte) order so output is stable.
  const byName = (a: Dirent, b: Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const dirs = entries.filter((e) => e.isDirectory()).sort(byName);
  const others = entries.filter((e) => !e.isDirectory()).sort(byName);
  const ordered = [...dirs, ...others];

  const pad = `${indent}  `;
  for (const [i, entry] of ordered.entries()) {
    if (state.shown >= MAX_ENTRIES) {
      state.truncated = true;
      return;
    }
    if (i >= MAX_PER_DIR) {
      state.lines.push(`${pad}... and ${ordered.length - i} more`);
      return;
    }
    state.shown++;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (NOT_EXPANDED.has(entry.name)) {
        state.lines.push(`${pad}${entry.name}/ (not expanded)`);
      } else if (depthLeft > 1) {
        state.lines.push(`${pad}${entry.name}/`);
        await walk(full, depthLeft - 1, pad, state);
        if (state.truncated) return;
      } else {
        state.lines.push(`${pad}${entry.name}/ ${await countEntries(full)}`);
      }
    } else if (entry.isSymbolicLink()) {
      // Never followed: the target may be outside the repository.
      const target = await readlink(full).catch(() => "?");
      state.lines.push(`${pad}${entry.name} -> ${target}`);
    } else {
      const size = await lstat(full).then((s) => s.size, () => undefined);
      state.lines.push(`${pad}${entry.name}${size === undefined ? "" : ` (${formatSize(size)})`}`);
    }
  }
}

/** For directories at the depth limit: how much is inside, so the agent knows whether to look. */
async function countEntries(dir: string): Promise<string> {
  try {
    const n = (await readdir(dir)).length;
    return n === 0 ? "(empty)" : `(${n} ${n === 1 ? "entry" : "entries"})`;
  } catch {
    return "(unreadable)";
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
