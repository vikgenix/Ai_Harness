import type { ToolCall } from "../../model/types.js";
import { describeCall } from "../repl.js";
import type { StageState, UsageInfo } from "../view.js";
import { charWidth, fit, style, truncate, width, wrap } from "./ansi.js";

/**
 * What the TUI prints, as pure functions of what happened. The conversation
 * is printed into the terminal like any program's output, so scrolling,
 * selecting and copying work as usual:
 *
 *   › fix the greeting
 *
 *   ● Looking at the greeting first.
 *     ✓ Read src/app.py  0.0s
 *     ✓ Edit src/app.py  +1 -1  0.2s
 *         - return 'hi ' + name
 *         + return 'HI ' + name
 *
 * Only the few lines at the bottom (what is running, the input box and a
 * footer) are redrawn in place; see liveArea().
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (now: number) => SPINNER[Math.floor(now / 100) % SPINNER.length]!;

export function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// --- commands ------------------------------------------------------------------------

export interface CommandInfo {
  name: string;
  /** What follows the command, shown as a hint; `required` ones are typed before running it. */
  args?: string;
  required?: boolean;
  description: string;
}

export const COMMANDS: CommandInfo[] = [
  { name: "/fix", args: "<issue number | issue URL | description>", required: true, description: "fix an issue or a described bug on a new branch" },
  { name: "/audit", args: "[focus]", description: "look for bugs and draft GitHub issues" },
  { name: "/pr", description: "push the fix branch and open a pull request" },
  { name: "/diff", description: "show the changes made so far" },
  { name: "/repo", args: "<url | directory>", required: true, description: "clone a repository or open a directory" },
  { name: "/map", args: "[words]", description: "show the repository map" },
  { name: "/project", description: "how the project is built and tested" },
  { name: "/cost", description: "tokens and cost this session" },
  { name: "/clear", description: "start a new conversation" },
  { name: "/config", description: "show the model configuration" },
  { name: "/help", description: "list the commands" },
  { name: "/exit", description: "quit" },
];

/** Commands matching what is typed (while typing the command itself). */
export function matchingCommands(text: string): CommandInfo[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  return COMMANDS.filter((c) => c.name.startsWith(text));
}

export function helpLines(): string[] {
  const pad = Math.max(...COMMANDS.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0)));
  return [
    "Ask anything about the code, or use a command:",
    ...COMMANDS.map((c) => `  ${style.cyan(c.name)}${c.args ? ` ${style.gray(c.args)}` : ""}${" ".repeat(pad - c.name.length - (c.args ? c.args.length + 1 : 0))}  ${c.description}`),
    style.gray("Esc or Ctrl-C cancels the work in progress. Ctrl-C twice (or Ctrl-D) quits."),
  ];
}

// --- conversation lines --------------------------------------------------------------

/** The left margin of everything under a bullet. */
export const INDENT = "  ";

/** Shapes one line of the model's markdown for the terminal. `fence` tracks ``` blocks across lines. */
export function markdownLine(line: string, state: { fence: boolean }): string {
  if (/^\s*(```|~~~)/.test(line)) {
    state.fence = !state.fence;
    return style.gray(line.trim().length > 3 ? line : "───");
  }
  if (state.fence) return `${style.gray("│")} ${line}`;
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return style.bold(inline(heading[1]!));
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}${style.gray("•")} ${inline(bullet[2]!)}`;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return style.gray("───");
  if (/^\s*>\s?/.test(line)) return style.gray(`│ ${inline(line.replace(/^\s*>\s?/, ""))}`);
  return inline(line);
}

/** **bold** and `code`. */
function inline(text: string): string {
  return text.replace(/`([^`]+)`/g, (_m, code: string) => style.cyan(code)).replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => style.bold(b));
}

/** Short verb and target for a tool call; undefined for calls not worth a line (finish). */
export function toolSummary(call: ToolCall): { verb: string; target: string; stats?: string } | undefined {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  const num = (k: string) => (typeof input[k] === "number" ? (input[k] as number) : undefined);
  const where = (p?: string) => (p && p !== "." ? ` in ${p}` : "");
  const lineCount = (s?: string) => (s ? s.replace(/\n$/, "").split("\n").length : 0);
  switch (call.name) {
    case "finish":
      return undefined;
    case "view_file": {
      const [start, end] = [num("start_line"), num("end_line")];
      return { verb: "Read", target: `${str("path") ?? "?"}${start || end ? `:${start ?? 1}-${end ?? ""}` : ""}` };
    }
    case "create_file":
      return { verb: "Write", target: str("path") ?? "?", stats: style.green(`+${lineCount(str("content"))}`) };
    case "edit_file":
      return { verb: "Edit", target: str("path") ?? "?", stats: `${style.green(`+${lineCount(str("new_string"))}`)} ${style.red(`-${lineCount(str("old_string"))}`)}` };
    case "grep":
      return { verb: "Search", target: `${JSON.stringify(str("pattern") ?? "")}${where(str("path"))}${str("glob") ? ` (${str("glob")})` : ""}` };
    case "find_files":
      return { verb: "Find", target: `${str("pattern") ?? "*"}${where(str("path"))}` };
    case "list_dir":
      return { verb: "List", target: str("path") || "." };
    case "bash":
      return { verb: "Run", target: (str("command") ?? "").replace(/\s*\n\s*/g, " ⏎ ") };
    default:
      return { verb: call.name, target: describeCall(call).replace(/^[^(]*\(|\)$/g, "") };
  }
}

/** A tool call: running (with a spinner) or finished. */
export function toolLine(call: ToolCall, status: "running" | "ok" | "error", ms: number, now: number, cols: number): string {
  const s = toolSummary(call)!;
  const icon = status === "running" ? style.yellow(spinner(now)) : status === "ok" ? style.green("✓") : style.red("✗");
  const tail = `${s.stats ? `  ${s.stats}` : ""}  ${style.gray(seconds(ms))}`;
  const head = `${INDENT}${icon} ${style.bold(s.verb)} `;
  return head + truncate(s.target, Math.max(8, cols - width(head) - width(tail))) + tail;
}

/** What an edit changed, under its line: removed then added lines, cut after a few. */
export function editPreview(call: ToolCall, cols: number, max = 8): string[] {
  if (call.name !== "edit_file") return [];
  const input = (call.input ?? {}) as Record<string, unknown>;
  const lines = (k: string) => (typeof input[k] === "string" && input[k] ? (input[k] as string).replace(/\n$/, "").split("\n") : []);
  const all = [...lines("old_string").map((l) => ["-", l] as const), ...lines("new_string").map((l) => ["+", l] as const)];
  const pad = `${INDENT}    `;
  const shown = all.slice(0, all.length > max ? max - 1 : max).map(([sign, l]) => {
    const text = truncate(`${sign} ${l.replace(/\t/g, "    ")}`, cols - pad.length);
    return pad + (sign === "-" ? style.red(text) : style.green(text));
  });
  if (all.length > shown.length) shown.push(style.gray(`${pad}… ${all.length - shown.length} more lines (/diff shows all)`));
  return shown;
}

export function stageLine(name: string, state: StageState, detail: string | undefined, cols: number): string {
  const icon = { running: style.yellow("◇"), done: style.green("✓"), failed: style.red("✗"), skipped: style.gray("–") }[state];
  const label = state === "skipped" ? style.gray(name) : style.bold(name);
  return truncate(`${INDENT}${icon} ${label}${detail ? `  ${style.gray(detail)}` : ""}`, cols);
}

/** The changes so far, coloured, without git's bookkeeping lines. */
export function diffLines(patch: string, cols: number): string[] {
  const out: string[] = [];
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\t/g, "    ");
    const cut = (s: string) => truncate(s, cols - INDENT.length);
    if (line.startsWith("diff --git ")) {
      const file = /^diff --git a\/(.*) b\/(.*)$/.exec(line)?.[2] ?? line.slice(11);
      if (out.length) out.push("");
      out.push(INDENT + style.bold(style.cyan(cut(file))));
    } else if (/^(index |--- |\+\+\+ |similarity |old mode|new mode)/.test(line)) continue;
    else if (/^(new file|deleted file|rename )/.test(line)) out.push(INDENT + style.gray(cut(line)));
    else if (line.startsWith("@@")) out.push(INDENT + style.gray(cut(line.replace(/^(@@[^@]*@@).*/, "$1"))));
    else if (line.startsWith("+")) out.push(INDENT + style.green(cut(line)));
    else if (line.startsWith("-")) out.push(INDENT + style.red(cut(line)));
    else if (line.startsWith("\\")) out.push(INDENT + style.gray(cut(line)));
    else if (line) out.push(INDENT + cut(line));
  }
  return out;
}

// --- the live area -----------------------------------------------------------------

export interface LiveState {
  /** The model's line still being written. */
  partial: string;
  /** Tool calls running now. */
  running: { call: ToolCall; started: number }[];
  /** The stage of a fix or audit under way. */
  stage?: { name: string; detail?: string };
  busySince?: number;
  usage?: UsageInfo;
  question?: string;
  input: { text: string; cursor: number };
  menu: { items: CommandInfo[]; selected: number };
  notice?: string;
  /** Directory and branch, for the footer. */
  where: string;
}

export interface Live {
  lines: string[];
  /** Where the cursor goes, in the input box (0-based, within `lines`). */
  cursor: { row: number; col: number };
}

const MAX_INPUT_ROWS = 8;
const MAX_PARTIAL_ROWS = 4;

/**
 * The bottom of the screen, redrawn in place: the model's unfinished line,
 * running tools, a status line while working, the input box, and a footer
 * (or the command menu while typing a command).
 */
export function liveArea(state: LiveState, cols: number, rows: number, now: number): Live {
  const lines: string[] = [];
  if (state.partial) {
    const wrapped = wrap(markdownLine(state.partial, { fence: false }), cols - INDENT.length - 1).map((l) => INDENT + l);
    lines.push(...wrapped.slice(-MAX_PARTIAL_ROWS));
  }
  for (const r of state.running) lines.push(toolLine(r.call, "running", now - r.started, now, cols - 1));

  if (state.busySince !== undefined) lines.push("", statusLine(state, cols, now));
  else lines.push("");

  const box = inputBox(state, cols);
  const boxTop = lines.length;
  lines.push(...box.lines);
  lines.push(...footer(state, cols, Math.max(1, rows - lines.length - 1)));

  // Too tall for the screen: drop from the top (the cursor row stays).
  const extra = Math.max(0, lines.length - (rows - 1));
  const shown = lines.slice(extra).map((l) => fit(l, cols));
  return { lines: shown, cursor: { row: boxTop + box.cursor.row - extra, col: box.cursor.col } };
}

function statusLine(state: LiveState, cols: number, now: number): string {
  const u = state.usage;
  const what = state.stage ? `${state.stage.name}${state.stage.detail ? ` ${state.stage.detail}` : ""}` : "Working";
  const parts = [`${style.yellow(spinner(now))} ${style.bold(what)} ${style.gray(seconds(now - (state.busySince ?? now)))}`];
  if (u) {
    parts.push(`step ${u.steps}/${u.maxSteps}`);
    parts.push(`${tokens(u.inputTokens)} in · ${tokens(u.outputTokens)} out`);
    parts.push(u.runCostUsd === undefined ? "cost unknown" : `$${u.runCostUsd.toFixed(2)} / $${u.maxCostUsd.toFixed(2)}`);
  }
  return truncate(`${INDENT}${parts.join(style.gray(" · "))}`, cols - 1);
}

function inputBox(state: LiveState, cols: number): { lines: string[]; cursor: { row: number; col: number } } {
  const asking = Boolean(state.question);
  const paint = asking ? style.yellow : style.gray;
  const inner = Math.max(4, cols - 4); // "│ " … " │"
  const title = state.question ? ` ${truncate(state.question, inner - 4)} ` : "";
  const top = paint(`╭─${title ? style.bold(title) : ""}${"─".repeat(Math.max(0, cols - 3 - width(title)))}╮`);
  const bottom = paint(`╰${"─".repeat(Math.max(0, cols - 2))}╯`);

  // The text, wrapped by width after the "› " prompt; the cursor may sit just past the end.
  const prompt = asking ? style.yellow("› ") : style.cyan(style.bold("› "));
  const room = inner - 2;
  const chars = [...state.input.text];
  const rowsOf: { start: number; end: number }[] = [];
  let start = 0;
  let w = 0;
  chars.forEach((ch, i) => {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > room) {
      rowsOf.push({ start, end: i });
      start = i;
      w = 0;
    }
    w += cw;
  });
  rowsOf.push({ start, end: chars.length });
  const widthOf = (from: number, to: number) => width(chars.slice(from, to).join(""));
  let cursorRow = rowsOf.findIndex((r) => state.input.cursor >= r.start && state.input.cursor < r.end);
  if (cursorRow === -1) cursorRow = rowsOf.length - 1;
  let cursorCol = widthOf(rowsOf[cursorRow]!.start, state.input.cursor);
  if (cursorCol >= room) {
    // At the end of a full row: the cursor starts the next one.
    rowsOf.push({ start: chars.length, end: chars.length });
    cursorRow = rowsOf.length - 1;
    cursorCol = 0;
  }
  const first = Math.max(0, Math.min(cursorRow - MAX_INPUT_ROWS + 1, rowsOf.length - MAX_INPUT_ROWS));
  const visible = rowsOf.slice(first, first + MAX_INPUT_ROWS);

  const content = visible.map((r, i) => {
    let text = chars.slice(r.start, r.end).join("");
    if (!chars.length) text = style.gray(placeholder(state));
    else if (i === visible.length - 1 && r.end === chars.length) text += argsHint(state.input.text);
    const lead = first + i === 0 ? prompt : "  ";
    return `${paint("│")} ${fit(lead + text, inner)} ${paint("│")}`;
  });
  return { lines: [top, ...content, bottom], cursor: { row: 1 + cursorRow - first, col: 4 + cursorCol } };
}

function placeholder(state: LiveState): string {
  if (state.question) return "type your answer and press Enter";
  if (state.busySince !== undefined) return "Esc to cancel · type to queue a message";
  return "Ask about the code, or type / for commands";
}

/** After "/fix ", what the command expects. */
function argsHint(text: string): string {
  const m = /^(\/\w+) $/.exec(text);
  const cmd = m && COMMANDS.find((c) => c.name === m[1]);
  return cmd?.args ? style.gray(cmd.args) : "";
}

function footer(state: LiveState, cols: number, room: number): string[] {
  if (state.menu.items.length) {
    const items = state.menu.items.slice(0, Math.max(1, room));
    const nameWidth = Math.max(...items.map((c) => c.name.length)) + 2;
    return items.map((c, i) => {
      const chosen = i === state.menu.selected;
      const name = chosen ? style.cyan(style.bold(c.name.padEnd(nameWidth))) : c.name.padEnd(nameWidth);
      return truncate(`${chosen ? style.cyan(" › ") : "   "}${name}${style.gray(c.description)}`, cols - 1);
    });
  }
  const left = state.notice
    ? style.yellow(state.notice)
    : style.gray(state.busySince !== undefined ? "Esc to cancel" : state.question ? "Enter answers" : "/ commands · ↑↓ history · Ctrl-C twice to quit");
  const right = style.gray(`${state.where}${state.usage?.sessionCostUsd ? ` · $${state.usage.sessionCostUsd.toFixed(2)}` : ""}`);
  const gap = cols - 2 - width(left) - width(right); // a space at each end
  return [gap >= 2 ? ` ${left}${" ".repeat(gap)}${right}` : truncate(` ${left}`, cols - 1)];
}

