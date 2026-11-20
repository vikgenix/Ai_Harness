import { describe, expect, it } from "vitest";
import { stripAnsi, width } from "../../../src/ui/tui/ansi.js";
import { diffLines, editPreview, liveArea, markdownLine, matchingCommands, toolLine, toolSummary, type LiveState } from "../../../src/ui/tui/render.js";

const idle = (extra: Partial<LiveState> = {}): LiveState => ({
  partial: "",
  running: [],
  input: { text: "", cursor: 0 },
  menu: { items: [], selected: 0 },
  where: "acme__demo · shrike/fix-7",
  ...extra,
});
const plain = (lines: string[]) => lines.map(stripAnsi);

describe("markdownLine", () => {
  it("styles headings, bullets, bold and code, and keeps code blocks as they are", () => {
    const state = { fence: false };
    expect(stripAnsi(markdownLine("## The cause", state))).toBe("The cause");
    expect(stripAnsi(markdownLine("- calls **greet** in `app.py`", state))).toBe("• calls greet in app.py");
    expect(markdownLine("`x`", state)).toBe("\x1b[36mx\x1b[0m");
    markdownLine("```python", state);
    expect(state.fence).toBe(true);
    expect(stripAnsi(markdownLine("# not a heading", state))).toBe("│ # not a heading");
    markdownLine("```", state);
    expect(state.fence).toBe(false);
  });
});

describe("tool lines", () => {
  const call = (name: string, input: Record<string, unknown>) => ({ id: "1", name, input });

  it("say what a call does in a few words", () => {
    expect(toolSummary(call("view_file", { path: "src/a.py", start_line: 10, end_line: 20 }))).toEqual({ verb: "Read", target: "src/a.py:10-20" });
    expect(toolSummary(call("grep", { pattern: "greet", path: "src" }))).toEqual({ verb: "Search", target: '"greet" in src' });
    expect(toolSummary(call("bash", { command: "cd x &&\n pytest -q" }))).toEqual({ verb: "Run", target: "cd x && ⏎ pytest -q" });
    expect(toolSummary(call("list_dir", {}))).toEqual({ verb: "List", target: "." });
    expect(toolSummary(call("finish", { summary: "done" }))).toBeUndefined();
  });

  it("fit the width, with the edit's size and the time", () => {
    const line = toolLine(call("edit_file", { path: `src/${"deep/".repeat(30)}app.py`, old_string: "a\nb", new_string: "c" }), "ok", 1500, 0, 60);
    expect(width(line)).toBeLessThanOrEqual(60);
    expect(stripAnsi(line)).toMatch(/^ {2}✓ Edit src\/deep\/.*… {2}\+1 -2 {2}1\.5s$/);
  });

  it("show an edit's removed and added lines, cut after a few", () => {
    const edit = call("edit_file", { path: "a.py", old_string: "x = 1\n", new_string: "x = 2\ny = 3\n" });
    expect(plain(editPreview(edit, 80))).toEqual(["      - x = 1", "      + x = 2", "      + y = 3"]);
    const big = call("edit_file", { path: "a.py", old_string: "", new_string: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") });
    const shown = plain(editPreview(big, 80));
    expect(shown).toHaveLength(8);
    expect(shown.at(-1)).toBe("      … 13 more lines (/diff shows all)");
  });
});

describe("liveArea", () => {
  it.each([
    [100, 30],
    [60, 20],
    [30, 10],
  ])("draws lines exactly %i wide", (cols, rows) => {
    const live = liveArea(idle({ busySince: 0, partial: "Thinking about it", running: [{ call: { id: "1", name: "bash", input: { command: "pytest" } }, started: 0 }] }), cols, rows, 2000);
    for (const line of live.lines) expect(width(line)).toBe(cols);
    expect(live.lines.length).toBeLessThan(rows);
  });

  it("shows the running work above the input box, and the footer below", () => {
    const live = liveArea(
      idle({
        busySince: 0,
        stage: { name: "Agent" },
        partial: "Looking at **app.py**",
        running: [{ call: { id: "1", name: "bash", input: { command: "pytest -q" } }, started: 1000 }],
        usage: { steps: 4, maxSteps: 60, runCostUsd: 0.12, maxCostUsd: 2, inputTokens: 41_200, outputTokens: 3100, cacheReadTokens: 0, sessionCostUsd: 0.3 },
      }),
      100,
      30,
      3000,
    );
    const text = plain(live.lines);
    expect(text[0]).toMatch(/^ {2}Looking at app\.py +$/);
    expect(text[1]).toMatch(/^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Run pytest -q {2}2\.0s +$/);
    expect(text[3]).toMatch(/^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Agent 3\.0s · step 4\/60 · 41\.2k in · 3\.1k out · \$0\.12 \/ \$2\.00 +$/);
    expect(text[4]).toMatch(/^╭─+╮$/);
    expect(text[5]).toMatch(/^│ › Esc to cancel · type to queue a message +│$/);
    expect(text[7]).toMatch(/^ Esc to cancel +acme__demo · shrike\/fix-7 · \$0\.30 $/);
    expect(live.cursor).toEqual({ row: 5, col: 4 });
  });

  it("wraps long input inside the box and keeps the cursor on it", () => {
    const text = "x".repeat(150);
    const live = liveArea(idle({ input: { text, cursor: 150 } }), 60, 20, 0);
    const box = plain(live.lines).filter((l) => l.startsWith("│"));
    expect(box).toHaveLength(3); // 54 characters a row
    expect(box[0]).toBe(`│ › ${"x".repeat(54)} │`);
    expect(box[2]).toBe(`│   ${"x".repeat(42)}${" ".repeat(12)} │`);
    expect(live.cursor).toEqual({ row: 4, col: 46 }); // a blank line, the top border, then the third row
  });

  it("puts a question in the box's title, lists matching commands, and hints a command's arguments", () => {
    const asked = plain(liveArea(idle({ question: "Post this issue? [y/N/q]" }), 60, 20, 0).lines);
    expect(asked[1]).toMatch(/^╭─ Post this issue\? \[y\/N\/q\] ─+╮$/);
    const menu = plain(liveArea(idle({ input: { text: "/p", cursor: 2 }, menu: { items: matchingCommands("/p"), selected: 1 } }), 80, 20, 0).lines);
    expect(menu.slice(-2)).toEqual([expect.stringMatching(/^ {3}\/pr +push the fix branch/), expect.stringMatching(/^ › \/project +how the project is built/)]);
    const hinted = plain(liveArea(idle({ input: { text: "/fix ", cursor: 5 } }), 80, 20, 0).lines);
    expect(hinted).toContainEqual(expect.stringMatching(/^│ › \/fix <issue number \| issue URL \| description> +│$/));
  });
});

describe("diffLines", () => {
  it("shows files and hunks, colours additions and removals, and leaves out git's bookkeeping", () => {
    const patch = ["diff --git a/src/app.py b/src/app.py", "index 1..2 100644", "--- a/src/app.py", "+++ b/src/app.py", "@@ -1,2 +1,2 @@ def greet", " def greet(name):", "-    return 'hi'", "+    return 'HI'"].join("\n");
    const lines = diffLines(patch, 60);
    expect(plain(lines)).toEqual(["  src/app.py", "  @@ -1,2 +1,2 @@", "   def greet(name):", "  -    return 'hi'", "  +    return 'HI'"]);
    expect(lines[3]).toContain("\x1b[31m");
    expect(lines[4]).toContain("\x1b[32m");
  });
});
