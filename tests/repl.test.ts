import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { UsageTracker } from "../src/model/cost.js";
import { ModelError, type ChatRequest, type ChatResponse, type ModelClient } from "../src/model/index.js";
import { startRepl } from "../src/ui/repl.js";
import { makeSourceRepo } from "./helpers.js";

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

  it("/fix <n> fetches the issue of the clone's GitHub repository and gives it to the agent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "harness-repl-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], { cwd: dir });
      const fetched: string[] = [];
      const fetchImpl = (async (url: string) => {
        fetched.push(url);
        return new Response(JSON.stringify({ title: "Crash on empty input", body: "Steps: run it", state: "open", comments: 0, labels: [] }), { status: 200 });
      }) as typeof fetch;
      const { model, requests } = fakeModel();
      const input = new PassThrough();
      const output = new PassThrough();
      let out = "";
      output.on("data", (d) => (out += d.toString()));
      input.end([`/repo ${dir}`, "/fix 7", "/fix make the greeting louder", "/exit"].map((l) => `${l}\n`).join(""));
      await startRepl({ config, model, tracker: new UsageTracker(config.pricing), input, output, fetchImpl });

      expect(fetched).toEqual(["https://api.github.com/repos/acme/widget/issues/7"]);
      expect(out).toContain("Issue acme/widget#7: Crash on empty input (open, 0 comments)");
      const first = requests[0]!.messages[0]!;
      expect(first.role === "user" && first.content).toContain("<issue>\n# Crash on empty input");
      expect(out).toContain("Task: make the greeting louder");
      const last = requests[1]!.messages[requests[1]!.messages.length - 1]!;
      expect(last.role === "user" && last.content).toBe("Fix this in the repository:\n\nmake the greeting louder");
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
      expect(requests[0]!.tools?.map((t) => t.name)).toEqual(["view_file", "list_dir", "search", "find_files", "edit_file", "create_file", "bash", "finish"]);
      expect(requests[1]!.messages[2]).toMatchObject({ role: "tool", results: [{ content: "1\tprint('hi')" }] });
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
