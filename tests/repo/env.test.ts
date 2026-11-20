import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ecosystem, ProjectInfo } from "../../src/repo/detect.js";
import {
  dependencyLines,
  describeSetup,
  envDirFor,
  environmentVars,
  existingEnvironment,
  planInstall,
  prepareEnvironment,
  type InstallStep,
  type PrepareOptions,
  type StepOutcome,
} from "../../src/repo/env.js";

const savedEnv = { ...process.env };
let base: string;
let n = 0;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await realpath(await mkdtemp(path.join(tmpdir(), "harness-env-")));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

/** A git repository with the given files committed. */
async function repo(files: Record<string, string>): Promise<string> {
  const root = path.join(base, `r${n++}`);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: root }).toString();
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  return root;
}
const status = (root: string) => execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString();

const python = (extra: Partial<Ecosystem> = {}): Ecosystem => ({
  name: "Python",
  dir: ".",
  manifest: "pyproject.toml",
  packageManager: "pip",
  test: { command: "python3 -m pytest", reason: "" },
  tools: ["python3"],
  pip: { editable: true, extras: ["test"], groups: ["dev"], requirements: ["requirements-dev.txt"] },
  ...extra,
});
const node = (extra: Partial<Ecosystem> = {}): Ecosystem => ({ name: "Node.js", dir: ".", manifest: "package.json", packageManager: "npm", tools: ["node"], ...extra });
const commands = (e: Ecosystem, tools: Record<string, string | null>, root = base) => {
  const plan = planInstall(e, { root, envDir: "/envs/x", tools });
  return plan.skip ? `skip: ${plan.skip}` : plan.steps.map((s) => s.command);
};

describe("planInstall", () => {
  it("Python with uv: a virtualenv, then uv for everything", () => {
    expect(commands(python(), { python3: "3.12", uv: "0.5" })).toEqual([
      'uv venv --quiet --allow-existing "$VIRTUAL_ENV"',
      "uv pip install --quiet -r requirements-dev.txt",
      "uv pip install --quiet -e '.[test]' --group dev",
      "uv pip install --quiet pytest",
    ]);
    expect(commands(python({ packageManager: "uv", tools: ["python3", "uv"] }), { python3: "3.12", uv: "0.5" })).toEqual([
      'uv venv --quiet --allow-existing "$VIRTUAL_ENV"',
      "uv sync --frozen",
      "uv pip install --quiet pytest",
    ]);
  });

  it("Python without uv: venv and pip; the virtualenv is active in every step", () => {
    const plan = planInstall(python({ pip: { editable: false, extras: [], groups: ["dev"], requirements: ["requirements.txt"] } }), { root: base, envDir: "/envs/x", tools: { python3: "3.12", uv: null } });
    expect(plan.steps.map((s) => s.command)).toEqual([
      'python3 -m venv "$VIRTUAL_ENV"',
      "python -m pip install --quiet --disable-pip-version-check -r requirements.txt",
      "python -m pip install --quiet --disable-pip-version-check pytest",
    ]);
    expect(plan.steps[0]).toMatchObject({ required: true, env: { VIRTUAL_ENV: "/envs/x/venv" } });
    expect(plan.steps.every((s) => s.env?.PATH?.startsWith("/envs/x/venv/bin:"))).toBe(true);
  });

  it("Python: a lockfile tool that is not installed falls back to pip; no Python at all is skipped", () => {
    expect(commands(python({ packageManager: "poetry", pip: { editable: true, extras: [], groups: [], requirements: [] } }), { python3: "3.12", poetry: null, uv: null })).toEqual([
      'python3 -m venv "$VIRTUAL_ENV"',
      "python -m pip install --quiet --disable-pip-version-check -e .",
      "python -m pip install --quiet --disable-pip-version-check pytest",
    ]);
    expect(commands(python(), { python3: null, uv: null })).toBe("skip: python3 is not installed");
  });

  it("other ecosystems", async () => {
    const root = await repo({ "package-lock.json": "{}" });
    expect(commands(node(), { node: "22" }, root)).toEqual(["npm ci --no-audit --no-fund || npm install --no-audit --no-fund"]);
    expect(commands(node(), { node: "22" })).toEqual(["npm install --no-audit --no-fund"]);
    expect(commands(node({ packageManager: "pnpm" }), { node: "22", pnpm: null })).toBe("skip: pnpm is not installed");
    expect(commands({ name: "Go", dir: ".", manifest: "go.mod", tools: ["go"] }, { go: "1.22" })).toEqual(["go mod download"]);
    const ruby = planInstall({ name: "Ruby", dir: ".", manifest: "Gemfile", tools: ["ruby", "bundle"] }, { root: base, envDir: "/envs/x", tools: { ruby: "3.3", bundle: "2.5" } });
    expect(ruby.steps[0]).toMatchObject({ command: "bundle install", env: { BUNDLE_PATH: "/envs/x/bundle" } });
    expect(commands({ name: "Java (Maven)", dir: ".", manifest: "pom.xml", tools: ["java"] }, { java: "21" })).toBe("skip: the first build downloads them");
  });
});

/** A fake command runner: records the steps and runs `effect` for each. */
function fakeRun(effect: (step: InstallStep, cwd: string) => Promise<StepOutcome | void> = async () => {}) {
  const ran: string[] = [];
  const run: PrepareOptions["run"] = async (step, cwd) => {
    ran.push(step.command);
    return (await effect(step, cwd)) ?? { ok: true, status: "exit 0", output: "", cancelled: false };
  };
  return { ran, run };
}

const info = (ecosystems: Ecosystem[], tools: Record<string, string | null> = { node: "22", python3: "3.12", uv: null }): ProjectInfo => ({ ecosystems, hints: [], tools });

describe("prepareEnvironment", () => {
  it("installs, keeps the repository clean, and skips the next time if nothing changed", async () => {
    const root = await repo({ "package.json": '{"name":"x"}', "package-lock.json": '{"lockfileVersion":3}' });
    const envsDir = path.join(base, "envs-a");
    const lines: string[] = [];
    const first = fakeRun(async (_step, cwd) => {
      await writeFile(path.join(cwd, "package-lock.json"), '{"rewritten":true}');
      await mkdir(path.join(cwd, "node_modules/.bin"), { recursive: true });
      await writeFile(path.join(cwd, "node_modules/.bin/vitest"), "");
      await mkdir(path.join(cwd, "x.egg-info"));
      await writeFile(path.join(cwd, "x.egg-info/PKG-INFO"), "");
    });
    const setup = (await prepareEnvironment(root, info([node()]), { envsDir, run: first.run, onProgress: (l) => lines.push(l) }))!;

    expect(first.ran).toEqual(["npm ci --no-audit --no-fund || npm install --no-audit --no-fund"]);
    expect(setup.results[0]).toMatchObject({ name: "Node.js", status: "installed" });
    expect(setup.restored).toEqual(["package-lock.json"]);
    expect(setup.excluded.sort()).toEqual(["node_modules/", "x.egg-info/"]);
    expect(status(root)).toBe(""); // nothing the install made shows up for a commit
    expect(await readFile(path.join(root, "package-lock.json"), "utf8")).toBe('{"lockfileVersion":3}');
    expect(setup.env.PATH?.split(path.delimiter)[0]).toBe(path.join(root, "node_modules/.bin"));
    expect(lines).toEqual(["  Node.js: npm ci --no-audit --no-fund || npm install --no-audit --no-fund", expect.stringMatching(/^ {2}✓ Node\.js: installed in \d+\.\ds$/)]);
    expect(describeSetup(setup)).toMatch(/^Dependencies: 1 installed \(\d+\.\ds\) · kept out of git: package-lock\.json, node_modules\/, x\.egg-info\/\.$/);

    const second = fakeRun();
    const again = (await prepareEnvironment(root, info([node()]), { envsDir, run: second.run }))!;
    expect(second.ran).toEqual([]);
    expect(again.results[0]?.status).toBe("up_to_date");
    expect(dependencyLines(again)).toContain("- Node.js: installed (unchanged since an earlier run)");

    // A changed manifest installs again.
    await writeFile(path.join(root, "package.json"), '{"name":"x","dependencies":{"y":"1"}}');
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qam", "deps"], { cwd: root });
    const third = fakeRun();
    expect((await prepareEnvironment(root, info([node()]), { envsDir, run: third.run }))!.results[0]?.status).toBe("installed");
    expect(third.ran).toHaveLength(1);
  });

  it("stops an ecosystem when a required step fails and tells the agent what failed", async () => {
    const root = await repo({ "pyproject.toml": "[project]\nname='x'\n" });
    const { ran, run } = fakeRun(async () => ({ ok: false, status: "exit 1", output: "line 1\nError: No matching Python for >=3.99\n", cancelled: false }));
    const setup = (await prepareEnvironment(root, info([python()]), { envsDir: path.join(base, "envs-b"), run }))!;
    expect(ran).toEqual(['python3 -m venv "$VIRTUAL_ENV"']);
    expect(setup.results[0]).toMatchObject({ status: "failed", failed: 'python3 -m venv "$VIRTUAL_ENV"', detail: "exit 1: line 1\nError: No matching Python for >=3.99" });
    expect(setup.env).toEqual({}); // no virtualenv was made, so none is activated
    expect(dependencyLines(setup)[1]).toMatch(/^- Python: `python3 -m venv "\$VIRTUAL_ENV"` failed \(exit 1: [^]*\)\. Install what the tests need yourself/);
  });

  it("goes on after an optional step fails, and activates the virtualenv", async () => {
    const root = await repo({ "pyproject.toml": "[project]\nname='x'\n" });
    const envsDir = path.join(base, "envs-c");
    const { ran, run } = fakeRun(async (step) => {
      if (step.command.includes("venv")) {
        await mkdir(path.join(step.env!.VIRTUAL_ENV!, "bin"), { recursive: true });
        await writeFile(path.join(step.env!.VIRTUAL_ENV!, "pyvenv.cfg"), "");
        await writeFile(path.join(step.env!.VIRTUAL_ENV!, "bin/python"), "");
      }
      if (step.command.includes("-e ")) return { ok: false, status: "exit 1", output: "build failed", cancelled: false };
    });
    const setup = (await prepareEnvironment(root, info([python()]), { envsDir, run }))!;
    expect(ran).toHaveLength(4);
    expect(setup.results[0]).toMatchObject({ status: "failed", failed: expect.stringContaining("-e '.[test]'") });
    const venv = path.join(envDirFor(root, envsDir), "venv");
    expect(setup.env).toMatchObject({ VIRTUAL_ENV: venv, PATH: expect.stringMatching(new RegExp(`^${venv}/bin${path.delimiter}`)) });
    expect(dependencyLines(setup).at(-1)).toMatch(/^Python packages are in a virtualenv outside the repository/);
    expect(existingEnvironment(root, envsDir)).toEqual(setup.env); // found again in a later session
  });

  it("does nothing without a detected ecosystem, and skips what cannot be installed", async () => {
    const root = await repo({ "README.md": "" });
    expect(await prepareEnvironment(root, info([]), { envsDir: path.join(base, "envs-d") })).toBeUndefined();
    const { ran, run } = fakeRun();
    const setup = (await prepareEnvironment(root, info([node({ packageManager: "yarn" })], { node: "22", yarn: null }), { envsDir: path.join(base, "envs-d"), run }))!;
    expect(ran).toEqual([]);
    expect(setup.results[0]).toMatchObject({ status: "skipped", detail: "yarn is not installed" });
    expect(dependencyLines(setup)[1]).toBe("- Node.js: not installed beforehand (yarn is not installed)");
  });

  it("runs real commands without the harness's credentials", async () => {
    const root = await repo({ "go.mod": "module x\n" });
    process.env.AI_API_KEY = "sk-test-secret";
    try {
      // A stand-in "go" on PATH that records its environment.
      const bin = path.join(base, "fake-bin");
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, "go"), '#!/bin/sh\nenv > "$PWD/../go-env.txt"\n', { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${savedEnv.PATH}`;
      const setup = (await prepareEnvironment(root, info([{ name: "Go", dir: ".", manifest: "go.mod", tools: ["go"] }], { go: "1.22" }), { envsDir: path.join(base, "envs-e") }))!;
      expect(setup.results[0]?.status).toBe("installed");
      const env = await readFile(path.join(root, "../go-env.txt"), "utf8");
      expect(env).toContain("CI=1");
      expect(env).not.toContain("sk-test-secret");
    } finally {
      delete process.env.AI_API_KEY;
      process.env.PATH = savedEnv.PATH;
    }
  });
});

describe("environmentVars", () => {
  it("is empty when nothing is installed", () => {
    expect(environmentVars(base, path.join(base, "nothing"))).toEqual({});
    expect(existingEnvironment(path.join(base, "nowhere"), path.join(base, "envs-none"))).toBeUndefined();
  });
});
