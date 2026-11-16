#!/usr/bin/env node
import { USAGE, parseCliArgs } from "./cli/args.js";
import { ConfigError, describeConfig, loadConfig } from "./config.js";
import { startRepl } from "./ui/repl.js";

async function main(): Promise<number> {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const config = loadConfig({ configPath: args.config });

  console.log("AI Harness");
  console.log(describeConfig(config));

  if (args.check) {
    console.log("\nConfiguration OK.");
    return 0;
  }

  if (args.issue || args.task) {
    if (!args.repo) {
      console.error("--issue/--task needs --repo (or REPO=<url> with make run).");
      return 2;
    }
    console.error("\nRunning without the UI is not implemented yet (arrives in Phase 3).");
    return 3;
  }

  console.log();
  await startRepl(config, args.repo);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  },
);
