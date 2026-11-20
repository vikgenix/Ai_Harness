import type { StageState, UsageInfo } from "../view.js";
import { fit, RESET, style, truncate, width, wrap } from "./ansi.js";

/**
 * The screen as a pure function of its state: panels for the task, the
 * progress of the fix, the changed files, the activity (agent text and tool
 * calls) and the diff, with a header, a status bar and the input line.
 *
 *   ┌ Task ────────┐┌ Activity ─────────────────┐
 *   │              ││                           │
 *   ├ Progress ────┤│                           │
 *   │              │├ Diff ─────────────────────┤
 *   ├ Files ───────┤│                           │
 *   └──────────────┘└───────────────────────────┘
 *    status bar
 *   shrike › input
 *    hints
 */

export interface ToolEntry {
  kind: "tool";
  id: string;
  label: string;
  status: "running" | "ok" | "error";
  started: number;
  ms?: number;
  error?: string;
}
export interface TextEntry {
  kind: "text";
  text: string;
}
export type Entry = ToolEntry | TextEntry;

export interface Stage {
  name: string;
  state: StageState;
  detail?: string;
}

export interface DiffFile {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface ScreenState {
  model: string;
  workdir: string;
  branch?: string;
  sandbox?: string;
  task?: { kind: "fix" | "audit" | "chat"; title: string; detail?: string };
  stages: Stage[];
  entries: Entry[];
  diff?: { files: DiffFile[]; patch: string };
  usage?: UsageInfo;
  /** When the current work started; undefined when idle. */
  busySince?: number;
  question?: string;
  input: { text: string; cursor: number; suggestions: string[] };
  /** Lines scrolled up from the bottom of the activity, and down from the top of the diff. */
  activityScroll: number;
  diffScroll: number;
  notice?: string;
}

export interface Frame {
  lines: string[];
  /** Where the cursor goes (0-based), in the input line. */
  cursor: { row: number; col: number };
  /** Rows of the activity and diff panels, for paging. */
  activityRows: number;
  diffRows: number;
  /** Activity lines in total, to keep the scroll position in range. */
  activityLines: number;
  diffLines: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (now: number) => SPINNER[Math.floor(now / 100) % SPINNER.length]!;

/** Smallest screen that gets panels; anything smaller shows a note. */
export const MIN_COLS = 50;
export const MIN_ROWS = 12;
/** Below these, the left column is left out. */
const SIDE_COLS = 100;
const SIDE_ROWS = 22;

const box = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" };

/** A panel: border, title, and `content` lines fitted inside. */
function panel(title: string, content: string[], cols: number, rows: number, opts: { focused?: boolean; right?: string } = {}): string[] {
  if (rows < 2 || cols < 4) return Array.from({ length: Math.max(0, rows) }, () => " ".repeat(Math.max(0, cols)));
  const paint = opts.focused ? style.cyan : style.gray;
  const label = ` ${title} `;
  const right = opts.right ? ` ${opts.right} ` : "";
  const fill = Math.max(0, cols - 2 - width(label) - width(right) - 1);
  const top = paint(box.tl + box.h) + style.bold(truncate(label, cols - 3)) + paint(box.h.repeat(fill)) + (right && fill > 0 ? style.gray(right) : "") + paint(box.tr);
  const lines = [fit(top, cols)];
  const inner = cols - 2;
  for (let i = 0; i < rows - 2; i++) lines.push(paint(box.v) + fit(content[i] ?? "", inner) + paint(box.v));
  lines.push(paint(box.bl + box.h.repeat(cols - 2) + box.br));
  return lines;
}

/** Two columns of lines side by side. */
const beside = (left: string[], right: string[]) => left.map((l, i) => l + (right[i] ?? ""));

function stageIcon(state: StageState, now: number): string {
  return { running: style.yellow(spinner(now)), done: style.green("✓"), failed: style.red("✗"), skipped: style.gray("–") }[state];
}

function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// --- panels' content -----------------------------------------------------------------

function taskLines(state: ScreenState, cols: number): string[] {
  if (!state.task) {
    return [
      style.gray("No task yet. Try:"),
      `${style.cyan("/repo")} owner/project`,
      `${style.cyan("/fix")} 123 ${style.gray("or a bug in words")}`,
      `${style.cyan("/audit")} ${style.gray("to look for bugs")}`,
      style.gray("or ask about the code."),
    ].flatMap((l) => wrap(l, cols));
  }
  const kind = { fix: style.magenta("FIX"), audit: style.yellow("AUDIT"), chat: style.cyan("CHAT") }[state.task.kind];
  return [...wrap(`${kind} ${style.bold(state.task.title)}`, cols), ...(state.task.detail ? ["", ...wrap(style.gray(state.task.detail.trim()), cols)] : [])];
}

function progressLines(state: ScreenState, cols: number, now: number): string[] {
  if (!state.stages.length) return [style.gray(state.busySince ? "Working..." : "Idle.")];
  const nameWidth = Math.min(13, Math.max(...state.stages.map((s) => width(s.name))));
  return state.stages.map((s) => {
    const detail = s.detail ? ` ${style.gray(s.detail)}` : "";
    return truncate(`${stageIcon(s.state, now)} ${fit(s.name, nameWidth)}${detail}`, cols);
  });
}

function filesLines(state: ScreenState, cols: number): string[] {
  const files = state.diff?.files ?? [];
  if (!files.length) return [style.gray("No changes.")];
  const colour = (s: string) => (s === "A" ? style.green(s) : s === "D" ? style.red(s) : style.yellow(s));
  return files.map((f) => {
    const counts = `${style.green(`+${f.added}`)} ${style.red(`-${f.removed}`)}`;
    const name = truncate(f.path, Math.max(4, cols - width(counts) - 3));
    return `${colour(f.status)} ${fit(name, cols - width(counts) - 3)} ${counts}`;
  });
}

/** Activity lines are wrapped once per width and entry; only the entry still growing is wrapped again. */
const wrapCache = new WeakMap<TextEntry, { cols: number; length: number; lines: string[] }>();

export function activityLines(state: ScreenState, cols: number, now: number): string[] {
  const out: string[] = [];
  for (const e of state.entries) {
    if (e.kind === "text") {
      const cached = wrapCache.get(e);
      if (cached && cached.cols === cols && cached.length === e.text.length) out.push(...cached.lines);
      else {
        const lines = wrap(e.text.replace(/\n$/, ""), cols);
        wrapCache.set(e, { cols, length: e.text.length, lines });
        out.push(...lines);
      }
      continue;
    }
    const icon = e.status === "running" ? style.yellow(spinner(now)) : e.status === "ok" ? style.green("✓") : style.red("✗");
    const time = style.gray(seconds(e.ms ?? now - e.started));
    const label = truncate(e.label, Math.max(4, cols - width(time) - 5));
    out.push(`  ${icon} ${fit(label, cols - width(time) - 5)} ${time}`);
    if (e.error) out.push(truncate(style.red(`      ${e.error}`), cols));
  }
  // Collapse runs of blank lines.
  return out.filter((l, i) => !(l.trim() === "" && (out[i - 1] ?? "").trim() === "" && i > 0));
}

export function diffLines(state: ScreenState, cols: number): string[] {
  if (!state.diff?.patch) return [style.gray("No changes yet: edits by the agent show up here.")];
  const out: string[] = [];
  for (const raw of state.diff.patch.split("\n")) {
    const line = raw.replace(/\t/g, "    ");
    if (line.startsWith("diff --git ")) {
      const file = /^diff --git a\/(.*) b\/(.*)$/.exec(line)?.[2] ?? line.slice(11);
      if (out.length) out.push("");
      out.push(style.bold(style.cyan(truncate(`▍ ${file}`, cols))));
    } else if (/^(index |--- |\+\+\+ |similarity |rename |old mode|new mode|deleted file|new file)/.test(line)) {
      if (/^(new file|deleted file|rename )/.test(line)) out.push(style.gray(truncate(`  ${line}`, cols)));
    } else if (line.startsWith("@@")) out.push(style.cyan(truncate(line.replace(/^(@@[^@]*@@).*/, "$1"), cols)));
    else if (line.startsWith("+")) out.push(style.green(truncate(line, cols)));
    else if (line.startsWith("-")) out.push(style.red(truncate(line, cols)));
    else if (line.startsWith("\\")) out.push(style.gray(truncate(line, cols)));
    else out.push(truncate(line, cols));
  }
  return out;
}

// --- bars --------------------------------------------------------------------------

function header(state: ScreenState, cols: number): string {
  const where = [state.workdir.split("/").filter(Boolean).pop() ?? state.workdir, state.branch, state.sandbox && `docker ${state.sandbox}`].filter(Boolean).join(" · ");
  const left = ` ${style.bold("▲ shrike")}  ${where}`;
  const right = `${state.model} `;
  return style.inverse(fit(left, cols - width(right)) + right);
}

function statusBar(state: ScreenState, cols: number, now: number): string {
  const u = state.usage;
  const parts: string[] = [];
  if (state.busySince !== undefined) parts.push(`${style.yellow(spinner(now))} ${seconds(now - state.busySince)}`);
  else parts.push(style.green("● ready"));
  if (u) {
    parts.push(`step ${u.steps}/${u.maxSteps}`);
    parts.push(`${tokens(u.inputTokens)} in · ${tokens(u.outputTokens)} out${u.cacheReadTokens ? ` · ${tokens(u.cacheReadTokens)} cached` : ""}`);
    parts.push(u.runCostUsd === undefined ? "cost unknown" : `$${u.runCostUsd.toFixed(2)} / $${u.maxCostUsd.toFixed(2)}`);
    if (u.sessionCostUsd) parts.push(style.gray(`session $${u.sessionCostUsd.toFixed(2)}`));
  }
  return ` ${truncate(parts.join(style.gray("  │  ")), cols - 2)}`;
}

function inputLine(state: ScreenState, cols: number): { line: string; col: number } {
  const label = state.question ? `${style.yellow(style.bold(truncate(state.question, Math.floor(cols / 2))))} ${style.yellow("›")} ` : `${style.cyan(style.bold("shrike ›"))} `;
  const room = Math.max(1, cols - width(label) - 1);
  const chars = [...state.input.text];
  // Scroll the text so the cursor stays visible.
  let start = 0;
  const widthOf = (a: string[]) => width(a.join(""));
  while (widthOf(chars.slice(start, state.input.cursor)) > room) start++;
  let shown = chars.slice(start);
  while (widthOf(shown) > room) shown = shown.slice(0, -1);
  return { line: fit(label + shown.join(""), cols), col: width(label) + widthOf(chars.slice(start, state.input.cursor)) };
}

function hintLine(state: ScreenState, cols: number): string {
  if (state.notice) return ` ${style.yellow(truncate(state.notice, cols - 2))}`;
  if (state.input.suggestions.length) return ` ${style.gray("Tab:")} ${state.input.suggestions.map((s) => style.cyan(s)).join("  ")}`;
  const keys = state.busySince !== undefined ? "Ctrl-C cancel" : "Enter send · Tab complete · ↑↓ history · Ctrl-C quit";
  return ` ${style.gray(truncate(`${keys} · PgUp/PgDn activity · Ctrl-↑↓ diff`, cols - 2))}`;
}

// --- the frame -----------------------------------------------------------------------

export function render(state: ScreenState, cols: number, rows: number, now: number): Frame {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    const lines = Array.from({ length: rows }, () => " ".repeat(Math.max(0, cols)));
    const note = `Make the terminal at least ${MIN_COLS}×${MIN_ROWS}.`;
    if (rows > 0) lines[0] = fit(style.yellow(note), cols);
    const input = inputLine(state, cols);
    if (rows > 1) lines[rows - 1] = input.line;
    return { lines, cursor: { row: Math.max(0, rows - 1), col: input.col }, activityRows: 0, diffRows: 0, activityLines: 0, diffLines: 0 };
  }

  const body = rows - 4; // header, status, input, hints
  const side = cols >= SIDE_COLS && rows >= SIDE_ROWS;
  const leftCols = side ? Math.max(30, Math.min(48, Math.round(cols * 0.32))) : 0;
  const rightCols = cols - leftCols;
  const stripRows = side ? 0 : 1; // narrow: the task on one line instead of the left column
  const avail = body - stripRows;

  // Right column: activity, and the diff below it once there is one.
  const hasDiff = Boolean(state.diff?.patch);
  const diffRows = hasDiff ? Math.max(5, Math.round(avail * 0.42)) : 0;
  const activityRows = avail - diffRows;
  const allActivity = activityLines(state, rightCols - 2, now);
  const actInner = activityRows - 2;
  const actScroll = Math.min(state.activityScroll, Math.max(0, allActivity.length - actInner));
  const actEnd = allActivity.length - actScroll;
  const right = panel("Activity", allActivity.slice(Math.max(0, actEnd - actInner), actEnd), rightCols, activityRows, {
    focused: state.busySince !== undefined,
    right: actScroll ? `↑ ${actScroll} more below` : undefined,
  });
  let allDiff: string[] = [];
  if (hasDiff) {
    allDiff = diffLines(state, rightCols - 2);
    const inner = diffRows - 2;
    const scroll = Math.min(state.diffScroll, Math.max(0, allDiff.length - inner));
    const files = state.diff!.files;
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const more = allDiff.length - scroll - inner;
    const title = `Diff · ${files.length} ${files.length === 1 ? "file" : "files"} ${style.green(`+${added}`)} ${style.red(`-${removed}`)}`;
    right.push(...panel(title, allDiff.slice(scroll, scroll + inner), rightCols, diffRows, { right: more > 0 ? `${more} more ↓` : undefined }));
  }

  let main: string[];
  if (side) {
    const inner = leftCols - 2;
    const progress = progressLines(state, inner, now);
    const files = filesLines(state, inner);
    const progressRows = Math.min(progress.length + 2, Math.max(4, Math.floor(body * 0.4)));
    const filesRows = Math.min(files.length + 2, Math.max(3, Math.floor(body * 0.25)));
    const taskRows = body - progressRows - filesRows;
    const task = taskLines(state, inner);
    const taskShown = task.length > taskRows - 2 ? [...task.slice(0, taskRows - 3), style.gray("…")] : task;
    const left = [
      ...panel("Task", taskShown, leftCols, taskRows),
      ...panel("Progress", progress.slice(-(progressRows - 2)), leftCols, progressRows),
      ...panel("Files", files, leftCols, filesRows, { right: files.length > filesRows - 2 ? `${files.length}` : undefined }),
    ];
    main = beside(left, right);
  } else {
    const current = [...state.stages].reverse().find((s) => s.state === "running") ?? state.stages.at(-1);
    const title = state.task ? style.bold(state.task.title) : style.gray("No task yet: /repo, /fix, /audit or a question");
    const stage = current ? `  ${stageIcon(current.state, now)} ${current.name}${current.detail ? style.gray(` ${current.detail}`) : ""}` : "";
    main = [` ${title}${stage}`, ...right];
  }

  const input = inputLine(state, cols);
  const lines = [header(state, cols), ...main.slice(0, body).map((l) => fit(l, cols)), fit(statusBar(state, cols, now), cols), input.line, fit(hintLine(state, cols), cols)];
  while (lines.length < rows) lines.splice(lines.length - 3, 0, " ".repeat(cols));
  return {
    lines: lines.map((l) => (l.includes("\x1b") ? l + RESET : l)),
    cursor: { row: rows - 2, col: Math.min(cols - 1, input.col) },
    activityRows: actInner,
    diffRows: Math.max(0, diffRows - 2),
    activityLines: allActivity.length,
    diffLines: allDiff.length,
  };
}
