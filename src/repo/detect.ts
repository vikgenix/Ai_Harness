import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { NOT_EXPANDED } from "../tools/files.js";

/**
 * Works out how a repository is built and tested from its project files
 * (pyproject.toml, package.json, go.mod, ...), so the agent does not spend
 * steps finding out. Nothing from the repository is run: only files are read,
 * and the installed tools are asked for their version from outside it.
 */

export interface Ecosystem {
  /** "Python", "Node.js", "Go", ... */
  name: string;
  /** Directory it was found in, relative to the root ("." for the root). */
  dir: string;
  /** The file it was detected from. */
  manifest: string;
  packageManager?: string;
  /** Required runtime version, e.g. ">=3.10" (from requires-python, engines.node, go.mod, ...). */
  requires?: string;
  /** Command that installs the dependencies (informational; it is not run here). */
  install?: string;
  /** Command that runs the test suite, and why it was chosen. */
  test?: { command: string; reason: string };
  /** How to run one test file or test, with <file> or <name> as the placeholder. */
  testOne?: string;
  /** Tools the commands need, e.g. ["python3", "uv"]. */
  tools: string[];
  /** Python: what a pip-style install covers (used when there is no lockfile tool). */
  pip?: PipInstall;
}

export interface PipInstall {
  /** The directory is a package: install it with `pip install -e .`. */
  editable: boolean;
  /** Optional-dependency extras for testing, e.g. ["test"]. */
  extras: string[];
  /** Dependency groups (PEP 735) for testing, e.g. ["dev"]. */
  groups: string[];
  /** Requirements files to install, relative to the ecosystem's directory. */
  requirements: string[];
}

export interface ProjectInfo {
  ecosystems: Ecosystem[];
  /** Other ways the project runs its tests: CI steps, Makefile targets, tox. */
  hints: string[];
  /** Version of each needed tool, or null if it is not installed. */
  tools: Record<string, string | null>;
}

/** Ecosystems listed at most; a big monorepo is summarized by its first few. */
const MAX_ECOSYSTEMS = 4;
const MAX_CI_HINTS = 5;
const MAX_READ_BYTES = 512 * 1024;
const VERSION_TIMEOUT_MS = 5000;
/** First-level directories that hold examples or docs, not the project. */
const SKIP_SUBDIRS = new Set(["docs", "doc", "examples", "example", "samples", "sample", "benchmarks", "bench", "fixtures", "test", "tests", "testdata", "vendor", "third_party"]);
/** What a test step in CI looks like. */
const TEST_COMMAND = /\b(pytest|tox|nox|unittest|manage\.py test|runtests\.py|(npm|pnpm|yarn|bun)( run)? test\b|vitest|jest|mocha|go test|cargo (test|nextest)|mvnw?\b.*\b(test|verify)\b|gradlew?\b.*\b(test|check)\b|rspec|rake test|phpunit|composer test|dotnet test|make (test|check)\b|ctest)\b/;

/** Reads a project file of the repository (small files only). */
class Repo {
  constructor(readonly root: string) {}

  async read(rel: string): Promise<string | undefined> {
    try {
      const file = path.join(this.root, rel);
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_READ_BYTES) return undefined;
      return await readFile(file, "utf8");
    } catch {
      return undefined;
    }
  }

  async exists(rel: string): Promise<boolean> {
    return stat(path.join(this.root, rel)).then(
      () => true,
      () => false,
    );
  }

  async list(rel: string): Promise<string[]> {
    return readdir(path.join(this.root, rel)).catch(() => [] as string[]);
  }
}

// --- ecosystems ------------------------------------------------------------------

type Detector = (repo: Repo, dir: string, strongOnly: boolean) => Promise<Ecosystem | undefined>;
const join = (dir: string, file: string) => (dir === "." ? file : `${dir}/${file}`);

const python: Detector = async (repo, dir, strongOnly) => {
  const at = (f: string) => join(dir, f);
  const files = await repo.list(dir);
  const requirements = files.filter((f) => /^requirements.*\.txt$/.test(f)).sort();
  const manifest = ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"].find((f) => files.includes(f)) ?? (strongOnly ? undefined : requirements[0]);
  if (!manifest) return undefined;

  const pyproject = (await repo.read(at("pyproject.toml"))) ?? "";
  const setupCfg = (await repo.read(at("setup.cfg"))) ?? "";
  const tox = (await repo.read(at("tox.ini"))) ?? "";
  const texts = [pyproject, setupCfg, tox, (await repo.read(at("setup.py"))) ?? "", (await repo.read(at("Pipfile"))) ?? ""];
  for (const r of requirements) texts.push((await repo.read(at(r))) ?? "");

  const packageManager = files.includes("uv.lock")
    ? "uv"
    : files.includes("poetry.lock") || /^\[tool\.poetry\]/m.test(pyproject)
      ? "poetry"
      : files.includes("Pipfile")
        ? "pipenv"
        : files.includes("pdm.lock")
          ? "pdm"
          : "pip";
  const testKey = /^(test|tests|testing|dev)$/;
  const extras = tomlKeys(pyproject, "project.optional-dependencies").filter((k) => testKey.test(k)).slice(0, 1);
  const groups = tomlKeys(pyproject, "dependency-groups").filter((k) => testKey.test(k));
  const editable = files.includes("setup.py") || files.includes("setup.cfg") || /^\[(project|build-system|tool\.poetry)\]/m.test(pyproject);
  // A package brings its own dependencies; otherwise the requirements files are the dependencies (docs ones aside).
  const pipRequirements = editable ? requirements.filter((r) => /dev|test/.test(r)) : requirements.filter((r) => !/doc/.test(r));
  const pip: PipInstall = { editable, extras, groups, requirements: pipRequirements };
  const install = {
    uv: "uv sync",
    poetry: "poetry install",
    pipenv: "pipenv install --dev",
    pdm: "pdm install",
    pip: ["pip install", editable ? `-e .${extras.length ? `[${extras[0]}]` : ""}` : "", ...pipRequirements.map((r) => `-r ${r}`)].filter(Boolean).join(" "),
  }[packageManager];

  // Which test runner: configured or listed pytest, Django's runners, else unittest.
  const pytestConfig = files.includes("pytest.ini")
    ? "pytest.ini"
    : /^\[tool\.pytest/m.test(pyproject)
      ? "pyproject.toml"
      : /^\[tool:pytest\]/m.test(setupCfg)
        ? "setup.cfg"
        : /^\[pytest\]/m.test(tox)
          ? "tox.ini"
          : files.includes("conftest.py") || (await repo.exists(at("tests/conftest.py")))
            ? "conftest.py"
            : undefined;
  const mentionsPytest = texts.some((t) => /\bpytest\b/.test(t));
  let test: Ecosystem["test"];
  let testOne: string | undefined;
  const py = "{python}"; // filled in once the installed interpreter is known
  if (pytestConfig || mentionsPytest) {
    test = { command: `${py} -m pytest`, reason: pytestConfig ? `pytest is configured in ${pytestConfig}` : "pytest is listed in the project files" };
    testOne = `${py} -m pytest <file>::<test name>`;
  } else if (await repo.exists(at("tests/runtests.py"))) {
    test = { command: `${py} tests/runtests.py`, reason: "the project has its own test runner, tests/runtests.py" };
    testOne = `${py} tests/runtests.py <module or test label>`;
  } else if (files.includes("manage.py")) {
    test = { command: `${py} manage.py test`, reason: "Django project (manage.py)" };
    testOne = `${py} manage.py test <app.tests.TestCase>`;
  } else if (files.includes("tests") || files.includes("test")) {
    const testDir = files.includes("tests") ? "tests" : "test";
    test = { command: `${py} -m unittest discover -s ${testDir}`, reason: `no pytest configuration; ${testDir}/ found` };
    testOne = `${py} -m unittest <module.TestCase>`;
  }

  const requires = /^requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ?? /python_requires\s*=\s*["']?([^"'\n,]+)/.exec(setupCfg + texts[3])?.[1]?.trim();
  return {
    name: "Python",
    dir,
    manifest: at(manifest),
    packageManager,
    requires,
    install,
    test,
    testOne,
    tools: ["python", ...(packageManager === "pip" ? [] : [packageManager])],
    pip,
  };
};

/** Keys directly under a TOML table, e.g. the extras in [project.optional-dependencies]. */
function tomlKeys(toml: string, table: string): string[] {
  const keys: string[] = [];
  let inside = false;
  for (const line of toml.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) inside = header[1]!.trim() === table;
    else if (inside) {
      const key = /^\s*["']?([\w.-]+)["']?\s*=/.exec(line)?.[1];
      if (key) keys.push(key);
    }
  }
  return keys;
}

const NPM_PLACEHOLDER = /no test specified/;

const node: Detector = async (repo, dir) => {
  const at = (f: string) => join(dir, f);
  const text = await repo.read(at("package.json"));
  if (text === undefined) return undefined;
  let pkg: { scripts?: Record<string, string>; packageManager?: string; engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(text);
  } catch {
    return { name: "Node.js", dir, manifest: at("package.json"), tools: ["node"] };
  }
  const files = await repo.list(dir);
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager ?? "")?.[1];
  const pm =
    declared ??
    (files.includes("pnpm-lock.yaml") ? "pnpm" : files.includes("yarn.lock") ? "yarn" : files.includes("bun.lockb") || files.includes("bun.lock") ? "bun" : "npm");
  const install = { npm: files.includes("package-lock.json") ? "npm ci" : "npm install", pnpm: "pnpm install", yarn: "yarn install", bun: "bun install" }[pm];
  const exec = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" }[pm];

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.test;
  const runner = ["vitest", "jest", "mocha", "ava"].find((r) => r in deps || script?.includes(r)) ?? (script?.includes("node --test") ? "node --test" : undefined);
  let test: Ecosystem["test"];
  if (script && !NPM_PLACEHOLDER.test(script)) {
    test = { command: pm === "bun" ? "bun run test" : `${pm} test`, reason: `package.json "test" script: ${script.length > 80 ? `${script.slice(0, 79)}…` : script}` };
  } else if (runner && runner !== "node --test") {
    test = { command: `${exec} ${runner}${runner === "vitest" ? " run" : ""}`, reason: `${runner} is a dependency (no "test" script)` };
  }
  const testOne = runner
    ? runner === "node --test"
      ? "node --test <file>"
      : `${exec} ${runner}${runner === "vitest" ? " run" : ""} <file>`
    : undefined;

  return {
    name: "Node.js",
    dir,
    manifest: at("package.json"),
    packageManager: pm,
    requires: pkg.engines?.node,
    install,
    test,
    testOne,
    tools: ["node", ...(pm === "npm" ? [] : [pm])],
  };
};

const go: Detector = async (repo, dir) => {
  const mod = await repo.read(join(dir, "go.mod"));
  if (mod === undefined) return undefined;
  return {
    name: "Go",
    dir,
    manifest: join(dir, "go.mod"),
    requires: /^go\s+(\S+)/m.exec(mod)?.[1],
    install: "go mod download",
    test: { command: "go test ./...", reason: "go.mod" },
    testOne: "go test ./<package dir> -run <TestName>",
    tools: ["go"],
  };
};

const rust: Detector = async (repo, dir) => {
  const cargo = await repo.read(join(dir, "Cargo.toml"));
  if (cargo === undefined) return undefined;
  return {
    name: "Rust",
    dir,
    manifest: join(dir, "Cargo.toml"),
    requires: /^rust-version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1],
    install: "cargo fetch",
    test: { command: "cargo test", reason: "Cargo.toml" },
    testOne: "cargo test <test name>",
    tools: ["cargo"],
  };
};

const java: Detector = async (repo, dir) => {
  const files = await repo.list(dir);
  if (files.includes("pom.xml")) {
    const mvn = files.includes("mvnw") ? "./mvnw" : "mvn";
    return {
      name: "Java (Maven)",
      dir,
      manifest: join(dir, "pom.xml"),
      packageManager: "maven",
      install: `${mvn} -q dependency:resolve`,
      test: { command: `${mvn} -q test`, reason: "pom.xml" },
      testOne: `${mvn} -q test -Dtest=<ClassName>`,
      tools: ["java", ...(mvn === "mvn" ? ["mvn"] : [])],
    };
  }
  const gradleFile = ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"].find((f) => files.includes(f));
  if (!gradleFile) return undefined;
  const gradle = files.includes("gradlew") ? "./gradlew" : "gradle";
  return {
    name: "Java/Kotlin (Gradle)",
    dir,
    manifest: join(dir, gradleFile),
    packageManager: "gradle",
    test: { command: `${gradle} test`, reason: gradleFile },
    testOne: `${gradle} test --tests <ClassName>`,
    tools: ["java", ...(gradle === "gradle" ? ["gradle"] : [])],
  };
};

const ruby: Detector = async (repo, dir) => {
  const gemfile = await repo.read(join(dir, "Gemfile"));
  if (gemfile === undefined) return undefined;
  const files = await repo.list(dir);
  const rspec = files.includes(".rspec") || files.includes("spec") || /\brspec\b/.test(gemfile);
  return {
    name: "Ruby",
    dir,
    manifest: join(dir, "Gemfile"),
    packageManager: "bundler",
    install: "bundle install",
    test: rspec ? { command: "bundle exec rspec", reason: "RSpec (spec/ or .rspec)" } : { command: "bundle exec rake test", reason: "Gemfile, no RSpec" },
    testOne: rspec ? "bundle exec rspec <file>:<line>" : "bundle exec ruby -Itest <file>",
    tools: ["ruby", "bundle"],
  };
};

const php: Detector = async (repo, dir) => {
  const text = await repo.read(join(dir, "composer.json"));
  if (text === undefined) return undefined;
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    // listed without a test command
  }
  const files = await repo.list(dir);
  const phpunit = files.includes("phpunit.xml") || files.includes("phpunit.xml.dist");
  return {
    name: "PHP",
    dir,
    manifest: join(dir, "composer.json"),
    packageManager: "composer",
    install: "composer install",
    test: "test" in scripts ? { command: "composer test", reason: 'composer.json "test" script' } : phpunit ? { command: "vendor/bin/phpunit", reason: "phpunit.xml" } : undefined,
    testOne: phpunit ? "vendor/bin/phpunit <file>" : undefined,
    tools: ["php", "composer"],
  };
};

const dotnet: Detector = async (repo, dir) => {
  const project = (await repo.list(dir)).find((f) => /\.(sln|csproj|fsproj)$/.test(f));
  if (!project) return undefined;
  return {
    name: ".NET",
    dir,
    manifest: join(dir, project),
    install: "dotnet restore",
    test: { command: "dotnet test", reason: project },
    testOne: 'dotnet test --filter "FullyQualifiedName~<Name>"',
    tools: ["dotnet"],
  };
};

const DETECTORS: Detector[] = [python, node, go, rust, java, ruby, php, dotnet];

// --- hints -----------------------------------------------------------------------

async function ciHints(repo: Repo): Promise<string[]> {
  const dir = ".github/workflows";
  const hints: string[] = [];
  for (const file of (await repo.list(dir)).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    let doc: unknown;
    try {
      doc = parseYaml((await repo.read(`${dir}/${file}`)) ?? "");
    } catch {
      continue;
    }
    const jobs = (doc as { jobs?: Record<string, { steps?: { run?: unknown }[] }> } | null)?.jobs ?? {};
    for (const job of Object.values(jobs)) {
      for (const step of job?.steps ?? []) {
        if (typeof step?.run !== "string") continue;
        for (const line of step.run.split("\n").map((l) => l.trim())) {
          if (TEST_COMMAND.test(line) && !line.startsWith("#")) hints.push(`CI runs \`${line.length > 100 ? `${line.slice(0, 99)}…` : line}\` (${dir}/${file})`);
        }
      }
    }
  }
  return [...new Set(hints)].slice(0, MAX_CI_HINTS);
}

async function otherHints(repo: Repo): Promise<string[]> {
  const hints: string[] = [];
  const makefile = (await repo.read("Makefile")) ?? (await repo.read("makefile"));
  const target = makefile && /^(test|tests|check)\s*:/m.exec(makefile)?.[1];
  if (target) hints.push(`the Makefile has a \`${target}\` target (make ${target})`);
  if (await repo.exists("tox.ini")) hints.push("tox.ini (tox runs the tests in fresh environments; slower than running them directly)");
  if (await repo.exists("noxfile.py")) hints.push("noxfile.py (nox sessions)");
  return hints;
}

// --- installed tools -------------------------------------------------------------

const run = (cmd: string, args: string[]) =>
  new Promise<string | null>((resolve) => {
    // From a temporary directory, so no file of the repository can affect it (version files, toolchain switches).
    execFile(cmd, args, { cwd: tmpdir(), timeout: VERSION_TIMEOUT_MS, env: { ...process.env, GOTOOLCHAIN: "local" } }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
      resolve(`${stdout}\n${stderr}`);
    });
  });

const VERSION_ARGS: Record<string, string[]> = { go: ["version"], java: ["-version"] };

/** The tool's version ("3.12.4"), "installed" if it prints none, or null if it is not on PATH. */
export async function toolVersion(tool: string): Promise<string | null> {
  const out = await run(tool, VERSION_ARGS[tool] ?? ["--version"]);
  if (out === null) return null;
  return /\d+\.\d+(\.\d+)?/.exec(out)?.[0] ?? "installed";
}

// --- detection -------------------------------------------------------------------

/** Detects the ecosystems, test commands and tools of the repository at `root`. */
export async function detectProject(root: string, opts: { versionOf?: (tool: string) => Promise<string | null> } = {}): Promise<ProjectInfo> {
  const repo = new Repo(root);
  const versionOf = opts.versionOf ?? toolVersion;
  const ecosystems: Ecosystem[] = [];

  const detectIn = async (dir: string, strongOnly: boolean) => {
    for (const detect of DETECTORS) {
      if (ecosystems.length >= MAX_ECOSYSTEMS) return;
      const found = await detect(repo, dir, strongOnly);
      // In a subdirectory, an ecosystem already found at the root is part of it (workspaces, Cargo members).
      if (found && !(dir !== "." && ecosystems.some((e) => e.dir === "." && e.name === found.name))) ecosystems.push(found);
    }
  };
  await detectIn(".", false);
  const subdirs = [];
  for (const name of (await repo.list(".")).sort()) {
    if (name.startsWith(".") || NOT_EXPANDED.has(name) || SKIP_SUBDIRS.has(name.toLowerCase())) continue;
    if ((await stat(path.join(root, name)).catch(() => undefined))?.isDirectory()) subdirs.push(name);
  }
  for (const dir of subdirs.slice(0, 50)) await detectIn(dir, true);

  const hints = [...(await ciHints(repo)), ...(await otherHints(repo))];

  // Python is "python" in a virtualenv but often only "python3" outside one.
  const wanted = [...new Set(ecosystems.flatMap((e) => e.tools.flatMap((t) => (t === "python" ? ["python3", "python"] : [t]))))];
  const versions = await Promise.all(wanted.map(versionOf));
  const tools: Record<string, string | null> = {};
  wanted.forEach((t, i) => (tools[t] = versions[i]!));
  if ("python" in tools) {
    const py = tools.python3 !== null ? "python3" : tools.python !== null ? "python" : "python3";
    delete tools[py === "python3" ? "python" : "python3"]; // report only the interpreter the commands use
    for (const e of ecosystems) {
      if (e.test) e.test.command = e.test.command.replace("{python}", py);
      if (e.testOne) e.testOne = e.testOne.replace("{python}", py);
      e.tools = e.tools.map((t) => (t === "python" ? py : t));
    }
  }
  return { ecosystems, hints, tools };
}

// --- output ----------------------------------------------------------------------

/**
 * The detection as a block for the start of the task message. `dependencies`
 * says what the harness installed (replacing the "may not be installed" note).
 */
export function projectBlock(info: ProjectInfo, dependencies?: string[]): string {
  const lines = ["<project>"];
  if (!info.ecosystems.length) {
    lines.push("No known project files (pyproject.toml, package.json, go.mod, ...) were found. Look at the README for how to build and test.");
  } else {
    lines.push("Detected from the project files (check them if a command fails):");
    for (const e of info.ecosystems) {
      const where = e.dir === "." ? "" : ` in ${e.dir}/`;
      const pm = e.packageManager ? `, package manager ${e.packageManager}` : "";
      const req = e.requires ? `, requires ${e.requires}` : "";
      lines.push(`- ${e.name}${where} (${e.manifest}${pm}${req})`);
      lines.push(e.test ? `  Tests: ${e.test.command}  (${e.test.reason})` : "  Tests: no test command found");
      if (e.testOne) lines.push(`  One test: ${e.testOne}`);
      if (e.install) lines.push(`  Install: ${e.install}`);
    }
  }
  if (info.hints.length) lines.push("Also:", ...info.hints.map((h) => `- ${h}`));
  const have = Object.entries(info.tools).filter(([, v]) => v !== null);
  const missing = Object.entries(info.tools).filter(([, v]) => v === null).map(([t]) => t);
  if (have.length) lines.push(`Installed: ${have.map(([t, v]) => `${t} ${v}`).join(", ")}`);
  if (missing.length) lines.push(`Not installed: ${missing.join(", ")} (commands that need them will fail; say so in the summary if the tests cannot run)`);
  if (dependencies?.length) lines.push(...dependencies);
  else if (info.ecosystems.length) lines.push("Dependencies may not be installed yet: if the tests fail to import packages, install them first.");
  lines.push("</project>");
  return lines.join("\n");
}

/** The task message with the project block in front. */
export function withProject(prompt: string, info: ProjectInfo | undefined, dependencies?: string[]): string {
  return info ? `${projectBlock(info, dependencies)}\n\n${prompt}` : prompt;
}

/** One line for the terminal: "Project: Python (uv) · tests: python3 -m pytest · python3 3.12.4". */
export function describeProject(info: ProjectInfo): string {
  if (!info.ecosystems.length) return "Project: no known project files found.";
  const parts = info.ecosystems.map((e) => {
    const where = e.dir === "." ? "" : ` in ${e.dir}/`;
    return `${e.name}${where}${e.packageManager && e.packageManager !== "pip" ? ` (${e.packageManager})` : ""} · tests: ${e.test?.command ?? "none found"}`;
  });
  const missing = Object.entries(info.tools).filter(([, v]) => v === null).map(([t]) => t);
  return `Project: ${parts.join("; ")}${missing.length ? ` · not installed: ${missing.join(", ")}` : ""}`;
}

/** Detection for a task, or undefined if it fails: it only saves steps, so it never stops the task. */
export async function projectFor(root: string): Promise<ProjectInfo | undefined> {
  try {
    return await detectProject(root);
  } catch {
    return undefined;
  }
}
