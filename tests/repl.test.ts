import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { UsageTracker } from "../src/model/cost.js";
import { ModelError, type ChatRequest, type ChatResponse, type ModelClient, type ToolCall } from "../src/model/index.js";
import { startRepl } from "../src/ui/repl.js";
import { makeSourceRepo } from "./helpers.js";
import { fakeGitHub } from "./github/fake-github.js";

const config = loadConfig({ env: { AI_API_KEY: "sk-ant-fake" } });

/** Fake model: replies with "echo: <last message>" or runs a custom handler. */
function fakeModel(handler?: (req: ChatRequest, call: number) => Promise<ChatResponse> | ChatResponse) {
  const requests: ChatRequest[] = [];
  const model: ModelClient = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    async chat(req) {
      requests.push(structuredClone({ ...req, onText: undefined, signal: undefined }));
      if (handler) return handler(req, requests.length);
      const lastMsg = req.messages[req.messages.length - 1];
      const last = lastMsg && lastMsg.role !== "tool" ? lastMsg.content : "";
      const text = `echo: ${last}`;
      req.onText?.(text);
      return {
        message: { role: "assistant", content: text },
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        model: "claude-opus-5-5",
        durationMs: 5,
      };
    },
  };
  return { model, requests };
}

async function run(lines: string[], model: ModelClient, tracker = new UsageTracker(config.pricing), workdir?: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (d) => (out += d.toString()));
  input.end(lines.map((l) => `${l}\n`).join(""));
  await startRepl({ config, model, tracker, input, output, workdir });
  return { out, tracker };
}

describe("/pr", () => {
  const session = async (lines: string[], extra: Partial<Parameters<typeof startRepl>[0]>) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (d) => (out += d.toString()));
    input.end(lines.map((l) => `${l}\n`).join(""));
    await startRepl({ config, model: fakeModel().model, tracker: new UsageTracker(config.pricing), input, output, ...extra });
    return out;
  };

  it("shows the pull request, asks, and pushes only after a yes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-pr-"));
    const saved = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const gh = await fakeGitHub(dir);
      const github = { githubToken: "ghp_x", fetchImpl: gh.fetchImpl, githubHosts: gh.hosts };

      expect(await session([`/repo ${gh.clone}`, "/pr", "/exit"], {})).toContain("Set GITHUB_TOKEN to push branches and open pull requests");

      const declined = await session([`/repo ${gh.clone}`, "/pr", "n", "/exit"], github);
      expect(declined).toContain("Pull request to acme/demo (draft):\n  harness/fix-7 → ");
      expect(declined).toContain("Push harness/fix-7 and open this pull request? [y/N] Not pushed.");
      expect(gh.branches("acme")).not.toContain("harness/fix-7");
      expect(gh.calls).toEqual([]);

      const accepted = await session([`/repo ${gh.clone}`, "/pr", "y", "/exit"], github);
      expect(accepted).toContain("Pushed to acme/demo:harness/fix-7. Opened draft pull request #42: https://github.com/acme/demo/pull/42");
      expect(gh.branches("acme")).toContain("harness/fix-7");
    } finally {
      process.env = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("interactive session", () => {
  it("sends chat messages with the full conversation and shows usage", async () => {
    const { model, requests } = fakeModel();
    const { out, tracker } = await run(["hello", "again", "/exit"], model);

    expect(out).toContain("echo: hello");
    expect(out).toContain("echo: again");
    expect(out).toContain("$4.0000"); // 1M input tokens of claude-opus-5-5
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.map((m) => (m.role === "tool" ? "" : m.content))).toEqual(["hello", "echo: hello", "again"]);
    expect(requests[0]!.system).toBe(requests[1]!.system); // stable system prompt for caching
    expect(tracker.requests).toBe(2);
  });

  it("/clear starts a new conversation; /cost shows totals", async () => {
    const { model, requests } = fakeModel();
    const { out } = await run(["one", "/clear", "two", "/cost", "/exit"], model);
    expect(requests[1]!.messages).toEqual([{ role: "user", content: "two" }]);
    expect(out).toContain("Started a new conversation.");
    expect(out).toMatch(/2 requests · 2,000,000 in · 0 out · \$8\.0000/);
  });

  it("reports model errors and keeps the failed turn out of the history", async () => {
    const { model, requests } = fakeModel((req, call) => {
      if (call === 1) throw new ModelError("auth", "invalid x-api-key", 401);
      return {
        message: { role: "assistant", content: "ok" },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stopReason: "end",
        model: "claude-opus-5-5",
        durationMs: 1,
      };
    });
    const { out } = await run(["first", "second", "/exit"], model);
    expect(out).toContain("Model error: Check that AI_API_KEY is valid");
    expect(requests[1]!.messages).toEqual([{ role: "user", content: "second" }]);
  });

  it("explains refusals and cut-off replies", async () => {
    const reasons = ["refusal", "max_tokens"] as const;
    const { model } = fakeModel((_req, call) => ({
      message: { role: "assistant", content: "" },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: reasons[call - 1]!,
      model: "unlisted-model",
      durationMs: 1,
    }));
    const { out } = await run(["a", "b", "/cost"], model);
    expect(out).toContain("(the model declined to answer)");
    expect(out).toContain("(reply cut off at max_output_tokens)");
    expect(out).toContain("cost unknown");
    expect(out).toContain("no price for: unlisted-model");
  });

  it("keeps the slash commands working without calling the model", async () => {
    const { model, requests } = fakeModel();
    const { out } = await run(["/fix 3", "/repo not-a-repo", "/bogus"], model);
    expect(out).toContain("Open a repository first: /repo <url>");
    expect(out).toContain("'not-a-repo' is not a directory or a repository URL");
    expect(out).toContain("Unknown command '/bogus'");
    expect(requests).toHaveLength(0);
  });

  it("/repo <url> clones the repository and works in the clone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      const url = await makeSourceRepo(path.join(dir, "demo"));
      const workspacesDir = path.join(dir, "ws");
      const { model, requests } = fakeModel();
      const input = new PassThrough();
      const output = new PassThrough();
      let out = "";
      output.on("data", (d) => (out += d.toString()));
      input.end(["hello", `/repo ${url}`, "what is here?", `/repo ${url}`, "/fix 3", "/exit"].map((l) => `${l}\n`).join(""));
      await startRepl({ config, model, tracker: new UsageTracker(config.pricing), input, output, workspacesDir });

      const clone = path.join(workspacesDir, "local__demo");
      expect(out).toContain("Cloning local/demo...");
      expect(out).toMatch(/Cloned in \d+\.\ds\./);
      expect(out).toContain(`Working directory: ${clone} (new conversation)`);
      expect(out).toContain("Using the existing clone");
      expect(out).toContain("'3' is an issue number, but the working directory is not a GitHub clone");
      expect(requests[1]!.system).toContain(clone);
      expect(requests[1]!.messages).toEqual([{ role: "user", content: "what is here?" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/fix <n> fetches the issue, fixes it on a branch and commits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      await makeSourceRepo(dir);
      execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], { cwd: dir });
      const fetched: string[] = [];
      const fetchImpl = (async (url: string) => {
        fetched.push(url);
        return new Response(JSON.stringify({ title: "Crash on empty input", body: "Steps: run it", state: "open", comments: 0, labels: [] }), { status: 200 });
      }) as typeof fetch;
      const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const reply = (content: string, toolCalls?: ToolCall[]): ChatResponse => ({
        message: { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) },
        usage,
        stopReason: toolCalls ? "tool_use" : "end",
        model: "claude-opus-5-5",
        durationMs: 1,
      });
      const { model, requests } = fakeModel((_req, call) => {
        if (call === 1) return reply("Hi."); // the chat message before /fix
        if (call === 2) return reply("", [{ id: "c1", name: "create_file", input: { path: "src/fix.py", content: "x = 1\n" } }]);
        if (call === 3) return reply("", [{ id: "f1", name: "finish", input: { outcome: "completed", summary: "Added src/fix.py." } }]);
        if (call === 4) return reply("", [{ id: "f2", name: "finish", input: { outcome: "completed", summary: "Added src/fix.py." } }]); // after the self-review
        return reply("I would need more details."); // the second /fix: answers without finishing
      });
      const input = new PassThrough();
      const output = new PassThrough();
      let out = "";
      output.on("data", (d) => (out += d.toString()));
      input.end([`/repo ${dir}`, "hello", "/fix 7", "/fix make the greeting louder", "/exit"].map((l) => `${l}\n`).join(""));
      await startRepl({ config, model, tracker: new UsageTracker(config.pricing), input, output, fetchImpl });

      expect(fetched).toEqual(["https://api.github.com/repos/acme/widget/issues/7"]);
      expect(out).toContain("Issue acme/widget#7: Crash on empty input (open, 0 comments)\nWorking on branch harness/fix-7 (from ");
      // The fix starts a fresh conversation with the fix prompt, not the chat's.
      expect(requests[1]!.system).toContain("fixing one problem");
      expect(requests[1]!.messages).toHaveLength(1);
      const first = requests[1]!.messages[0]!;
      expect(first.role === "user" && first.content).toContain("<issue>\n# Crash on empty input");
      // The repository map comes first in the task message.
      expect(out).toMatch(/Working on branch harness\/fix-7 \(from \w+\)\.\nRepo map: 2 files, 0 with symbols.*\nProject: no known project files found\.\n/);
      expect(first.role === "user" && first.content).toContain("</repo_map>\nThe map above was generated");
      expect(first.role === "user" && first.content).toMatch(/<project>\nNo known project files[^]*<\/project>\n\nFix GitHub issue #7/);
      expect(first.role === "user" && first.content).toMatch(/^<repo_map>\n[^]*Files:\n {2}\.\/: README\.md\n {2}src\/: app\.py\n<\/repo_map>\n/);
      expect(out).toContain("  ↻ Self-review: 1 file changed, 1 to check (No test file was added or changed).");
      expect(out).toContain("✓ Done: Added src/fix.py.");
      expect(out).toMatch(/Committed [0-9a-f]+ on branch harness\/fix-7 \(1 file: src\/fix\.py\)\./);
      const log = execFileSync("git", ["log", "-1", "--format=%s", "harness/fix-7"], { cwd: dir }).toString().trim();
      expect(log).toBe("Fix #7: Crash on empty input");

      expect(out).toContain("Task: make the greeting louder\nWorking on branch harness/make-the-greeting-louder (from harness/fix-7).");
      expect(out).toContain("Not committed: the agent stopped without calling finish. No files were changed.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/fix refuses to start with uncommitted changes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      await makeSourceRepo(dir);
      await writeFile(path.join(dir, "README.md"), "changed\n");
      const { model, requests } = fakeModel();
      const { out } = await run([`/repo ${dir}`, "/fix tidy up", "/exit"], model);
      expect(out).toContain("The working directory has uncommitted changes:\n M README.md");
      expect(requests).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clones the starting repository before reading input", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      const url = await makeSourceRepo(path.join(dir, "demo"));
      const { model, requests } = fakeModel();
      const input = new PassThrough();
      const output = new PassThrough();
      input.end("hi\n/exit\n"); // already waiting before the clone finishes
      await startRepl({ config, model, tracker: new UsageTracker(config.pricing), input, output, initialRepo: url, workspacesDir: path.join(dir, "ws") });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.system).toContain(path.join(dir, "ws", "local__demo"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs tools in the working directory and shows each call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      await writeFile(path.join(dir, "app.py"), "print('hi')\n");
      const { model, requests } = fakeModel((req, call) => {
        const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
        if (call === 1) {
          req.onText?.("Reading it.");
          return {
            message: { role: "assistant", content: "Reading it.", toolCalls: [{ id: "t1", name: "view_file", input: { path: "app.py" } }] },
            usage,
            stopReason: "tool_use",
            model: "claude-opus-5-5",
            durationMs: 1,
          };
        }
        if (call === 2) {
          return {
            message: { role: "assistant", content: "", toolCalls: [{ id: "t2", name: "view_file", input: { path: "gone.py" } }] },
            usage,
            stopReason: "tool_use",
            model: "claude-opus-5-5",
            durationMs: 1,
          };
        }
        req.onText?.("It prints hi.");
        return { message: { role: "assistant", content: "It prints hi." }, usage, stopReason: "end", model: "claude-opus-5-5", durationMs: 1 };
      });
      const { out } = await run(["what does app.py print?", "/exit"], model, undefined, dir);

      expect(out).toContain("Working directory: ");
      expect(out).toContain("Reading it.\n  → view_file(path=app.py)");
      expect(out).toContain("→ view_file(path=gone.py)\n    ✗ Error: file not found: gone.py");
      expect(out).toContain("It prints hi.");
      expect(out).toMatch(/\[claude-opus-5-5 · 3 steps · /);
      expect(requests[0]!.system).toContain(dir.split(path.sep).pop()!);
      expect(requests[0]!.tools?.map((t) => t.name)).toEqual(["view_file", "list_dir", "grep", "find_files", "edit_file", "create_file", "bash", "finish"]);
      expect(requests[1]!.messages[2]).toMatchObject({ role: "tool", results: [{ content: "1\tprint('hi')" }] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/project shows how the project is built and tested, without calling the model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      await writeFile(path.join(dir, "go.mod"), "module demo\n\ngo 1.22\n");
      const { model, requests } = fakeModel();
      const { out } = await run(["/project", "/exit"], model, undefined, dir);
      expect(out).toContain("Detected from the project files (check them if a command fails):\n- Go (go.mod, requires 1.22)\n  Tests: go test ./...  (go.mod)");
      expect(out).toMatch(/\nProject: Go · tests: go test \.\/\.\.\./);
      expect(out).not.toContain("<project>");
      expect(requests).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/map shows the repository map without calling the model", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      await writeFile(path.join(dir, "billing.py"), "class Invoice:\n    def total(self):\n        return 0\n");
      const { model, requests } = fakeModel();
      const { out } = await run(["/map invoice totals", "/exit"], model, undefined, dir);
      expect(out).toContain("billing.py:\n  1: class Invoice\n  2:   def total(self)");
      expect(out).toMatch(/Repo map: 1 file, 1 with symbols \(2 symbols\), ~\d+ tokens, [\d.]+s\./);
      expect(requests).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shows the finish summary", async () => {
    const { model } = fakeModel(() => ({
      message: { role: "assistant", content: "", toolCalls: [{ id: "f1", name: "finish", input: { outcome: "blocked", summary: "No tests found." } }] },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stopReason: "tool_use",
      model: "claude-opus-5-5",
      durationMs: 1,
    }));
    const { out } = await run(["fix it", "/exit"], model);
    expect(out).toContain("✗ Blocked: No tests found.");
    expect(out).toMatch(/\[claude-opus-5-5 · 1 step · /);
  });

  it("/repo with a local directory switches the working directory and starts over", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      const { model, requests } = fakeModel();
      const { out } = await run(["one", `/repo ${dir}`, "two", "/exit"], model);
      expect(out).toContain(`Working directory: ${dir} (new conversation)`);
      expect(requests[1]!.messages).toEqual([{ role: "user", content: "two" }]);
      expect(requests[1]!.system).toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
