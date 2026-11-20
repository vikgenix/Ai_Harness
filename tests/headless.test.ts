import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { EXIT, runHeadless, type HeadlessOptions } from "../src/headless.js";
import { UsageTracker } from "../src/model/cost.js";
import type { ChatResponse, ModelClient, ToolCall } from "../src/model/index.js";
import { makeSourceRepo } from "./helpers.js";
import { installFakeDocker } from "./sandbox/fake-docker.js";
import { fakeGitHub } from "./github/fake-github.js";

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
    envsDir: path.join(base, "envs"), // never the harness's own envs/
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

  describe("with the Docker sandbox", () => {
    const sandboxed = { ...config, sandbox: "docker" as const };
    let fake: Awaited<ReturnType<typeof installFakeDocker>>;
    beforeAll(async () => {
      const bin = path.join(base, "fake-docker");
      await mkdir(bin);
      fake = await installFakeDocker(bin);
    });
    afterEach(() => {
      process.env.PATH = savedEnv.PATH;
      delete process.env.FAKE_DOCKER_DOWN;
    });
    const useFake = () => {
      process.env.PATH = `${fake.bin}${path.delimiter}${savedEnv.PATH}`;
      process.env.FAKE_DOCKER_LOG = fake.log;
    };

    it("runs the agent's commands in the container and removes it afterwards", async () => {
      useFake();
      const bash: ToolCall = { id: "b1", name: "bash", input: { command: "echo in-container:$HARNESS_COMMAND_ID" } };
      const model = scripted([[bash], [finish("blocked", "Only looked.")]]);
      const { code, out, runDir } = await headless(model, { task: "look around", config: sandboxed });
      expect(code).toBe(EXIT.noFix);
      expect(out).toMatch(/Sandbox: Docker container ai-harness-local__demo-[0-9a-f]{8} \(debian:bookworm-slim, network on\)\./);
      const calls = await fake.calls();
      const name = calls.find((c) => c[0] === "run")![calls.find((c) => c[0] === "run")!.indexOf("--name") + 1]!;
      expect(calls.some((c) => c[0] === "exec" && c.at(-1) === "echo in-container:$HARNESS_COMMAND_ID")).toBe(true);
      expect(calls.at(-1)).toEqual(["rm", "-f", name]);
      const record = JSON.parse(await readFile(path.join(runDir!, "result.json"), "utf8"));
      expect(record.sandbox).toEqual({ image: "debian:bookworm-slim", network: true });
      const transcript = JSON.parse(await readFile(path.join(runDir!, "transcript.json"), "utf8"));
      expect(transcript[0].content).toContain("Commands run in a Docker container (image debian:bookworm-slim, network on)");
      expect(transcript[2].results[0].content).toMatch(/^in-container:[0-9a-f-]{36}\n/);
    });

    it("exits 2 before making a branch when Docker is not running", async () => {
      useFake();
      process.env.FAKE_DOCKER_DOWN = "1";
      const { code, out, clone } = await headless(scripted([]), { task: "x", config: sandboxed });
      expect(code).toBe(EXIT.setup);
      expect(out).toContain("Docker is not running (Cannot connect to the Docker daemon");
      expect(out).toContain("Start Docker, or run without the sandbox (sandbox: none in config/model.yaml).");
      expect(execFileSync("git", ["branch", "--list", "harness/*"], { cwd: clone }).toString()).toBe("");
    });
  });

  describe("with --audit", () => {
    it("drafts issues and saves them, but posts nothing", async () => {
      const gh = await fakeGitHub(path.join(base, "gh-audit"));
      const model = scripted([[{
  id: "a1",
  name: "finish",
  input: {
    summary: "Looked at the greeting code.",
    issues: [
      { title: "parse_date() returns None for ISO dates ending in Z", body: "parse_date('2024-01-01T00:00:00Z') returns None.\n\n**Where**: loud.py:1\n\n**Expected**: a date. **Actual**: None.", severity: "medium", confidence: "confirmed", files: ["loud.py"] },
      { title: "The greeting ignores the NAME environment variable", body: "Setting NAME has no effect on the greeting.\n\n**Where**: loud.py:1\n\n**Expected**: Hi NAME. **Actual**: HI.", severity: "low", confidence: "likely", files: ["loud.py"] },
    ],
  },
} as ToolCall]]);
      const { code, out, runDir } = await headless(model, { repo: gh.clone, audit: "1", githubToken: "ghp_x", fetchImpl: gh.fetchImpl, githubHosts: gh.hosts });
      expect(code).toBe(EXIT.committed);
      expect(out).toContain("Auditing ");
      expect(out).toContain("[1/2] medium · confirmed · loud.py");
      expect(out).toMatch(/Saved to .*-audit \(result\.json, issues\.md, transcript\.json\)\. Nothing was posted: review issues\.md/);
      expect(gh.calls.filter((c) => c.method === "POST")).toEqual([]);
      expect(path.basename(runDir!)).toMatch(/^\d{8}-\d{6}-audit$/);
      expect(await readFile(path.join(runDir!, "issues.md"), "utf8")).toContain("## 2. The greeting ignores the NAME environment variable");
    });

    it("takes exactly one of an issue, a task or an audit", async () => {
      const { code, out } = await headless(scripted([]), { task: "x", audit: "1" });
      expect(code).toBe(EXIT.setup);
      expect(out).toContain('Give exactly one of ISSUE=<number|url>, TASK="<description>" or AUDIT=1');
    });
  });

  describe("with --pr", () => {
    const fixing = () => scripted([[create("x.py", "x = 1\n")], [finish("completed", "Added x.py.")], [finish("completed", "Added x.py.")]]);

    it("pushes the committed fix and opens a pull request", async () => {
      const gh = await fakeGitHub(path.join(base, "gh-ok"));
      const { code, out, runDir } = await headless(fixing(), { repo: gh.clone, task: "add x", pr: true, githubToken: "ghp_x", fetchImpl: gh.fetchImpl, githubHosts: gh.hosts });
      expect(code).toBe(EXIT.committed);
      expect(out).toContain("Pushing harness/add-x and opening a pull request to acme/demo...\nPushed to acme/demo:harness/add-x. Opened draft pull request #42");
      expect(gh.branches("acme")).toContain("harness/add-x");
      const record = JSON.parse(await readFile(path.join(runDir!, "result.json"), "utf8"));
      expect(record.pullRequest).toEqual({ url: "https://github.com/acme/demo/pull/42", number: 42, pushedTo: "acme/demo:harness/add-x", created: true, draft: true });
    });

    it("exits 3 when the fix is committed but the pull request cannot be opened", async () => {
      const gh = await fakeGitHub(path.join(base, "gh-no-token"));
      const { code, out, runDir } = await headless(fixing(), { repo: gh.clone, task: "add y", pr: true });
      expect(code).toBe(EXIT.prFailed);
      expect(out).toContain("Not pushed: set GITHUB_TOKEN to push the fix and open a pull request.");
      expect(JSON.parse(await readFile(path.join(runDir!, "result.json"), "utf8")).pullRequest).toEqual({ error: "GITHUB_TOKEN is not set" });
    });
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
