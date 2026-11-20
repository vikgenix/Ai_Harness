import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Ecosystem, ProjectInfo } from "../repo/detect.js";
import { NON_INTERACTIVE_ENV } from "../tools/bash.js";
import type { CommandSandbox } from "../tools/types.js";

/**
 * Optional Docker sandbox. With `sandbox: docker`, the agent's commands, the
 * dependency install and the baseline tests run in a container instead of on
 * this machine. The container sees only the repository and its dependency
 * environment, both mounted at the same path as outside, so paths in error
 * messages match the files the agent views and edits (the file tools and git
 * still run outside, on the same files).
 *
 * The container runs as the current user with all capabilities dropped and
 * no-new-privileges, under a process limit. Network access is on by default,
 * since installs need it; `sandbox_network: false` turns it off. One container
 * is kept for a whole fix and removed afterwards (also when the harness exits).
 */

export class SandboxError extends Error {
  override name = "SandboxError";
}

/** Image per ecosystem, when `sandbox_image` is not set. */
const IMAGES: Record<string, string> = {
  "Node.js": "node:22-bookworm-slim",
  Rust: "rust:1-slim-bookworm",
  "Java (Maven)": "maven:3-eclipse-temurin-21",
  "Java/Kotlin (Gradle)": "gradle:8-jdk21",
  Ruby: "ruby:3.3-slim-bookworm",
  PHP: "composer:2",
  ".NET": "mcr.microsoft.com/dotnet/sdk:8.0",
};
export const DEFAULT_IMAGE = "debian:bookworm-slim";
/** Python versions tried for requires-python, most preferred first. */
const PYTHONS = ["3.12", "3.13", "3.11", "3.10", "3.9", "3.8"];

/** Home inside the container: caches of pip, uv, npm, Go, Cargo, Maven and Gradle (mounted from the host, so they last). */
const HOME = "/tmp/shrike-home";
const PULL_TIMEOUT_MS = 15 * 60_000;
const DOCKER_TIMEOUT_MS = 60_000;
const PROCESS_LIMIT = 2048;

/** Whether a Python version (e.g. "3.12") satisfies a requires-python spec (e.g. ">=3.9,<3.13"). */
export function satisfies(version: string, spec: string): boolean {
  const v = version.split(".").map(Number);
  const cmp = (other: string) => {
    const o = other.split(".").map(Number);
    for (let i = 0; i < 2; i++) if ((v[i] ?? 0) !== (o[i] ?? 0)) return (v[i] ?? 0) - (o[i] ?? 0);
    return 0;
  };
  return spec.split(",").every((part) => {
    const m = /^\s*(>=|<=|==|!=|~=|>|<)\s*(\d+(?:\.\d+)?)(?:\.[\d*]+)?\s*$/.exec(part);
    if (!m) return true; // unknown forms do not rule a version out
    const c = cmp(m[2]!);
    return { ">=": c >= 0, "<=": c <= 0, "==": c === 0, "!=": c !== 0, "~=": c >= 0, ">": c > 0, "<": c < 0 }[m[1]!]!;
  });
}

/** The image for the project's first ecosystem, with a matching runtime version where the project names one. */
export function imageFor(info: ProjectInfo | undefined): string {
  const e: Ecosystem | undefined = info?.ecosystems[0];
  if (!e) return DEFAULT_IMAGE;
  if (e.name === "Python") return `python:${PYTHONS.find((v) => !e.requires || satisfies(v, e.requires)) ?? PYTHONS[0]}-slim-bookworm`;
  if (e.name === "Go") return `golang:${/^1\.\d+/.exec(e.requires ?? "")?.[0] ?? "1.23"}-bookworm`;
  return IMAGES[e.name] ?? DEFAULT_IMAGE;
}

/** Where dependency environments built in a container are kept: separate per image, since they do not work outside it. */
export function sandboxEnvsDir(envsDir: string, image: string): string {
  return path.join(envsDir, "docker", image.replace(/[^\w.-]+/g, "_"));
}

interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the docker CLI. Never throws: a missing docker is code 127. */
function docker(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: opts.timeoutMs ?? DOCKER_TIMEOUT_MS, signal: opts.signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = !e ? 0 : e.code === "ENOENT" ? 127 : typeof e.code === "number" ? e.code : 1;
      resolve({ code, stdout: String(stdout), stderr: e?.code === "ENOENT" ? "docker is not installed" : String(stderr || e?.message || "") });
    });
  });
}

const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).pop() ?? "";

/** Null if Docker can run containers, else why not. */
export async function dockerProblem(): Promise<string | null> {
  const r = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
  if (r.code === 0 && r.stdout.trim()) return null;
  return r.code === 127 ? "Docker is not installed" : `Docker is not running (${lastLine(r.stderr) || "no server"})`;
}

// Containers of this process, removed when it exits however it exits.
const live = new Set<string>();
let exitHookInstalled = false;
function track(name: string): void {
  live.add(name);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    if (!live.size) return;
    try {
      execFileSync("docker", ["rm", "-f", ...live], { stdio: "ignore", timeout: 15_000 });
    } catch {
      // best effort; the next start removes leftovers
    }
  });
}

/** Removes containers left by harness processes that are gone (killed before they could clean up). */
async function removeLeftovers(): Promise<void> {
  const r = await docker(["ps", "-a", "--filter", "label=shrike.pid", "--format", '{{.ID}} {{.Label "shrike.pid"}}']);
  const dead = r.stdout
    .split("\n")
    .map((l) => l.trim().split(" "))
    .filter(([id, pid]) => id && pid && !alive(Number(pid)))
    .map(([id]) => id!);
  if (dead.length) await docker(["rm", "-f", ...dead]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DockerSandboxOptions {
  /** The repository; mounted at the same path. */
  root: string;
  image: string;
  network: boolean;
  /** Where dependency environments for this image are kept (from sandboxEnvsDir); mounted at the same path. */
  envsDir: string;
  signal?: AbortSignal;
  onProgress?(line: string): void;
}

export class DockerSandbox implements CommandSandbox {
  private constructor(
    readonly name: string,
    readonly image: string,
    readonly network: boolean,
    private readonly shell: string,
    /** PATH inside the container, for commands whose PATH adds to it. */
    private readonly pathInside: string,
    /** Whether git is installed in the container. */
    readonly hasGit: boolean,
  ) {}

  /** Pulls the image if needed and starts the container. Throws SandboxError when Docker cannot run it. */
  static async start(opts: DockerSandboxOptions): Promise<DockerSandbox> {
    const problem = await dockerProblem();
    if (problem) throw new SandboxError(`${problem}. Start Docker, or set sandbox: none in config/model.yaml.`);
    await removeLeftovers();

    if ((await docker(["image", "inspect", "--format", "{{.Id}}", opts.image])).code !== 0) {
      opts.onProgress?.(`Pulling ${opts.image} (first use only)...`);
      const pulled = await docker(["pull", "--quiet", opts.image], { timeoutMs: PULL_TIMEOUT_MS, signal: opts.signal });
      if (pulled.code !== 0) throw new SandboxError(`Could not pull the image ${opts.image}: ${lastLine(pulled.stderr)}`);
    }

    const root = realpathSync(opts.root);
    const home = path.join(opts.envsDir, "home");
    await mkdir(home, { recursive: true });
    const envsDir = realpathSync(opts.envsDir);
    const name = `shrike-${path.basename(root).replace(/[^\w.-]+/g, "_").slice(0, 30)}-${randomBytes(4).toString("hex")}`;
    const user = typeof process.getuid === "function" ? [`--user`, `${process.getuid()}:${process.getgid!()}`] : [];
    const env = {
      HOME,
      GOPATH: `${HOME}/go`,
      CARGO_HOME: `${HOME}/.cargo`,
      GRADLE_USER_HOME: `${HOME}/.gradle`,
      MAVEN_OPTS: `-Duser.home=${HOME}`, // Java finds its home in /etc/passwd, where the user is missing
      npm_config_cache: `${HOME}/.npm`,
    };
    const run = await docker(
      [
        "run",
        "--detach",
        "--rm",
        "--init",
        "--name",
        name,
        "--label",
        `shrike.pid=${process.pid}`,
        ...user,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(PROCESS_LIMIT),
        ...(opts.network ? [] : ["--network", "none"]),
        ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        "--volume",
        `${root}:${root}`,
        "--volume",
        `${envsDir}:${envsDir}`,
        "--volume",
        `${realpathSync(home)}:${HOME}`,
        "--workdir",
        root,
        "--entrypoint",
        "sleep",
        opts.image,
        "31536000",
      ],
      { signal: opts.signal },
    );
    if (run.code !== 0) throw new SandboxError(`Could not start the container: ${lastLine(run.stderr)}`);
    track(name);

    const exec = (script: string) => docker(["exec", name, "sh", "-c", script]);
    const shell = (await exec("command -v bash")).code === 0 ? "bash" : "sh";
    const pathInside = (await exec('printf %s "$PATH"')).stdout || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    const hasGit = (await exec("command -v git")).code === 0;
    return new DockerSandbox(name, opts.image, opts.network, shell, pathInside, hasGit);
  }

  command(command: string, cwd: string, env: Record<string, string>, id: string): { file: string; args: string[] } {
    const vars: Record<string, string> = { ...NON_INTERACTIVE_ENV, SHRIKE_COMMAND_ID: id, ...env };
    if (env.PATH) vars.PATH = this.translatePath(env.PATH);
    return { file: "docker", args: ["exec", "--workdir", cwd, ...Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]), this.name, this.shell, "-c", command] };
  }

  /**
   * A PATH built for this machine (directories added in front of its PATH)
   * as the container's PATH with the same directories in front.
   */
  translatePath(hostPath: string): string {
    const outside = new Set((process.env.PATH ?? "").split(path.delimiter));
    const added = hostPath.split(path.delimiter).filter((p) => p && !outside.has(p));
    return [...added, this.pathInside].join(":");
  }

  /** Kills every process of the command: they all carry its id in their environment. */
  async stop(id: string): Promise<void> {
    const script = `for p in /proc/[0-9]*; do if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx 'SHRIKE_COMMAND_ID=${id.replace(/[^\w-]/g, "")}'; then kill -9 "\${p#/proc/}" 2>/dev/null; fi; done; true`;
    await docker(["exec", this.name, "sh", "-c", script], { timeoutMs: 15_000 });
  }

  /** The version of a tool inside the container, or null if it is not installed there. */
  async toolVersion(tool: string): Promise<string | null> {
    const args = tool === "go" ? ["version"] : tool === "java" ? ["-version"] : ["--version"];
    const r = await docker(["exec", "--workdir", "/tmp", "--env", "GOTOOLCHAIN=local", this.name, tool, ...args], { timeoutMs: 15_000 });
    if (r.code === 126 || r.code === 127 || /executable file not found|no such file or directory/i.test(r.stderr)) return null;
    return /\d+\.\d+(\.\d+)?/.exec(`${r.stdout}\n${r.stderr}`)?.[0] ?? "installed";
  }

  /** Removes the container. */
  async close(): Promise<void> {
    live.delete(this.name);
    await docker(["rm", "-f", this.name], { timeoutMs: 30_000 });
  }

  /** One line for the terminal. */
  describe(): string {
    return `Sandbox: Docker container ${this.name} (${this.image}, network ${this.network ? "on" : "off"}).`;
  }

  /** Lines for the <project> block. */
  notes(): string[] {
    return [
      `Commands run in a Docker container (image ${this.image}, network ${this.network ? "on" : "off"}), with the repository mounted at the same path: the file tools and bash see the same files.${this.network ? "" : " Nothing can be downloaded."}`,
      ...(this.hasGit ? [] : ["git is not installed in the container; the harness handles git (branch, diff, commit) outside it."]),
    ];
  }
}
