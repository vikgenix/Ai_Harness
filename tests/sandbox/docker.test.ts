import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectInfo } from "../../src/repo/detect.js";
import { DEFAULT_IMAGE, dockerProblem, DockerSandbox, imageFor, sandboxEnvsDir, satisfies, SandboxError } from "../../src/sandbox/docker.js";
import { runCommand } from "../../src/tools/bash.js";
import { installFakeDocker } from "./fake-docker.js";

const savedEnv = { ...process.env };
let base: string;
let root: string;
let fake: Awaited<ReturnType<typeof installFakeDocker>>;

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "harness-docker-")));
  root = path.join(base, "repo");
  await mkdir(root);
  await mkdir(path.join(base, "bin"));
  fake = await installFakeDocker(path.join(base, "bin"));
});

beforeEach(() => {
  process.env.PATH = `${fake.bin}${path.delimiter}${savedEnv.PATH}`;
  process.env.FAKE_DOCKER_LOG = fake.log;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const project = (name: string, requires?: string): ProjectInfo => ({ ecosystems: [{ name, dir: ".", manifest: "x", requires, tools: [] }], hints: [], tools: {} });

describe("imageFor", () => {
  it("picks an image for the project's language and runtime version", () => {
    expect(imageFor(project("Python"))).toBe("python:3.12-slim-bookworm");
    expect(imageFor(project("Python", ">=3.13"))).toBe("python:3.13-slim-bookworm");
    expect(imageFor(project("Python", ">=3.8,<3.12"))).toBe("python:3.11-slim-bookworm");
    expect(imageFor(project("Go", "1.22.5"))).toBe("golang:1.22-bookworm");
    expect(imageFor(project("Node.js"))).toBe("node:22-bookworm-slim");
    expect(imageFor(undefined)).toBe(DEFAULT_IMAGE);
  });

  it("checks requires-python specifiers", () => {
    expect(satisfies("3.12", ">=3.9")).toBe(true);
    expect(satisfies("3.12", ">=3.9,<3.12")).toBe(false);
    expect(satisfies("3.12", "!=3.12.*")).toBe(false);
    expect(satisfies("3.12", "~=3.10")).toBe(true);
    expect(satisfies("3.12", "weird")).toBe(true);
  });

  it("keeps environments built in a container apart per image", () => {
    expect(sandboxEnvsDir("/h/envs", "python:3.12-slim-bookworm")).toBe("/h/envs/docker/python_3.12-slim-bookworm");
  });
});

describe("DockerSandbox", () => {
  const start = (extra: { network?: boolean; onProgress?(l: string): void } = {}) =>
    DockerSandbox.start({ root, image: "python:3.12-slim-bookworm", network: extra.network ?? true, envsDir: path.join(base, "envs"), onProgress: extra.onProgress });

  it("starts a locked-down container with the repository and environments mounted at their own paths", async () => {
    const sandbox = await start({ network: false });
    try {
      const run = (await fake.calls()).find((c) => c[0] === "run")!;
      const envs = path.join(base, "envs");
      expect(run).toEqual(expect.arrayContaining(["--detach", "--rm", "--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", "none"]));
      expect(run).toEqual(expect.arrayContaining(["--volume", `${root}:${root}`, "--volume", `${envs}:${envs}`, "--volume", `${envs}/home:/tmp/shrike-home`, "--workdir", root]));
      expect(run).toEqual(expect.arrayContaining(["--user", `${process.getuid!()}:${process.getgid!()}`, "--label", `shrike.pid=${process.pid}`]));
      expect(run.slice(-3)).toEqual(["sleep", "python:3.12-slim-bookworm", "31536000"]);
      expect(sandbox.describe()).toMatch(/^Sandbox: Docker container shrike-repo-[0-9a-f]{8} \(python:3\.12-slim-bookworm, network off\)\.$/);
      expect(sandbox.notes()).toEqual([
        "Commands run in a Docker container (image python:3.12-slim-bookworm, network off), with the repository mounted at the same path: the file tools and bash see the same files. Nothing can be downloaded.",
        "git is not installed in the container; the harness handles git (branch, diff, commit) outside it.",
      ]);
    } finally {
      await sandbox.close();
    }
    expect((await fake.calls()).at(-1)).toEqual(["rm", "-f", sandbox.name]);
  });

  it("runs commands in the container, with the dependencies' environment and the container's PATH", async () => {
    const sandbox = await start();
    try {
      const r = await runCommand('echo "$PWD|$VIRTUAL_ENV|$CI|${SHRIKE_COMMAND_ID:+id}"; echo "$PATH"', root, 10_000, { sandbox, env: { VIRTUAL_ENV: "/envs/v", PATH: `/envs/v/bin${path.delimiter}${process.env.PATH}` } });
      expect(r.code).toBe(0);
      const [first, pathLine] = r.output.split("\n");
      expect(first).toBe(`${root}|/envs/v|1|id`);
      expect(pathLine).toBe("/envs/v/bin:/usr/local/bin:/usr/bin:/bin"); // this machine's PATH stays outside
      const exec = (await fake.calls()).filter((c) => c[0] === "exec").at(-1)!;
      expect(exec.slice(-3)).toEqual(["bash", "-c", 'echo "$PWD|$VIRTUAL_ENV|$CI|${SHRIKE_COMMAND_ID:+id}"; echo "$PATH"']);
    } finally {
      await sandbox.close();
    }
  });

  it("stops the command's processes inside the container on timeout", async () => {
    const sandbox = await start();
    try {
      const r = await runCommand("sleep 30", root, 500, { sandbox });
      expect(r.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stops = (await fake.calls()).filter((c) => c[0] === "exec" && c.at(-1)!.includes("SHRIKE_COMMAND_ID="));
      expect(stops.length).toBeGreaterThan(0);
    } finally {
      await sandbox.close();
    }
  });

  it("looks tool versions up in the container", async () => {
    const sandbox = await start();
    try {
      expect(await sandbox.toolVersion("python3")).toBe("3.12.4");
      expect(await sandbox.toolVersion("uv")).toBeNull();
    } finally {
      await sandbox.close();
    }
  });

  it("pulls a missing image first", async () => {
    process.env.FAKE_DOCKER_NO_IMAGE = "1";
    const lines: string[] = [];
    const sandbox = await start({ onProgress: (l) => lines.push(l) });
    await sandbox.close();
    expect(lines).toEqual(["Pulling python:3.12-slim-bookworm (first use only)..."]);
    expect((await fake.calls()).some((c) => c[0] === "pull" && c.at(-1) === "python:3.12-slim-bookworm")).toBe(true);
  });

  it("says clearly when Docker is not running or not installed", async () => {
    process.env.FAKE_DOCKER_DOWN = "1";
    expect(await dockerProblem()).toMatch(/^Docker is not running \(Cannot connect to the Docker daemon/);
    await expect(start()).rejects.toThrow(SandboxError);
    await expect(start()).rejects.toThrow(/Start Docker, or set sandbox: none in config\/model\.yaml\.$/);
    process.env.PATH = "/nonexistent";
    expect(await dockerProblem()).toBe("Docker is not installed");
  });
});
