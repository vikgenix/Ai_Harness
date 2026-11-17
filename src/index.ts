#!/usr/bin/env node
import { USAGE, parseCliArgs } from "./cli/args.js";
import { ConfigError, describeConfig, loadConfig, type HarnessConfig } from "./config.js";
import { UsageTracker, formatUsage } from "./model/cost.js";
import { ModelError, createModelClient } from "./model/index.js";
import { startRepl } from "./ui/repl.js";

/** Sends one tiny request to prove the key, model and endpoint work. */
async function ping(config: HarnessConfig): Promise<number> {
  // Low effort: this only checks connectivity, so don't pay for reasoning.
  const model = createModelClient({ ...config, effort: config.effort ? "low" : undefined });
  const tracker = new UsageTracker(config.pricing);
  console.log("\nSending a test request...");
  const res = await model.chat({
    system: "You are a connectivity check.",
    messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
  });
  const cost = tracker.add(res.usage, res.model);
  console.log(`Reply   : ${res.message.content.trim() || "(empty)"}`);
  console.log(`Model   : ${res.model} (${(res.durationMs / 1000).toFixed(1)}s, stop: ${res.stopReason})`);
  console.log(`Usage   : ${formatUsage(res.usage, cost)}`);
  console.log("\nModel connection OK.");
  return 0;
}

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

  if (args.ping) return ping(config);

  if (args.issue || args.task) {
    if (!args.repo) {
      console.error("--issue/--task needs --repo (or REPO=<url> with make run).");
      return 2;
    }
    console.error("\nRunning without the UI is not implemented yet (arrives in Phase 3).");
    return 3;
  }

  console.log();
  await startRepl({
    config,
    model: createModelClient(config),
    tracker: new UsageTracker(config.pricing),
    initialRepo: args.repo,
    githubToken: process.env.GITHUB_TOKEN || undefined,
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof ModelError) {
      console.error(`Model call failed: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  },
);
