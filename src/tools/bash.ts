import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { ToolError, type Tool } from "./types.js";

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;
/** Output kept from the start and the end; test summaries come last, so the end gets more. */
export const OUTPUT_HEAD_CHARS = 10_000;
export const OUTPUT_TAIL_CHARS = 20_000;
/** Time between SIGTERM and SIGKILL when stopping a command. */
const KILL_GRACE_MS = 2000;

interface BashInput {
  command: string;
  timeout_seconds?: number;
}

export const bash: Tool<BashInput> = {
  spec: {
    name: "bash",
    description:
      "Run a shell command (bash) in the repository root, e.g. to run tests, build, or check git status. " +
      "Each call starts a fresh shell: cd and variables do not carry over, so use 'cd dir && cmd'. " +
      "There is no input: use non-interactive flags (-y, --yes, --no-edit). " +
      `Times out after ${DEFAULT_TIMEOUT_S}s by default (max ${MAX_TIMEOUT_S}s); background processes are stopped when the command ends. ` +
      "Returns stdout and stderr together, then the exit code; long output keeps its start and end. " +
      "Prefer view_file, grep and find_files for reading code. sudo, git push and deleting outside the repository are refused.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command, e.g. 'npm test' or 'pytest tests/test_app.py -x -q'." },
        timeout_seconds: { type: "integer", minimum: 1, description: `Stop the command after this many seconds. Default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.` },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },

  async run(input, ctx) {
    const command = input.command.trim();
    if (!command) throw new ToolError("command must not be empty");
    const root = await realpath(ctx.root);
    const refused = refusalReason(command, root);
    if (refused) throw new ToolError(`command refused: ${refused}`);
    if (ctx.signal?.aborted) throw new ToolError("command cancelled");

    const timeoutS = Math.min(input.timeout_seconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
    const result = await runCommand(command, root, timeoutS * 1000, ctx.signal);
    if (result.cancelled) throw new ToolError("command cancelled");

    const seconds = (result.durationMs / 1000).toFixed(1);
    const status = result.timedOut
      ? `timed out after ${timeoutS}s and was stopped; use a larger timeout_seconds or a narrower command`
      : result.signal
        ? `killed by ${result.signal}, ${seconds}s`
        : `exit code ${result.code}, ${seconds}s`;
    return `${result.output || "(no output)"}\n(${status})`;
  },
};

interface CommandResult {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now();
  const output = new OutputBuffer();
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: commandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so the whole tree can be stopped
    });
    let timedOut = false;
    let cancelled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let done = false;

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        // already gone
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        output: output.text(),
        code: exit?.code ?? null,
        signal: timedOut || cancelled ? null : (exit?.signal ?? null),
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
      });
    };

    child.stdout.on("data", (d: Buffer) => output.add(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => output.add(d.toString("utf8")));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err.code === "ENOENT" ? new ToolError("bash is not installed or not on PATH") : err);
    });
    child.on("exit", (code, sig) => {
      exit = { code, signal: sig };
      // Leftover background processes would keep the pipes open forever.
      killGroup("SIGKILL");
      setTimeout(finish, 500).unref();
    });
    child.on("close", finish);
  });
}

/** Keeps the first and last part of a possibly huge output, without holding all of it in memory. */
class OutputBuffer {
  private head = "";
  private tail = "";
  private cut = 0;

  add(chunk: string): void {
    if (this.head.length < OUTPUT_HEAD_CHARS) {
      const room = OUTPUT_HEAD_CHARS - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    this.tail += chunk;
    if (this.tail.length > OUTPUT_TAIL_CHARS * 2) {
      this.cut += this.tail.length - OUTPUT_TAIL_CHARS;
      this.tail = this.tail.slice(-OUTPUT_TAIL_CHARS);
    }
  }

  text(): string {
    if (this.tail.length > OUTPUT_TAIL_CHARS) {
      this.cut += this.tail.length - OUTPUT_TAIL_CHARS;
      this.tail = this.tail.slice(-OUTPUT_TAIL_CHARS);
    }
    const marker = this.cut ? `\n[... ${this.cut.toLocaleString("en-US")} characters cut ...]\n` : "";
    return clean(this.head + marker + this.tail).replace(/\n+$/, "");
  }
}

/** Removes colour codes and progress-bar redraws, which only waste tokens. */
function clean(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** Variables that look like credentials (AI_API_KEY, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, ...). */
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i;

export function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The model's commands never see the harness's keys, so a prompt injection cannot send them anywhere.
    if (!SECRET_NAME.test(key)) env[key] = value;
  }
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    DEBIAN_FRONTEND: "noninteractive",
  };
}

const REFUSED: [RegExp, string][] = [
  [/(^|[\s;&|(])(sudo|doas|su)(\s|$)/, "it would run as another user; commands run as the current user only"],
  [/\bgit(\s+-\S+(\s+\S+)?)*\s+push\b/, "git push is done by the harness, not by commands"],
  [/(^|[\s;&|(])(shutdown|reboot|halt|poweroff)(\s|$)/, "it would shut down the machine"],
  [/\bmkfs\b|\bdd\b[^;&|]*\bof=\/dev\//, "it would write to a disk device"],
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, "it is a fork bomb"],
  [/\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "it pipes a download into a shell"],
];

/**
 * Why a command is refused, or null. A guard rail against clear mistakes and
 * prompt injection, not a sandbox: commands still run with the user's rights.
 * shortcut: pattern checks can be worked around; run the harness in a container for untrusted repositories.
 */
export function refusalReason(command: string, root: string): string | null {
  for (const [pattern, reason] of REFUSED) if (pattern.test(command)) return reason;

  for (const segment of command.split(/[;&|\n()]+/)) {
    const words = segment.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w)); // skip VAR=value prefixes
    const at = words.findIndex((w) => w === "rm" || w.endsWith("/rm"));
    if (at === -1) continue;
    for (const raw of words.slice(at + 1)) {
      if (raw.startsWith("-")) continue;
      const arg = raw.replace(/^["']|["']$/g, "");
      if (/^(~|\$HOME|\$\{HOME\})/.test(arg) || arg === "/" || arg === "/*") return `rm of '${arg}' is outside the repository`;
      const target = path.resolve(root, arg);
      if (target !== root && !target.startsWith(root + path.sep)) return `rm of '${arg}' is outside the repository`;
      const rel = path.relative(root, target);
      if (rel === "" || rel === "*" || rel === ".git" || rel.startsWith(`.git${path.sep}`)) {
        return `rm of '${arg}' would delete the repository or its .git directory`;
      }
    }
  }
  return null;
}
