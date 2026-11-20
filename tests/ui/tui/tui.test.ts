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

/** The last `n` rows with anything on them: the bottom of the live area. */
function lastRows(term: ReturnType<typeof fakeTerminal>, n: number): string {
  const rows = term.screen();
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
  return rows.slice(-n).join("\n");
}

describe("startTui", () => {
  it("prints a fix into the terminal: the reply, tool calls with the edit, stages, then gives the terminal back", async () => {
    const dir = await repo();
    const term = fakeTerminal(100, 30);
    const model = scripted([
      { text: "Looking at the **greeting**.\n", calls: [{ id: "v", name: "view_file", input: { path: "src/app.py" } }] },
      { calls: [{ id: "e", name: "edit_file", input: { path: "src/app.py", old_string: "'hi '", new_string: "'HI '" } }] },
      { calls: [finish] },
      { calls: [{ ...finish, id: "f2" }] }, // after the self-review
    ]);
    const done = startTui({ config, model, tracker: new UsageTracker(config.pricing), initialRepo: dir, terminal: term.terminal });

    await eventually(() => expect(term.text()).toContain("Working directory:"));
    expect(term.text()).toMatch(/▲ shrike {2}claude-opus-5-5/);
    term.type("/fi");
    await eventually(() => expect(lastRows(term, 2)).toMatch(/› \/fix +fix an issue or a described bug/)); // the command menu
    term.type("\t");
    await eventually(() => expect(term.text()).toMatch(/│ › \/fix <issue number \| issue URL \| description> +│/)); // what it expects
    term.type("make the greeting loud\r");

    await eventually(() => expect(term.text()).toMatch(/✓ Commit {2}[0-9a-f]{7}/));
    const text = term.text();
    expect(text).toMatch(/^› \/fix make the greeting loud *$/m);
    expect(text).toMatch(/^ {2}✓ Branch {2}shrike\/make-the-greeting-loud \(from \w+\) *$/m);
    expect(text).toMatch(/^ {2}– Skipped: Project \(none detected\), Dependencies, Baseline *$/m); // on one line
    expect(text).toMatch(/^ {2}✓ Commit {2}[0-9a-f]{7} · src\/app\.py *$/m);
    expect(text).not.toMatch(/Working on branch|Committed [0-9a-f]/); // said once, by the stage lines
    expect(text).toMatch(/^● Looking at the greeting\. *$/m); // markdown bold, without the stars
    expect(text).toMatch(/^ {2}✓ Read src\/app\.py {2}\d+\.\ds *$/m);
    expect(text).toMatch(/^ {2}✓ Edit src\/app\.py {2}\+1 -1 {2}\d+\.\ds *$/m);
    expect(text).toMatch(/^ {6}- 'hi ' *\n {6}\+ 'HI ' *$/m);
    expect(text).toMatch(/^ {2}✓ Agent {2}4 steps *$/m);
    expect(text).not.toContain("finish"); // not worth a line

    term.type("/diff\r");
    await eventually(() => expect(term.text()).toContain("+    return 'HI ' + name"));
    expect(term.text()).toMatch(/1 file changed {2}\+1 -1/);

    term.type("\x03");
    await eventually(() => expect(lastRows(term, 1)).toContain("Press Ctrl-C again to quit."));
    term.type("\x03");
    await done;
    expect(term.raw).toEqual([true, false]);
    expect(term.written()).not.toContain("\x1b[?1049h"); // no alternate screen: the conversation stays in the scrollback
    expect(term.text()).toMatch(/✓ Commit[^]*\nShrike: 4 requests · /);
    expect(term.text()).not.toContain("╭"); // the input box is gone
  });

  it("keeps the whole conversation in the terminal's scrollback, and redraws only the bottom", async () => {
    const reply = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const term = fakeTerminal(80, 20);
    const done = startTui({ config, model: scripted([{ text: reply }]), tracker: new UsageTracker(config.pricing), workdir: await repo(), terminal: term.terminal });
    await eventually(() => expect(term.text()).toContain("Working directory:"));
    term.type("count\r");
    await eventually(() => expect(term.text()).toContain("line 99"));
    await eventually(() => expect(lastRows(term, 1)).toContain("/ commands"));
    const text = term.text();
    for (const n of [1, 50, 98, 99]) expect(text).toMatch(new RegExp(`^ {2}line ${n} *$`, "m"));
    expect(text).toMatch(/^● line 0 *$/m);

    const before = term.written().length;
    term.type("a");
    await eventually(() => expect(lastRows(term, 3)).toContain("│ › a "));
    expect(term.written().length - before).toBeLessThan(800); // a keypress redraws a few lines, not the screen
    term.type("\x04".repeat(1));
    term.type("\x03\x04"); // clear the line, then quit
    await done;
  });

  it("cancels with Esc, and quits with Ctrl-D", async () => {
    const term = fakeTerminal(100, 24);
    const done = startTui({ config, model: scripted([{ wait: true }]), tracker: new UsageTracker(config.pricing), workdir: await repo(), terminal: term.terminal });
    await eventually(() => expect(term.text()).toContain("Working directory:"));
    term.type("what does greet do?\r");
    await eventually(() => expect(term.text()).toMatch(/^› what does greet do\? *$/m));
    await eventually(() => expect(lastRows(term, 6)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working \d+\.\ds/));
    expect(lastRows(term, 1)).toContain("Esc to cancel");
    term.type("\x1b");
    await eventually(() => expect(term.text()).toContain("(cancelled)"));
    await eventually(() => expect(lastRows(term, 1)).toContain("/ commands"));
    term.type("\x04");
    await done;
  });

  it("picks commands from the menu, and shows /help", async () => {
    const term = fakeTerminal(100, 30);
    const done = startTui({ config, model: scripted([]), tracker: new UsageTracker(config.pricing), workdir: await repo(), terminal: term.terminal });
    await eventually(() => expect(term.text()).toContain("Working directory:"));
    term.type("/c");
    await eventually(() => expect(lastRows(term, 3)).toMatch(/› \/cost .*\n +\/clear .*\n +\/config /));
    term.type("\x1b[B"); // ↓
    await eventually(() => expect(lastRows(term, 3)).toMatch(/ +\/cost .*\n › \/clear /));
    term.type("\r");
    await eventually(() => expect(term.text()).toContain("Started a new conversation."));
    term.type("/help\r");
    await eventually(() => expect(term.text()).toMatch(/^ {4}\/fix <issue number \| issue URL \| description> +fix an issue/m));
    term.type("\x04");
    await done;
  });

  it("asks questions in the input box: /pr waits for an answer", async () => {
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
    await eventually(() => expect(term.text()).toMatch(/╭─ Push shrike\/fix-7 and open this pull request\? \[y\/N\] ─+╮/));
    term.type("n\r");
    await eventually(() => expect(term.text()).toContain("Not pushed."));
    expect(term.text()).toMatch(/^ {2}\? Push shrike\/fix-7 and open this pull request\? \[y\/N\] n *$/m);
    expect(gh.calls).toEqual([]);
    term.type("\x04");
    await done;
  });
});
