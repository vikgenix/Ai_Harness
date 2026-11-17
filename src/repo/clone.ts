import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Clones go here (git-ignored, removed by `make clean`). */
export const DEFAULT_WORKSPACES_DIR = fileURLToPath(new URL("../../workspaces/", import.meta.url));

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

export interface RepoSpec {
  /** What git clones from. */
  cloneUrl: string;
  host: string;
  owner: string;
  name: string;
  /** Short name for messages, e.g. "owner/repo". */
  label: string;
}

export class CloneError extends Error {
  override name = "CloneError";
}

const SAFE = /^[A-Za-z0-9_.-]+$/;
const KNOWN_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/**
 * Recognises a repository reference, or returns null if `input` is not one:
 *   https://github.com/owner/repo(.git)  (also /tree/<branch>/... links)
 *   git@github.com:owner/repo.git
 *   owner/repo                           (GitHub)
 *   file:///path/to/repo                 (a local repository, cloned as a copy)
 */
export function parseRepoUrl(input: string): RepoSpec | null {
  const text = input.trim();
  const make = (host: string, owner: string, rawName: string, cloneUrl?: string): RepoSpec | null => {
    const name = rawName.replace(/\.git$/, "");
    if (!SAFE.test(owner) || !SAFE.test(name) || [owner, name].some((s) => s === "." || s === "..")) return null;
    return {
      cloneUrl: cloneUrl ?? `https://${host}/${owner}/${name}.git`,
      host,
      owner,
      name,
      label: host === "github.com" || host === "local" ? `${owner}/${name}` : `${host}/${owner}/${name}`,
    };
  };

  if (text.startsWith("file://")) {
    let local: string;
    try {
      local = fileURLToPath(text);
    } catch {
      return null;
    }
    return make("local", "local", path.basename(local), text);
  }

  const ssh = /^git@([\w.-]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text);
  if (ssh) return make(ssh[1]!, ssh[2]!, ssh[3]!, text);

  if (/^https?:\/\//.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const [owner, name] = url.pathname.split("/").filter(Boolean);
    if (!owner || !name || !KNOWN_HOSTS.has(url.hostname)) return null;
    // Rebuilt from the parts: drops /tree/main/..., query strings and credentials.
    return make(url.hostname, owner, name);
  }

  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(text);
  if (short && !text.startsWith(".")) return make("github.com", short[1]!, short[2]!);
  return null;
}

export interface CloneOptions {
  workspacesDir?: string;
  /** Used for github.com only; passed to git for this command, never stored in the clone. */
  githubToken?: string;
  signal?: AbortSignal;
}

export interface CloneResult {
  dir: string;
  /** True if an earlier clone was reused instead of cloning again. */
  reused: boolean;
  durationMs: number;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

/** Clones `spec` into the workspaces directory (shallow), or reuses an existing clone. */
export async function cloneRepo(spec: RepoSpec, opts: CloneOptions = {}): Promise<CloneResult> {
  const started = Date.now();
  const workspaces = opts.workspacesDir ?? DEFAULT_WORKSPACES_DIR;
  const dir = path.join(workspaces, `${spec.owner}__${spec.name}`);
  if (await isGitRepo(dir)) return { dir, reused: true, durationMs: Date.now() - started };

  await mkdir(workspaces, { recursive: true });
  // Clone next to the target and rename at the end, so an interrupted clone
  // never looks like a finished one.
  const partial = `${dir}.partial-${process.pid}`;
  await rm(dir, { recursive: true, force: true }); // leftover without .git
  await rm(partial, { recursive: true, force: true });

  try {
    await run("git", ["clone", "--depth", "1", "--quiet", "--", spec.cloneUrl, partial], {
      env: gitEnv(spec, opts.githubToken),
      timeout: CLONE_TIMEOUT_MS,
      signal: opts.signal,
      maxBuffer: 16 * 1024 * 1024,
    });
    await rename(partial, dir);
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw toCloneError(err, spec, Boolean(opts.githubToken), opts.signal);
  }
  return { dir, reused: false, durationMs: Date.now() - started };
}

export function gitEnv(spec: RepoSpec, token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0", // fail instead of waiting for a password
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
  if (token && spec.host === "github.com" && spec.cloneUrl.startsWith("https://")) {
    // Same approach as actions/checkout: an auth header given through the
    // environment for this one command, so the token is not saved in .git/config.
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

function toCloneError(err: unknown, spec: RepoSpec, hadToken: boolean, signal?: AbortSignal): CloneError {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
  if (signal?.aborted || e.name === "AbortError") return new CloneError("Clone cancelled.");
  if (e.code === "ENOENT") return new CloneError("git is not installed or not on PATH.");
  if (e.killed) return new CloneError(`Cloning ${spec.label} timed out after ${CLONE_TIMEOUT_MS / 60000} minutes.`);

  const stderr = (e.stderr ?? "").trim();
  const last = stderr.split("\n").filter(Boolean).pop() ?? e.message;
  const notFound = /not found|could not read Username|Authentication failed|access denied|does not exist/i.test(stderr);
  if (notFound) {
    const hint =
      spec.host === "github.com" && !hadToken
        ? " If it is private, set GITHUB_TOKEN."
        : spec.host === "github.com"
          ? " Check that GITHUB_TOKEN can read it."
          : "";
    return new CloneError(`Could not clone ${spec.label}: repository not found or not accessible.${hint}`);
  }
  return new CloneError(`Could not clone ${spec.label}: ${last.replace(/^fatal:\s*/, "")}`);
}
