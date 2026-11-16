import { createInterface } from "node:readline/promises";
import { describeConfig, type HarnessConfig } from "../config.js";

const HELP = `Commands:
  /repo <url>        set the GitHub repository to work on
  /fix <n|url|text>  fix an issue number, issue URL or described bug
  /config            show the active model configuration
  /help              show this help
  /exit              quit`;

/**
 * Placeholder interactive session. It is replaced by the full TUI in Phase 6;
 * the agent behind /fix arrives in Phases 2-3.
 */
export async function startRepl(config: HarnessConfig, initialRepo?: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let repo = initialRepo;

  console.log(HELP);
  if (repo) console.log(`\nRepository: ${repo}`);

  // Async iteration (not rl.question) so lines piped in before the prompt
  // appears are queued instead of dropped. The loop ends on EOF / Ctrl-D.
  rl.setPrompt("\nharness › ");
  rl.prompt();
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        continue;
      }

      const [cmd = "", ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");

      switch (cmd) {
        case "/exit":
        case "/quit":
          return;
        case "/help":
          console.log(HELP);
          break;
        case "/config":
          console.log(describeConfig(config));
          break;
        case "/repo":
          if (!arg) {
            console.log(repo ? `Repository: ${repo}` : "Usage: /repo <github url>");
          } else {
            repo = arg;
            console.log(`Repository set: ${repo}`);
          }
          break;
        case "/fix":
          if (!repo) console.log("Set a repository first: /repo <github url>");
          else if (!arg) console.log("Usage: /fix <issue number | issue url | description>");
          else console.log(`Not implemented yet: the agent that fixes "${arg}" arrives in Phases 2-3.`);
          break;
        default:
          console.log(`Unknown command '${cmd}'. Type /help.`);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}
