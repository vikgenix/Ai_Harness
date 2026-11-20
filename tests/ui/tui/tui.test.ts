import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { UsageTracker } from "../../../src/model/cost.js";
import { ModelError, type ChatRequest, type ChatResponse, type ModelClient, type ToolCall } from "../../../src/model/index.js";
import { startTui } from "../../../src/ui/tui/tui.js";
import { fakeGitHub } from "../../github/fake-github.js";
import { eventually, fakeTerminal } from "./fake-terminal.js";

const config = { ...loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } }), installDeps: false, baselineTests: false };
const savedEnv = { ...process.env };
let base: string;
let n = 0;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await realpath(await mkdtemp(path.join(tmpdir(), "shrike-tui-")));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = path.join(base, `r${n++}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/app.py"), "def greet(name):\n    return 'hi ' + name\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: root });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");
  return root;
}

/** A model that replies with these turns in order (text, then tool calls). */
function scripted(turns: { text?: string; calls?: ToolCall[]; wait?: boolean }[]): ModelClient {
  let i = 0;
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const turn = turns[i++] ?? { text: "Nothing more." };
      if (turn.wait) {
        // Until the run is cancelled.
        await new Promise((_resolve, reject) => req.signal?.addEventListener("abort", () => reject(new ModelError("aborted", "cancelled"))));
      }
      if (turn.text) req.onText?.(turn.text);
      return {
        message: { role: "assistant", content: turn.text ?? "", ...(turn.calls ? { toolCalls: turn.calls } : {}) },
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: turn.calls ? "tool_use" : "end",
        model: "claude-opus-5-5",
        durationMs: 1,
      };
    },
  };
}

const finish: ToolCall = { id: "f", name: "finish", input: { outcome: "completed", summary: "Made the greeting loud." } };

describe("startTui", () => {
  it("runs a fix in panels: progress, tool log, diff and status, then gives the terminal back", async () => {
    const dir = await repo();
    const term = fakeTerminal(120, 32);
    const tracker = new UsageTracker(config.pricing);
    const model = scripted([
      { text: "Looking at the greeting.\n", calls: [{ id: "v", name: "view_file", input: { path: "src/app.py" } }] },
      { calls: [{ id: "e", name: "edit_file", input: { path: "src/app.py", old_string: "'hi '", new_string: "'HI '" } }] },
      { calls: [finish] },
      { calls: [{ ...finish, id: "f2" }] }, // after the self-review
    ]);
    const done = startTui({ config, model, tracker, initialRepo: dir, terminal: term.terminal });

    await eventually(() => expect(term.text()).toContain("Working directory:"));
    term.type("/fi\t"); // Tab completes the command
    await eventually(() => expect(term.screen()[30]).toMatch(/^shrike › \/fix +$/));
    term.type("make the greeting loud\r");

    await eventually(() => expect(term.text()).toMatch(/✓ Commit +[0-9a-f]{7}/));
    const screen = term.text();
    expect(screen).toContain("FIX make the greeting loud");
    expect(screen).toMatch(/✓ Branch +shrike\/make-the-gree…/); // cut to the panel
    expect(screen).toMatch(/✓ Repo map +1 file, 1 symbol /);
    expect(screen).toMatch(/✓ Agent +4 steps/);
    expect(screen).toMatch(/✓ Self-review +1 round/);
    expect(screen).toMatch(/✓ edit_file\(path=src\/app\.py, old_string='hi ', new_string='HI '\) +\d+\.\ds/);
    await eventually(() => expect(term.text()).toContain("─ Diff · 1 file +1 -1 "));
    expect(term.text()).toContain("+    return 'HI ' + name");
    expect(term.text()).toMatch(/M src\/app\.py +\+1 -1/);
    expect(term.text()).toMatch(/● ready {2}│ {2}step 4\/60/);

    term.type("\x03");
    await eventually(() => expect(term.text()).toContain("Press Ctrl-C again to quit."));
    term.type("\x03");
    await done;
    expect(term.raw).toEqual([true, false]);
    expect(term.written()).toMatch(/\x1b\[\?1049h[^]*\x1b\[\?1049l[^]*Shrike: 4 requests · /); // alternate screen in, out, then the session total
  });

  it("cancels the reply in progress with Ctrl-C, and quits with Ctrl-D", async () => {
    const term = fakeTerminal(100, 24);
    const done = startTui({ config, model: scripted([{ wait: true }]), tracker: new UsageTracker(config.pricing), workdir: await repo(), terminal: term.terminal });
    await eventually(() => expect(term.text()).toContain("Working directory:"));
    term.type("what does greet do?\r");
    await eventually(() => expect(term.text()).toContain("› what does greet do?"));
    await eventually(() => expect(term.screen()[23]).toMatch(/^ Ctrl-C cancel/)); // the hint line while busy
    term.type("\x03");
    await eventually(() => expect(term.text()).toContain("(cancelled)"));
    await eventually(() => expect(term.text()).toContain("● ready"));
    term.type("\x04");
    await done;
  });

  it("asks questions on the input line: /pr waits for an answer", async () => {
    const gh = await fakeGitHub(path.join(base, "gh"));
    const term = fakeTerminal(120, 32);
    const done = startTui({
      config,
      model: scripted([]),
      tracker: new UsageTracker(config.pricing),
      initialRepo: gh.clone,
      githubToken: "ghp_x",
      fetchImpl: gh.fetchImpl,
      githubHosts: gh.hosts,
      terminal: term.terminal,
    });
    await eventually(() => expect(term.text()).toContain("Working directory:"));
    term.type("/pr\r");
    await eventually(() => expect(term.screen()[30]).toMatch(/^Push shrike\/fix-7 and open this pull request\? \[y\/N\] › +$/));
    term.type("n\r");
    await eventually(() => expect(term.text()).toContain("Not pushed."));
    expect(term.screen()[30]).toMatch(/^shrike › +$/);
    expect(gh.calls).toEqual([]);
    term.type("\x04");
    await done;
  });

  it("redraws at the new size when the terminal is resized", async () => {
    const term = fakeTerminal(120, 32);
    const done = startTui({ config, model: scripted([]), tracker: new UsageTracker(config.pricing), workdir: await repo(), terminal: term.terminal });
    await eventually(() => expect(term.text()).toContain("─ Task ─"));
    term.resize(70, 20);
    await eventually(() => expect(term.screen()).toHaveLength(20));
    await eventually(() => expect(term.screen()[0]).toMatch(/^ ▲ shrike .*claude-opus-5-5 $/));
    expect(term.text()).not.toContain("─ Task ─"); // narrow: no left column
    term.type("\x04");
    await done;
  });
});
