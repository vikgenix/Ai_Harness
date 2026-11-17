import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./types.js";

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p); // lstat: a dangling symlink still counts as existing
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedPath {
  absolute: string;
  /** As shown to the model: relative to the root, with forward slashes. */
  display: string;
}

/**
 * Resolves a path given by the model (relative to the repository root, or
 * absolute) and makes sure it stays inside the root, also after following
 * symlinks. The target does not have to exist yet.
 */
export async function resolveInRoot(root: string, given: string): Promise<ResolvedPath> {
  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, given);
  if (!isInside(realRoot, target)) throw new ToolError(`'${given}' is outside the repository`);

  // Follow symlinks on the part of the path that exists.
  let existing = target;
  while (!(await exists(existing)) && existing !== realRoot) existing = path.dirname(existing);
  let real: string;
  try {
    real = await realpath(existing);
  } catch {
    throw new ToolError(`'${given}' is a broken symlink`);
  }
  if (!isInside(realRoot, real)) {
    throw new ToolError(`'${given}' leads outside the repository (symlink)`);
  }
  return { absolute: target, display: path.relative(realRoot, target).split(path.sep).join("/") || "." };
}
