import { describe, expect, it } from "vitest";
import { stripAnsi, width } from "../../../src/ui/tui/ansi.js";
import { diffLines, render, type ScreenState } from "../../../src/ui/tui/layout.js";

const base = (extra: Partial<ScreenState> = {}): ScreenState => ({
  model: "claude-opus-5-5",
  workdir: "/w/acme__demo",
  stages: [],
  entries: [],
  input: { text: "", cursor: 0, suggestions: [] },
  activityScroll: 0,
  diffScroll: 0,
  ...extra,
});

const PATCH = ["diff --git a/src/app.py b/src/app.py", "index 1..2 100644", "--- a/src/app.py", "+++ b/src/app.py", "@@ -1,2 +1,2 @@ def greet", " def greet(name):", "-    return 'hi'", "+    return 'HI'"].join("\n");

const working = base({
  branch: "shrike/fix-7",
  task: { kind: "fix", title: "#7 Greeting is too quiet", detail: "acme/demo · open\n\nThe greeting should be loud." },
  stages: [
    { name: "Branch", state: "done", detail: "shrike/fix-7" },
    { name: "Baseline", state: "done", detail: "12 passed" },
    { name: "Agent", state: "running" },
  ],
  entries: [
    { kind: "text", text: "Looking at the greeting.\n" },
    { kind: "tool", id: "1", label: "grep(pattern=greet)", status: "ok", started: 0, ms: 120 },
    { kind: "tool", id: "2", label: "bash(command=pytest)", status: "error", started: 0, ms: 2100, error: "exit code 1" },
    { kind: "tool", id: "3", label: "view_file(path=src/app.py)", status: "running", started: 9000 },
  ],
  diff: { files: [{ path: "src/app.py", status: "M", added: 1, removed: 1 }], patch: PATCH },
  usage: { steps: 4, maxSteps: 60, runCostUsd: 0.12, maxCostUsd: 2, inputTokens: 41_200, outputTokens: 3100, cacheReadTokens: 0, sessionCostUsd: 0.3 },
  busySince: 0,
});

const plain = (lines: string[]) => lines.map(stripAnsi);

describe("render", () => {
  it.each([
    [120, 32],
    [80, 24],
    [50, 12],
    [30, 8],
  ])("fills a %i×%i screen exactly", (cols, rows) => {
    const frame = render(working, cols, rows, 10_000);
    expect(frame.lines).toHaveLength(rows);
    for (const line of frame.lines) expect(width(line)).toBe(cols);
  });

  it("shows the task, progress, files, activity, diff, status and input on a wide screen", () => {
    const text = plain(render(working, 120, 32, 10_000).lines).join("\n");
    expect(text).toMatch(/^ ▲ shrike {2}acme__demo · shrike\/fix-7 +claude-opus-5-5 $/m);
    for (const title of ["Task", "Progress", "Files", "Activity", "Diff · 1 file +1 -1"]) expect(text).toContain(`─ ${title} ─`);
    expect(text).toContain("FIX #7 Greeting is too quiet");
    expect(text).toMatch(/✓ Baseline +12 passed/);
    expect(text).toMatch(/M src\/app\.py +\+1 -1/);
    expect(text).toMatch(/ {2}✓ grep\(pattern=greet\) +0\.1s/);
    expect(text).toMatch(/ {2}✗ bash\(command=pytest\) +2\.1s│\n.*│ {6}exit code 1 +│/);
    expect(text).toMatch(/ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] view_file\(path=src\/app\.py\) +1\.0s/); // running for 1 second
    expect(text).toContain("▍ src/app.py");
    expect(text).toContain("@@ -1,2 +1,2 @@");
    expect(text).toMatch(/step 4\/60 {2}│ {2}41\.2k in · 3\.1k out {2}│ {2}\$0\.12 \/ \$2\.00 {2}│ {2}session \$0\.30/);
    expect(text).toMatch(/\nshrike › +\n Ctrl-C cancel/);
  });

  it("puts the task on one line on a narrow screen, and asks for a bigger one when too small", () => {
    const narrow = plain(render(working, 80, 24, 10_000).lines);
    expect(narrow[1]).toMatch(/^ #7 Greeting is too quiet {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Agent/);
    expect(narrow.join("\n")).not.toContain("─ Task ─");
    expect(plain(render(working, 40, 10, 0).lines)[0]).toMatch(/^Make the terminal at least 50×12\./);
  });

  it("scrolls the activity, and says how much is below", () => {
    const many = base({ entries: [{ kind: "text", text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") }] });
    const bottom = plain(render(many, 120, 32, 0).lines).join("\n");
    expect(bottom).toContain("line 99");
    const up = render({ ...many, activityScroll: 30 }, 120, 32, 0);
    const text = plain(up.lines).join("\n");
    expect(text).toContain("line 69");
    expect(text).not.toContain("line 70 ");
    expect(text).toContain("↑ 30 more below");
    expect(up.activityLines).toBe(100);
  });

  it("puts the cursor in the input, after the question when one is asked", () => {
    expect(render(base({ input: { text: "/fix 7", cursor: 6, suggestions: [] } }), 120, 32, 0).cursor).toEqual({ row: 30, col: 15 });
    const asked = render(base({ question: "Post this issue? [y/N/q]", input: { text: "y", cursor: 1, suggestions: [] } }), 120, 32, 0);
    expect(stripAnsi(asked.lines[30]!)).toMatch(/^Post this issue\? \[y\/N\/q\] › y +$/);
    expect(asked.cursor).toEqual({ row: 30, col: 28 });
    expect(stripAnsi(render(base({ input: { text: "/p", cursor: 2, suggestions: ["/pr", "/project"] } }), 120, 32, 0).lines[31]!)).toMatch(/^ Tab: \/pr {2}\/project/);
  });
});

describe("diffLines", () => {
  it("shows files and hunks, colours additions and removals, and leaves out git's bookkeeping", () => {
    const lines = diffLines(base({ diff: { files: [], patch: PATCH } }), 60);
    expect(plain(lines)).toEqual(["▍ src/app.py", "@@ -1,2 +1,2 @@", " def greet(name):", "-    return 'hi'", "+    return 'HI'"]);
    expect(lines[3]).toMatch(/^\x1b\[31m/);
    expect(lines[4]).toMatch(/^\x1b\[32m/);
  });
});
