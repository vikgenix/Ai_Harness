import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { EXIT, runHeadless, type HeadlessOptions } from "../src/headless.js";
import { UsageTracker } from "../src/model/cost.js";
import type { ChatResponse, ModelClient, ToolCall } from "../src/model/index.js";
import { makeSourceRepo } from "./helpers.js";

const config = loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } });
const savedEnv = { ...process.env };
let base: string;
let sourceUrl: string;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; // independent of this machine's git identity
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await mkdtemp(path.join(tmpdir(), "harness-headless-"));
  sourceUrl = await makeSourceRepo(path.join(base, "demo"));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

/** Scripted model: each entry is one reply (tool calls, or text). */
function scripted(replies: (ToolCall[] | string)[]): ModelClient {
  let i = 0;
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    async chat(req): Promise<ChatResponse> {
      const r = replies[i++] ?? "out of script";
      const text = typeof r === "string" ? r : "";
      req.onText?.(text);
      return {
        message: { role: "assistant", content: text, ...(typeof r === "string" ? {} : { toolCalls: r }) },
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: typeof r === "string" ? "end" : "tool_use",
        model: "claude-opus-5-5",
        durationMs: 1,
      };
    },
  };
}

let n = 0;
async function headless(model: ModelClient, extra: Partial<HeadlessOptions> = {}) {
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));
  const ws = path.join(base, `ws${n}`);
  const runsDir = path.join(base, `runs${n++}`);
  const code = await runHeadless({
    config,
    model,
    tracker: new UsageTracker(config.pricing),
    repo: sourceUrl,
    workspacesDir: ws,
    runsDir,
    output,
    ...extra,
  });
  const runs = await readdir(runsDir).catch(() => [] as string[]);
  const runDir = runs[0] ? path.join(runsDir, runs[0]) : undefined;
  return { code, out, runDir, clone: path.join(ws, "local__demo") };
}

const create = (p: string, content: string): ToolCall => ({ id: `c-${p}`, name: "create_file", input: { path: p, content } });
const finish = (outcome: string, summary: string): ToolCall => ({ id: `f-${outcome}`, name: "finish", input: { outcome, summary } });

describe("runHeadless", () => {
  it("clones, fixes on a branch, commits, saves the run and exits 0", async () => {
    const model = scripted([
      [create("src/greet.py", "print('HELLO')\n")],
      [finish("completed", "Added src/greet.py. Tests: none.")], // held back for the self-review
      [finish("completed", "Added src/greet.py. Tests: none.")],
    ]);
    const { code, out, runDir, clone } = await headless(model, { task: "make the greeting louder" });

    expect(code).toBe(EXIT.committed);
    expect(out).toContain("Cloning local/demo...");
    expect(out).toContain("Task: make the greeting louder\nWorking on branch harness/make-the-greeting-louder (from ");
    expect(out).toMatch(/\)\.\nRepo map: 2 files, 0 with symbols \(0 symbols\), ~\d+ tokens, [\d.]+s\.\n/);
    expect(out).toContain("  → create_file(path=src/greet.py, content=print('HELLO') )");
    expect(out).toContain("  ↻ Self-review: 1 file changed, 2 to check (Added print/log statement; No test file was added or changed).");
    expect(out).toContain("✓ Done: Added src/greet.py. Tests: none.");
    expect(out).toMatch(/\[claude-opus-5-5 · 3 steps · [\d.]+s · /);
    expect(out).toMatch(/Committed [0-9a-f]+ on branch harness\/make-the-greeting-louder \(1 file: src\/greet\.py\)/);
    expect(out).toContain("(result.json, transcript.json, fix.patch)");

    expect(path.basename(runDir!)).toMatch(/^\d{8}-\d{6}-make-the-greeting-louder$/);
    const record = JSON.parse(await readFile(path.join(runDir!, "result.json"), "utf8"));
    expect(record).toMatchObject({
      task: { kind: "text", text: "make the greeting louder" },
      branch: "harness/make-the-greeting-louder",
      status: "finished",
      outcome: "completed",
      committed: true,
      files: ["src/greet.py"],
      steps: 3,
      model: "claude-opus-5-5",
      error: null,
    });
    expect(record.selfReview.rounds).toBe(1);
    expect(record.selfReview.findings).toHaveLength(2);
    expect(record.dependencies).toBeNull(); // no project files, nothing to install
    expect(record.baseline).toBeNull(); // and no test command
    expect(record.commit).toBe(execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: clone }).toString().trim());
    const patch = await readFile(path.join(runDir!, "fix.patch"), "utf8");
    expect(patch).toContain("Subject: [PATCH] Fix: make the greeting louder");
    expect(patch).toContain("+print('HELLO')");
    const transcript = JSON.parse(await readFile(path.join(runDir!, "transcript.json"), "utf8"));
    expect(transcript.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"]);
    expect(transcript[4].results[0].content).toContain("Self-review: your finish call was held back");
    expect(transcript[4].results[0].content).toContain("+print('HELLO')");
    expect(transcript[0].content).toMatch(/^<repo_map>\n[^]*<\/repo_map>\n[^]*Fix this in the repository:\n\nmake the greeting louder$/);
    expect(record.repoMap).toMatchObject({ files: 2, detailedFiles: 0 });
    expect(record.project).toEqual({ ecosystems: [], tools: {} });
    expect(out).toContain("Project: no known project files found.");
  });

  it("exits 1 and commits nothing when the agent is blocked", async () => {
    const model = scripted([[create("half.py", "x\n")], [finish("blocked", "Could not run the tests.")]]);
    const { code, out, runDir, clone } = await headless(model, { task: "something hard" });
    expect(code).toBe(EXIT.noFix);
    expect(out).toContain("✗ Blocked: Could not run the tests.");
    expect(out).toContain("Not committed: the agent reported it was blocked. 1 file changed");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: clone }).toString()).toContain("?? half.py");
    const record = JSON.parse(await readFile(path.join(runDir!, "result.json"), "utf8"));
    expect(record).toMatchObject({ outcome: "blocked", committed: false, commit: null });
    expect(await readdir(runDir!)).toEqual(["result.json", "transcript.json"]);
  });

  it("leaves the repository map out when repo_map_tokens is 0", async () => {
    const model = scripted([[finish("blocked", "Nothing to do.")]]);
    const { out, runDir } = await headless(model, { task: "no map please", config: { ...config, repoMapTokens: 0 } });
    expect(out).not.toContain("Repo map:");
    const transcript = JSON.parse(await readFile(path.join(runDir!, "transcript.json"), "utf8"));
    expect(transcript[0].content).toMatch(/^<project>\n[^]*\n<\/project>\n\nFix this in the repository:\n\nno map please$/);
  });

  it("works on a local directory as-is", async () => {
    const local = path.join(base, "local-repo");
    await makeSourceRepo(local);
    const model = scripted([[create("new.txt", "hi\n")], [finish("completed", "Added new.txt.")], [finish("completed", "Added new.txt.")]]);
    const { code } = await headless(model, { repo: local, task: "add a file" });
    expect(code).toBe(EXIT.committed);
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: local }).toString().trim()).toBe("Fix: add a file");
  });

  it.each([
    [{ task: undefined, issue: undefined }, "Give exactly one of ISSUE"],
    [{ task: "x", issue: "1" }, "Give exactly one of ISSUE"],
    [{ repo: "not a repo", task: "x" }, "'not a repo' is not a directory or a repository URL"],
    [{ issue: "12" }, "'12' is an issue number, but the working directory is not a GitHub clone"],
  ])("exits 2 on setup problems (%#)", async (extra, message) => {
    let asked = false;
    const model = { ...scripted([]), chat: async () => ((asked = true), Promise.reject(new Error("not expected"))) } as ModelClient;
    const { code, out, runDir } = await headless(model, extra as Partial<HeadlessOptions>);
    expect(code).toBe(EXIT.setup);
    expect(out).toContain(message);
    expect(asked).toBe(false);
    expect(runDir).toBeUndefined();
  });

  it("exits 2 when the working tree has uncommitted changes", async () => {
    const local = path.join(base, "dirty-repo");
    await makeSourceRepo(local);
    await writeFile(path.join(local, "README.md"), "changed\n");
    const { code, out } = await headless(scripted([]), { repo: local, task: "x" });
    expect(code).toBe(EXIT.setup);
    expect(out).toContain("uncommitted changes");
  });
});
