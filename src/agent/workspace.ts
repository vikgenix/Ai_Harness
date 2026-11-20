import type { HarnessConfig } from "../config.js";
import { describeBaseline, runBaseline, withBaseline, type Baseline } from "../repo/baseline.js";
import { describeProject, projectFor, withProject, type ProjectInfo } from "../repo/detect.js";
import { DEFAULT_ENVS_DIR, dependencyLines, describeSetup, existingEnvironment, prepareEnvironment, type EnvSetup } from "../repo/env.js";
import { describeRepoMap, repoMapFor, withRepoMap, type RepoMap } from "../repo/map.js";
import { DockerSandbox, imageFor, sandboxEnvsDir } from "../sandbox/docker.js";

/**
 * Everything /fix prepares before the agent starts: the repository map, the
 * project detection, the sandbox, the installed dependencies and the baseline
 * tests. Shared by the interactive /fix and headless runs.
 */
export interface Workspace {
  map?: RepoMap;
  project?: ProjectInfo;
  sandbox?: DockerSandbox;
  setup?: EnvSetup;
  baseline?: Baseline;
  /** Environment for the agent's commands (the installed dependencies). */
  env?: Record<string, string>;
}

export interface PrepareOptions {
  config: HarnessConfig;
  /** The task's words, to rank the repository map. */
  query: string;
  envsDir?: string;
  /** Cancels the repository map. */
  signal?: AbortSignal;
  print(line: string): void;
  /** Runs one slow step with the signal that cancels it (Ctrl-C in the REPL skips the step). */
  step<T>(fn: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  /** A sandbox already running for this directory, to use again. */
  sandbox?: DockerSandbox;
}

/** Starts the sandbox for a directory (config.sandbox is "docker"). Throws SandboxError if Docker cannot run it. */
export async function openSandbox(dir: string, config: HarnessConfig, opts: { envsDir?: string; project?: ProjectInfo; signal?: AbortSignal; print(line: string): void }): Promise<DockerSandbox> {
  // Only the files decide the image; tool versions are looked up in the container afterwards.
  const project = opts.project ?? (await projectFor(dir, async () => "unknown"));
  const image = config.sandboxImage ?? imageFor(project);
  const sandbox = await DockerSandbox.start({
    root: dir,
    image,
    network: config.sandboxNetwork,
    envsDir: sandboxEnvsDir(opts.envsDir ?? DEFAULT_ENVS_DIR, image),
    signal: opts.signal,
    onProgress: opts.print,
  });
  opts.print(sandbox.describe());
  return sandbox;
}

/** Where this workspace's dependency environments are kept. */
export function envsDirOf(sandbox: DockerSandbox | undefined, envsDir?: string): string {
  return sandbox ? sandboxEnvsDir(envsDir ?? DEFAULT_ENVS_DIR, sandbox.image) : (envsDir ?? DEFAULT_ENVS_DIR);
}

/** Prepares the workspace, printing one line per step. Throws SandboxError if the sandbox is wanted but cannot start. */
export async function prepareWorkspace(dir: string, opts: PrepareOptions): Promise<Workspace> {
  const { config, print } = opts;
  const map = await repoMapFor(dir, opts.query, config.repoMapTokens, opts.signal);
  if (map) print(describeRepoMap(map));

  let sandbox = opts.sandbox;
  let project: ProjectInfo | undefined;
  if (config.sandbox === "docker") {
    sandbox ??= await opts.step((signal) => openSandbox(dir, config, { envsDir: opts.envsDir, signal, print }));
    project = await projectFor(dir, (tool) => sandbox!.toolVersion(tool));
  } else {
    project = await projectFor(dir);
  }
  if (project) print(describeProject(project));

  const envsDir = envsDirOf(sandbox, opts.envsDir);
  const setup =
    project && config.installDeps
      ? await opts.step((signal) =>
          prepareEnvironment(dir, project, {
            envsDir,
            timeoutS: config.installTimeoutS,
            signal,
            onProgress: print,
            sandbox,
            versionOf: sandbox && ((tool) => sandbox!.toolVersion(tool)),
          }),
        )
      : undefined;
  if (setup) print(describeSetup(setup));
  const env = setup?.env ?? existingEnvironment(dir, envsDir);

  const baseline =
    project && config.baselineTests
      ? await opts.step((signal) => runBaseline(dir, project, { env, envsDir, timeoutS: config.baselineTimeoutS, signal, onProgress: print, sandbox }))
      : undefined;
  if (baseline) print(describeBaseline(baseline));

  return { map, project, sandbox, setup, baseline, env };
}

/** The first message of a fix: repository map, project, baseline, then the task. */
export function fixMessage(taskText: string, ws: Workspace): string {
  const withTests = withBaseline(taskText, ws.baseline, ws.project);
  return withRepoMap(withProject(withTests, ws.project, ws.setup && dependencyLines(ws.setup), ws.sandbox?.notes()), ws.map);
}
