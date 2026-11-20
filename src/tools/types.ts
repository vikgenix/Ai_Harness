import type { ToolSpec } from "../model/types.js";

/** What a tool can see of the environment it runs in. */
export interface ToolContext {
  /** Root of the repository being worked on; tools never touch files outside it. */
  root: string;
  signal?: AbortSignal;
  /** Extra environment for commands, e.g. the virtualenv the dependencies were installed in. */
  env?: Record<string, string>;
  /** Runs commands in a container instead of on this machine. */
  sandbox?: CommandSandbox;
}

/** Somewhere other than this machine that runs commands (the Docker sandbox). */
export interface CommandSandbox {
  /** The local process that runs `command` inside the sandbox, in `cwd`, with `env` added. `id` marks its processes. */
  command(command: string, cwd: string, env: Record<string, string>, id: string): { file: string; args: string[] };
  /** Kills every process inside the sandbox that the command with this id started. */
  stop(id: string): Promise<void>;
}

/**
 * A tool the agent can call. `input` has already been checked against
 * `spec.inputSchema` by the registry, so `run` can rely on its shape.
 */
export interface Tool<Input = Record<string, unknown>> {
  spec: ToolSpec;
  /** Returns the text shown to the model. Throw ToolError for problems the model should see and fix. */
  run(input: Input, ctx: ToolContext): Promise<string>;
}

/** An expected failure (missing file, bad range...): its message goes back to the model. */
export class ToolError extends Error {
  override name = "ToolError";
}
