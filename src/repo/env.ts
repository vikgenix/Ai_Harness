import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "../agent/fix.js";
import { commandEnv, runCommand } from "../tools/bash.js";
import { toolVersion, type Ecosystem, type ProjectInfo } from "./detect.js";

/**
 * Installs the repository's dependencies before the agent starts, so its first
 * test run works instead of failing on imports.
 *
 * Python packages go into a virtualenv outside the repository (envs/ in the
 * harness directory, one per repository), Ruby gems next to it; Node, PHP and
 * .NET install where their tools always do (node_modules/, vendor/, ...). The
 * agent's commands then run with that environment active.
 *
 * Installing must not change the repository: lockfiles the install rewrote are
 * restored, and new files it made (egg-info, node_modules/ in a repository
 * without a .gitignore, ...) are listed in .git/info/exclude so they are never
 * committed. An install whose project files have not changed since the last
 * successful one is skipped.
 *
 * Installing runs the project's build code (setup.py, install scripts), just
 * as running its tests does; the credentials of the harness are not passed to it.
 */

/** Environments go here (git-ignored, removed by `make clean`). */
export const DEFAULT_ENVS_DIR = fileURLToPath(new URL("../../envs/", import.meta.url));
export const DEFAULT_INSTALL_TIMEOUT_S = 600;
/** Output of a failed command kept for the agent. */
const FAILURE_LINES = 6;
const FAILURE_CHARS = 800;

export interface InstallStep {
  command: string;
  /** Directory it runs in, relative to the repository root. */
  dir: string;
  env?: Record<string, string>;
  /** If it fails, the ecosystem's later steps are not run. */
  required?: boolean;
}

export interface InstallPlan {
  ecosystem: Ecosystem;
  steps: InstallStep[];
  /** Why nothing is installed for this ecosystem. */
  skip?: string;
}

export type InstallStatus = "installed" | "up_to_date" | "failed" | "skipped";

export interface InstallResult {
  name: string;
  dir: string;
  status: InstallStatus;
  /** Commands run (or, when up to date, run earlier). */
  commands: string[];
  durationMs: number;
  /** The first command that failed. */
  failed?: string;
  /** Why it was skipped, or the end of the failed command's output. */
  detail?: string;
}

export interface EnvSetup {
  /** Where this repository's environment lives. */
  envDir: string;
  /** Environment for the agent's commands (VIRTUAL_ENV, PATH, BUNDLE_PATH). */
  env: Record<string, string>;
  results: InstallResult[];
  /** Tracked files the install changed, put back. */
  restored: string[];
  /** New paths the install made, added to .git/info/exclude. */
  excluded: string[];
  durationMs: number;
}

export interface StepOutcome {
  ok: boolean;
  /** e.g. "exit 1", "timed out after 600s". */
  status: string;
  output: string;
  cancelled: boolean;
}

export interface PrepareOptions {
  envsDir?: string;
  timeoutS?: number;
  signal?: AbortSignal;
  /** One line per ecosystem as it starts and ends. */
  onProgress?(line: string): void;
  /** For tests: runs one command (default: bash, with credentials removed from the environment). */
  run?(step: InstallStep, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<StepOutcome>;
  /** For tests: whether a tool is installed (default: asks the tool for its version). */
  versionOf?(tool: string): Promise<string | null>;
}

/** The environment directory for a repository: envs/<name>-<hash of its path>. */
export function envDirFor(root: string, envsDir = DEFAULT_ENVS_DIR): string {
  const real = realRoot(root);
  const name = path.basename(real).replace(/[^\w.-]+/g, "_").slice(0, 40) || "repo";
  return path.join(envsDir, `${name}-${createHash("sha256").update(real).digest("hex").slice(0, 10)}`);
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

const venvOf = (envDir: string) => path.join(envDir, "venv");
const bundleOf = (envDir: string) => path.join(envDir, "bundle");

// --- plans -----------------------------------------------------------------------

/** Quotes a word for bash if it needs it. */
const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

interface PlanContext {
  root: string;
  envDir: string;
  /** Installed tools: name to version, null if missing. */
  tools: Record<string, string | null>;
}

/** The install commands for one ecosystem. */
export function planInstall(e: Ecosystem, c: PlanContext): InstallPlan {
  const has = (f: string) => existsSync(path.join(c.root, e.dir, f));
  // A tool detection did not look for (npm comes with node) counts as installed.
  const missing = (tools: string[]) => tools.filter((t) => c.tools[t] === null);
  const plan = (steps: (Omit<InstallStep, "dir"> | false)[]): InstallPlan => ({ ecosystem: e, steps: steps.filter((s) => s !== false).map((s) => ({ dir: e.dir, ...s })) });
  const skip = (why: string): InstallPlan => ({ ecosystem: e, steps: [], skip: why });
  const notInstalled = (tools: string[]) => skip(`${tools.join(", ")} ${tools.length === 1 ? "is" : "are"} not installed`);

  switch (e.name) {
    case "Python": {
      const venv = venvOf(c.envDir);
      const env = { VIRTUAL_ENV: venv, PATH: `${path.join(venv, "bin")}${path.delimiter}${process.env.PATH ?? ""}` };
      const uv = Boolean(c.tools.uv);
      const python = e.tools.find((t) => t === "python3" || t === "python") ?? "python3";
      if (!uv && !c.tools[python]) return notInstalled([python]);
      // uv also picks a Python that fits requires-python, downloading one if none installed does.
      const pipInstall = (args: string[]) => (uv ? `uv pip install --quiet ${args.join(" ")}` : `python -m pip install --quiet --disable-pip-version-check ${args.join(" ")}`);
      const venvStep = { command: uv ? 'uv venv --quiet --allow-existing "$VIRTUAL_ENV"' : `${python} -m venv "$VIRTUAL_ENV"`, env, required: true };
      const pytest = /\bpytest\b/.test(e.test?.command ?? "") && { command: pipInstall(["pytest"]), env };

      if (e.packageManager === "uv" && uv) return plan([venvStep, { command: "uv sync --frozen", env: { ...env, UV_PROJECT_ENVIRONMENT: venv } }, pytest]);
      if (e.packageManager === "poetry" && c.tools.poetry) return plan([venvStep, { command: "poetry install --no-interaction", env }, pytest]);
      if (e.packageManager === "pipenv" && c.tools.pipenv) return plan([venvStep, { command: has("Pipfile.lock") ? "pipenv sync --dev" : "pipenv install --dev", env: { ...env, PIPENV_YES: "1" } }, pytest]);
      const pip = e.pip ?? { editable: false, extras: [], groups: [], requirements: [] };
      return plan([
        venvStep,
        pip.requirements.length > 0 && { command: pipInstall(pip.requirements.map((r) => `-r ${q(r)}`)), env },
        pip.editable && {
          command: pipInstall([`-e ${q(`.${pip.extras.length ? `[${pip.extras.join(",")}]` : ""}`)}`, ...(uv ? pip.groups.map((g) => `--group ${q(g)}`) : [])]),
          env,
        },
        pytest,
      ]);
    }
    case "Node.js": {
      const pm = e.packageManager ?? "npm";
      const need = missing(["node", pm]);
      if (need.length) return notInstalled(need);
      // CI=1 makes pnpm and yarn refuse to update an outdated lockfile; then retry allowing it (the lockfile is restored afterwards).
      const command = {
        npm: has("package-lock.json") || has("npm-shrinkwrap.json") ? "npm ci --no-audit --no-fund || npm install --no-audit --no-fund" : "npm install --no-audit --no-fund",
        pnpm: "pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile",
        yarn: "yarn install || YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install",
        bun: "bun install",
      }[pm];
      return command ? plan([{ command }]) : skip(`unknown package manager ${pm}`);
    }
    case "Go":
      return missing(["go"]).length ? notInstalled(["go"]) : plan([{ command: "go mod download" }]);
    case "Rust":
      return missing(["cargo"]).length ? notInstalled(["cargo"]) : plan([{ command: "cargo fetch" }]);
    case "Ruby": {
      const need = missing(["ruby", "bundle"]);
      return need.length ? notInstalled(need) : plan([{ command: "bundle install", env: { BUNDLE_PATH: bundleOf(c.envDir) } }]);
    }
    case "PHP": {
      const need = missing(["php", "composer"]);
      return need.length ? notInstalled(need) : plan([{ command: "composer install --no-interaction --no-progress" }]);
    }
    case ".NET":
      return missing(["dotnet"]).length ? notInstalled(["dotnet"]) : plan([{ command: "dotnet restore" }]);
    default:
      // Maven and Gradle download what they need on the first build.
      return skip("the first build downloads them");
  }
}

// --- up-to-date check ------------------------------------------------------------

/** Files whose content decides what gets installed. */
const MANIFEST =
  /^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile(\.lock)?|poetry\.lock|uv\.lock|pdm\.lock|requirements.*\.txt|\.python-version|package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|.*\.(csproj|fsproj|sln))$/;

async function fingerprint(root: string, plan: InstallPlan): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(plan.steps));
  const dir = path.join(root, plan.ecosystem.dir);
  for (const file of (await readdir(dir).catch(() => [] as string[])).filter((f) => MANIFEST.test(f)).sort()) {
    hash.update(`\0${file}\0`).update(await readFile(path.join(dir, file)).catch(() => Buffer.alloc(0)));
  }
  return hash.digest("hex");
}

/** Whether what an earlier install made is still there. */
function stillInstalled(root: string, envDir: string, e: Ecosystem): boolean {
  if (e.name === "Python") return existsSync(path.join(venvOf(envDir), "bin", "python"));
  if (e.name === "Node.js") return existsSync(path.join(root, e.dir, "node_modules"));
  if (e.name === "Ruby") return existsSync(bundleOf(envDir));
  return true;
}

const stampFile = (envDir: string, e: Ecosystem) => path.join(envDir, "stamps", `${e.name}-${e.dir}`.replace(/[^\w.-]+/g, "_"));

// --- keeping the repository clean ------------------------------------------------

/** `git status` as path to status code ("??" for untracked), or undefined outside a git repository. */
export async function statusOf(root: string): Promise<Map<string, string> | undefined> {
  let out: string;
  try {
    out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  } catch {
    return undefined;
  }
  const entries = new Map<string, string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    entries.set(entry.slice(3), code);
    if (code[0] === "R" || code[0] === "C") i++; // followed by the old name
  }
  return entries;
}

/**
 * Puts back tracked files changed since `before` (a statusOf snapshot) and
 * lists new files in .git/info/exclude, so what the harness itself ran
 * (an install, the baseline tests) never ends up in a fix.
 */
export async function keepClean(root: string, before: Map<string, string>, madeBy = "installing dependencies"): Promise<{ restored: string[]; excluded: string[] }> {
  const after = (await statusOf(root)) ?? new Map<string, string>();
  const changed = [...after].filter(([p, code]) => before.get(p) !== code);
  const restored = changed.filter(([p, code]) => code !== "??" && !before.has(p)).map(([p]) => p);
  const excluded = changed.filter(([p, code]) => code === "??" && !before.has(p)).map(([p]) => p);
  if (restored.length) await git(root, ["checkout", "-q", "--", ...restored]).catch(() => undefined);
  if (excluded.length) {
    const file = path.resolve(root, await git(root, ["rev-parse", "--git-path", "info/exclude"]));
    await mkdir(path.dirname(file), { recursive: true });
    const lines = excluded.map((p) => `/${p.replace(/([\\*?[])/g, "\\$1")}`);
    await appendFile(file, `\n# Made by ${madeBy} (AI Harness)\n${lines.join("\n")}\n`);
  }
  return { restored, excluded };
}

// --- running ---------------------------------------------------------------------

async function runStep(step: InstallStep, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<StepOutcome> {
  const r = await runCommand(step.command, cwd, timeoutMs, signal, commandEnv(env));
  const status = r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`;
  return { ok: !r.timedOut && !r.cancelled && r.code === 0, status, output: r.output, cancelled: r.cancelled };
}

/** The end of a command's output, for the agent. */
function tail(output: string): string {
  const lines = output.trim().split("\n").filter((l) => l.trim());
  const text = lines.slice(-FAILURE_LINES).join("\n");
  return text.length > FAILURE_CHARS ? `…${text.slice(-FAILURE_CHARS)}` : text;
}

/**
 * Installs the dependencies of every detected ecosystem. Returns undefined
 * when there is nothing to install. Never throws for a failed install: the
 * result says what failed, and the agent can still work.
 */
export async function prepareEnvironment(root: string, info: ProjectInfo, opts: PrepareOptions = {}): Promise<EnvSetup | undefined> {
  if (!info.ecosystems.length) return undefined;
  const started = Date.now();
  root = realRoot(root);
  const envDir = envDirFor(root, opts.envsDir);
  const progress = opts.onProgress ?? (() => {});
  const run = opts.run ?? runStep;
  const timeoutMs = (opts.timeoutS ?? DEFAULT_INSTALL_TIMEOUT_S) * 1000;

  const tools = { ...info.tools };
  if (info.ecosystems.some((e) => e.name === "Python") && !("uv" in tools)) tools.uv = await (opts.versionOf ?? toolVersion)("uv");
  const plans = info.ecosystems.map((e) => planInstall(e, { root, envDir, tools }));

  const before = await statusOf(root);
  const results: InstallResult[] = [];
  for (const plan of plans) {
    const e = plan.ecosystem;
    const label = `${e.name}${e.dir === "." ? "" : ` in ${e.dir}/`}`;
    const commands = plan.steps.map((s) => s.command);
    const result: InstallResult = { name: e.name, dir: e.dir, status: "installed", commands, durationMs: 0 };
    results.push(result);
    if (plan.skip || !plan.steps.length) {
      Object.assign(result, { status: "skipped", commands: [], detail: plan.skip ?? "nothing to install" });
      progress(`  · ${label}: not installed (${result.detail})`);
      continue;
    }
    const stamp = stampFile(envDir, e);
    const print = await fingerprint(root, plan);
    if ((await readFile(stamp, "utf8").catch(() => "")) === print && stillInstalled(root, envDir, e)) {
      result.status = "up_to_date";
      progress(`  = ${label}: up to date (installed earlier)`);
      continue;
    }

    progress(`  ${label}: ${commands.join("; ")}`);
    const t0 = Date.now();
    await mkdir(envDir, { recursive: true });
    for (const step of plan.steps) {
      const outcome = await run(step, path.join(root, step.dir), step.env ?? {}, timeoutMs, opts.signal);
      if (outcome.ok) continue;
      if (result.status !== "failed") Object.assign(result, { status: "failed", failed: step.command, detail: `${outcome.status}${outcome.output.trim() ? `: ${tail(outcome.output)}` : ""}` });
      if (outcome.cancelled || step.required) break;
    }
    result.durationMs = Date.now() - t0;
    const secs = `${(result.durationMs / 1000).toFixed(1)}s`;
    if (result.status === "installed") {
      await mkdir(path.dirname(stamp), { recursive: true });
      await writeFile(stamp, print);
      progress(`  ✓ ${label}: installed in ${secs}`);
    } else {
      progress(`  ✗ ${label}: \`${result.failed}\` failed (${result.detail!.split(":")[0]}, ${secs})`);
    }
    if (opts.signal?.aborted) break;
  }

  const clean = before ? await keepClean(root, before) : { restored: [], excluded: [] };
  return {
    envDir,
    env: environmentVars(root, envDir, info.ecosystems.filter((e) => e.name === "Node.js").map((e) => e.dir)),
    results,
    ...clean,
    durationMs: Date.now() - started,
  };
}

/** Environment variables that activate what is installed: the virtualenv, gems, node_modules/.bin. */
export function environmentVars(root: string, envDir: string, nodeDirs: string[] = ["."]): Record<string, string> {
  const env: Record<string, string> = {};
  const binDirs: string[] = [];
  const venv = venvOf(envDir);
  if (existsSync(path.join(venv, "bin", "python"))) {
    env.VIRTUAL_ENV = venv;
    binDirs.push(path.join(venv, "bin"));
  }
  if (existsSync(bundleOf(envDir))) env.BUNDLE_PATH = bundleOf(envDir);
  for (const dir of nodeDirs) {
    const bin = path.join(root, dir, "node_modules", ".bin");
    if (existsSync(bin)) binDirs.push(bin);
  }
  if (binDirs.length) env.PATH = [...binDirs, process.env.PATH ?? ""].join(path.delimiter);
  return env;
}

/** The environment installed for this repository in an earlier session, to use again (e.g. after /repo). */
export function existingEnvironment(root: string, envsDir = DEFAULT_ENVS_DIR): Record<string, string> | undefined {
  const real = realRoot(root);
  const env = environmentVars(real, envDirFor(real, envsDir));
  return Object.keys(env).length ? env : undefined;
}

// --- output ----------------------------------------------------------------------

/** Lines for the <project> block: what was installed, what failed and what to do about it. */
export function dependencyLines(setup: EnvSetup): string[] {
  const lines = ["Dependencies (installed by the harness before you started; your bash commands use them):"];
  for (const r of setup.results) {
    const label = `${r.name}${r.dir === "." ? "" : ` in ${r.dir}/`}`;
    if (r.status === "installed") lines.push(`- ${label}: installed (${r.commands.join("; ")})`);
    else if (r.status === "up_to_date") lines.push(`- ${label}: installed (unchanged since an earlier run)`);
    else if (r.status === "skipped") lines.push(`- ${label}: not installed beforehand (${r.detail})`);
    else lines.push(`- ${label}: \`${r.failed}\` failed (${r.detail}). Install what the tests need yourself, or say in the summary why the tests cannot run.`);
  }
  if (setup.env.VIRTUAL_ENV) {
    lines.push("Python packages are in a virtualenv outside the repository ($VIRTUAL_ENV, first on PATH): python, pip and pytest come from it, and pip install adds to it.");
  }
  return lines;
}

/** One line for the terminal, after the per-ecosystem lines. */
export function describeSetup(setup: EnvSetup): string {
  const count = (s: InstallStatus) => setup.results.filter((r) => r.status === s).length;
  const parts = [
    count("installed") && `${count("installed")} installed`,
    count("up_to_date") && `${count("up_to_date")} up to date`,
    count("failed") && `${count("failed")} failed`,
    count("skipped") && `${count("skipped")} skipped`,
  ].filter(Boolean);
  const kept = setup.restored.length + setup.excluded.length ? ` · kept out of git: ${[...setup.restored, ...setup.excluded].slice(0, 4).join(", ")}${setup.restored.length + setup.excluded.length > 4 ? ", ..." : ""}` : "";
  return `Dependencies: ${parts.join(", ")} (${(setup.durationMs / 1000).toFixed(1)}s)${kept}.`;
}
