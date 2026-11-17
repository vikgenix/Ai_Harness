import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Directories that are listed but never opened or searched when walking:
 * version control data, dependencies, caches and build output.
 */
export const NOT_EXPANDED = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".next",
  ".nuxt",
  ".cache",
  "target",
  "dist",
  "build",
  "coverage",
]);

/** Stop listing beyond this many files; huge trees should be narrowed with a path. */
export const MAX_LISTED_FILES = 50_000;

export interface FileList {
  /** Paths relative to `root`, forward slashes, sorted. */
  files: string[];
  /** True if MAX_LISTED_FILES was reached. */
  truncated: boolean;
  /** "git" when .gitignore rules were applied, "walk" otherwise. */
  source: "git" | "walk";
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/**
 * Lists the files under `dir` (which must be inside `root`). In a git
 * repository this asks git, so ignored files (build output, dependencies,
 * secrets in .env) are left out; otherwise it walks the tree and skips the
 * NOT_EXPANDED directories.
 */
export async function listFiles(root: string, dir: string, signal?: AbortSignal): Promise<FileList> {
  const fromGit = await gitFiles(dir, signal);
  let rel: string[];
  let source: FileList["source"];
  if (fromGit) {
    rel = fromGit.map((p) => toPosix(path.relative(root, path.join(dir, p))));
    source = "git";
  } else {
    rel = [];
    await walk(dir, root, rel, signal);
    source = "walk";
  }
  rel.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const truncated = rel.length > MAX_LISTED_FILES;
  return { files: truncated ? rel.slice(0, MAX_LISTED_FILES) : rel, truncated, source };
}

/** Tracked and untracked-but-not-ignored files, or null when `dir` is not in a usable git repo. */
async function gitFiles(dir: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });
    // --cached and --others can both list a file (e.g. during a merge).
    return [...new Set(stdout.split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

async function walk(dir: string, root: string, out: string[], signal?: AbortSignal): Promise<void> {
  if (out.length > MAX_LISTED_FILES || signal?.aborted) return;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directories are skipped
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NOT_EXPANDED.has(entry.name)) await walk(full, root, out, signal);
    } else if (entry.isFile()) {
      out.push(toPosix(path.relative(root, full)));
    }
    // Symlinks are skipped: they may point outside the repository.
  }
}

/**
 * Converts a glob to a RegExp: `*` (within one path segment), `**` (any
 * depth), `?`, and `{a,b}` alternatives. A glob without "/" is matched
 * against the file name only, so `*.ts` finds TypeScript files at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Matches a root-relative path against a glob (see globToRegExp). `base` is the searched directory, also relative to root. */
export function matchesGlob(glob: string, file: string, base = ""): boolean {
  const re = globToRegExp(glob);
  if (!glob.includes("/")) return re.test(file.slice(file.lastIndexOf("/") + 1));
  const underBase = base && base !== "." && file.startsWith(`${base}/`) ? file.slice(base.length + 1) : undefined;
  return re.test(file) || (underBase !== undefined && re.test(underBase));
}
