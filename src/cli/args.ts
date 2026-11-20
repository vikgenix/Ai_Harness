import { parseArgs } from "node:util";

export interface CliArgs {
  repo?: string;
  issue?: string;
  task?: string;
  /** After a committed fix, push it and open a pull request. */
  pr: boolean;
  config?: string;
  check: boolean;
  ping: boolean;
  help: boolean;
}

export const USAGE = `AI Harness: a coding agent that fixes GitHub issues.

Usage:
  make run                                  interactive session
  make run REPO=<url> ISSUE=<number|url>    fix one issue, no UI
  make run REPO=<url> TASK="<description>"  fix a described bug, no UI
  make run REPO=<url> ISSUE=<n> PR=1        ... then push and open a pull request

Options (when calling node dist/index.js directly):
  --repo <url>       GitHub repository to work on
  --issue <n|url>    issue number or URL to fix
  --task <text>      free-text description of what to fix
  --pr               after a committed fix, push it and open a pull request (needs GITHUB_TOKEN)
  --config <path>    model config file (default: config/model.yaml)
  --check            validate configuration and exit (no API call)
  --ping             send one tiny request to check the key and model (make ping)
  -h, --help         show this help

Without the UI, the exit code is 0 if a fix was committed, 1 if not (the agent
was blocked or stopped), 2 for setup problems, 3 if the fix was committed but
the pull request (--pr) could not be opened. Each run is saved in runs/.
`;

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      repo: { type: "string" },
      issue: { type: "string" },
      task: { type: "string" },
      pr: { type: "boolean", default: false },
      config: { type: "string" },
      check: { type: "boolean", default: false },
      ping: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    repo: values.repo || undefined,
    issue: values.issue || undefined,
    task: values.task || undefined,
    pr: values.pr ?? false,
    config: values.config || undefined,
    check: values.check ?? false,
    ping: values.ping ?? false,
    help: values.help ?? false,
  };
}
