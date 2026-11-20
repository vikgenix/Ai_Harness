import { PassThrough, Writable } from "node:stream";
import { collectChanges } from "../../agent/review.js";
import { formatUsage } from "../../model/cost.js";
import { describeCall, startRepl, type ReplOptions } from "../repl.js";
import type { SessionView } from "../view.js";
import { sanitize, style } from "./ansi.js";
import { LineEditor, parseKeys, type Key } from "./keys.js";
import { render, type Frame, type ScreenState, type ToolEntry } from "./layout.js";

/**
 * The full-screen terminal UI. The interactive session (repl.ts) runs
 * underneath unchanged: the TUI types its input lines, shows what it prints
 * in the Activity panel, and gets the rest (task, stages, tool calls, usage)
 * through the SessionView. It draws on the alternate screen, rewriting only
 * the rows that changed, and always gives the terminal back as it found it.
 */

/** What the TUI needs of a terminal (process.stdin/stdout, or fakes in tests). */
export interface TuiTerminal {
  stdin: NodeJS.EventEmitter & { setRawMode?(on: boolean): unknown; resume?(): unknown; pause?(): unknown; setEncoding?(e: BufferEncoding): unknown };
  stdout: NodeJS.EventEmitter & { write(s: string): boolean; columns?: number; rows?: number };
}

export interface TuiOptions extends Omit<ReplOptions, "input" | "output" | "view"> {
  terminal?: TuiTerminal;
  /** For tests: the clock. */
  now?: () => number;
}

export const COMMANDS = ["/repo", "/fix", "/pr", "/audit", "/map", "/project", "/cost", "/clear", "/config", "/help", "/exit"];
/** Activity text kept; older text is dropped. */
const MAX_ACTIVITY_CHARS = 400_000;
const TICK_MS = 100;
const DIFF_DELAY_MS = 250;
const QUIT_WINDOW_MS = 2000;
/** Tools after which the files may have changed. */
const CHANGES_FILES = new Set(["edit_file", "create_file", "bash"]);

const ENTER = "\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[H\x1b[2J"; // alternate screen, no auto-wrap, bracketed paste
const LEAVE = "\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l";

export async function startTui(opts: TuiOptions): Promise<void> {
  const terminal: TuiTerminal = opts.terminal ?? { stdin: process.stdin, stdout: process.stdout };
  const { stdin, stdout } = terminal;
  const now = opts.now ?? Date.now;

  const state: ScreenState = {
    model: opts.model.model,
    workdir: opts.workdir ?? process.cwd(),
    stages: [],
    entries: [],
    input: { text: "", cursor: 0, suggestions: [] },
    activityScroll: 0,
    diffScroll: 0,
  };
  const editor = new LineEditor(COMMANDS);
  const tools = new Map<string, ToolEntry>();
  let busy = 0;
  let interrupt: (() => void) | undefined;
  let diffBase: string | undefined;
  let quitArmedAt = 0;
  let ended = false;

  // --- drawing ---------------------------------------------------------------------
  let prev: string[] = [];
  let prevSize = "";
  let lastFrame: Frame | undefined;
  let pending: NodeJS.Timeout | undefined;
  const draw = () => {
    pending = undefined;
    if (ended) return;
    const cols = stdout.columns || 80; // 0 when the size is unknown
    const rows = stdout.rows || 24;
    const frame = render(state, cols, rows, now());
    lastFrame = frame;
    let out = "\x1b[?2026h\x1b[?25l"; // synchronized update: no flicker
    if (prevSize !== `${cols}x${rows}`) {
      out += "\x1b[H\x1b[2J";
      prev = [];
      prevSize = `${cols}x${rows}`;
    }
    frame.lines.forEach((line, i) => {
      if (prev[i] !== line) out += `\x1b[${i + 1};1H${line}`;
    });
    out += `\x1b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\x1b[?25h\x1b[?2026l`;
    stdout.write(out);
    prev = frame.lines;
  };
  const redraw = () => {
    if (!pending && !ended) pending = setTimeout(draw, 16);
  };

  // Spinners and timers move while something runs.
  let ticker: NodeJS.Timeout | undefined;
  const tick = () => {
    const active = busy > 0 || [...tools.values()].some((t) => t.status === "running");
    if (active && !ticker) ticker = setInterval(redraw, TICK_MS);
    if (!active && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  // --- activity --------------------------------------------------------------------
  const append = (text: string) => {
    const clean = sanitize(text);
    if (!clean) return;
    const last = state.entries.at(-1);
    if (last?.kind === "text") state.entries[state.entries.length - 1] = { kind: "text", text: last.text + clean };
    else state.entries.push({ kind: "text", text: clean });
    let total = state.entries.reduce((n, e) => n + (e.kind === "text" ? e.text.length : 80), 0);
    while (total > MAX_ACTIVITY_CHARS && state.entries.length > 1) {
      const dropped = state.entries.shift()!;
      total -= dropped.kind === "text" ? dropped.text.length : 80;
    }
    redraw();
  };

  // --- diff --------------------------------------------------------------------------
  let diffTimer: NodeJS.Timeout | undefined;
  let diffRun = 0;
  const refreshDiff = () => {
    clearTimeout(diffTimer);
    diffTimer = setTimeout(async () => {
      const run = ++diffRun;
      try {
        const changes = await collectChanges(state.workdir, { branch: "", base: diffBase ?? "HEAD", baseName: "" });
        if (run !== diffRun) return;
        state.diff = changes.files.length ? { files: changes.files, patch: changes.patch } : undefined;
      } catch {
        if (run === diffRun) state.diff = undefined; // not a git repository
      }
      redraw();
    }, DIFF_DELAY_MS);
  };

  // --- the session's reports -------------------------------------------------------
  const view: SessionView = {
    context(info) {
      const moved = info.workdir !== state.workdir;
      state.workdir = info.workdir;
      state.branch = info.branch ?? (moved ? undefined : state.branch);
      state.sandbox = info.sandbox;
      if (info.base || moved) diffBase = info.base;
      refreshDiff();
      redraw();
    },
    task(info) {
      state.task = info;
      state.stages = [];
      redraw();
    },
    stage(name, stageState, detail) {
      const existing = state.stages.find((s) => s.name === name);
      if (existing) Object.assign(existing, { state: stageState, detail });
      else state.stages.push({ name, state: stageState, detail });
      if (name === "Commit") refreshDiff();
      tick();
      redraw();
    },
    busy(on) {
      busy = Math.max(0, busy + (on ? 1 : -1));
      if (on && busy === 1) state.busySince = now();
      if (busy === 0) state.busySince = undefined;
      tick();
      redraw();
    },
    toolStarted(call) {
      const entry: ToolEntry = { kind: "tool", id: call.id, label: describeCall(call), status: "running", started: now() };
      tools.set(call.id, entry);
      state.entries.push(entry);
      tick();
      redraw();
    },
    toolFinished(result, ms) {
      const entry = tools.get(result.callId);
      if (entry) {
        entry.status = result.isError ? "error" : "ok";
        entry.ms = ms;
        if (result.isError) entry.error = result.content.split("\n")[0]!.replace(/^Error:\s*/, "");
        tools.delete(result.callId);
      }
      if (CHANGES_FILES.has(result.name)) refreshDiff();
      tick();
      redraw();
    },
    usage(info) {
      state.usage = info;
      redraw();
    },
    question(text) {
      state.question = text;
      append(`\n${style.yellow(style.bold(`? ${text}`))}\n`);
    },
    onInterrupt(handler) {
      interrupt = handler;
    },
  };

  // --- input -------------------------------------------------------------------------
  const replIn = new PassThrough();
  const replOut = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        append(String(chunk));
        done();
      },
    }),
    { isTTY: true }, // keep the session's dim styling
  );

  const quit = () => {
    if (busy) interrupt?.();
    replIn.end();
  };

  const onKey = (key: Key) => {
    if (key.name !== "ctrl-c") state.notice = undefined;
    switch (key.name) {
      case "ctrl-c":
        if (busy) {
          interrupt?.();
          state.notice = "Cancelling...";
        } else if (state.input.text) {
          editor.apply({ name: "ctrl-a" });
          editor.apply({ name: "ctrl-k" });
        } else if (now() - quitArmedAt < QUIT_WINDOW_MS) quit();
        else {
          quitArmedAt = now();
          state.notice = "Press Ctrl-C again to quit.";
        }
        break;
      case "ctrl-d":
        if (!state.input.text) quit();
        break;
      case "pageup":
        state.activityScroll += Math.max(1, (lastFrame?.activityRows ?? 10) - 1);
        state.activityScroll = Math.min(state.activityScroll, Math.max(0, (lastFrame?.activityLines ?? 0) - (lastFrame?.activityRows ?? 0)));
        break;
      case "pagedown":
        state.activityScroll = Math.max(0, state.activityScroll - Math.max(1, (lastFrame?.activityRows ?? 10) - 1));
        break;
      case "ctrl-up":
        state.diffScroll = Math.max(0, state.diffScroll - Math.max(1, Math.floor((lastFrame?.diffRows ?? 6) / 2)));
        break;
      case "ctrl-down":
        state.diffScroll = Math.min(state.diffScroll + Math.max(1, Math.floor((lastFrame?.diffRows ?? 6) / 2)), Math.max(0, (lastFrame?.diffLines ?? 0) - (lastFrame?.diffRows ?? 0)));
        break;
      case "ctrl-l":
        prevSize = ""; // full redraw
        break;
      case "escape":
        state.activityScroll = 0;
        break;
      default: {
        const line = editor.apply(key);
        if (line !== undefined) {
          if (state.question) append(`${style.bold(line || "(no answer)")}\n`);
          else if (line.trim()) append(`\n${style.cyan(style.bold(`› ${line}`))}\n`);
          state.question = undefined;
          state.activityScroll = 0;
          replIn.write(`${line}\n`);
        }
      }
    }
    state.input = { text: editor.text, cursor: editor.cursor, suggestions: editor.suggestions() };
    redraw();
  };
  const onData = (data: Buffer | string) => {
    for (const key of parseKeys(String(data))) onKey(key);
  };
  const onResize = () => redraw();

  // --- terminal setup and teardown ---------------------------------------------------
  const restore = () => {
    if (ended) return;
    ended = true;
    clearInterval(ticker);
    clearTimeout(pending);
    clearTimeout(diffTimer);
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // the terminal may be gone
    }
    stdin.pause?.();
    stdout.write(LEAVE);
  };
  // Whatever ends the process (a crash, process.exit), the terminal is given back.
  process.once("exit", restore);

  stdout.write(ENTER);
  stdin.setRawMode?.(true);
  stdin.setEncoding?.("utf8");
  stdin.on("data", onData);
  stdin.resume?.();
  stdout.on("resize", onResize);
  redraw();

  try {
    await startRepl({ ...opts, input: replIn, output: replOut, view });
  } finally {
    restore();
    process.off("exit", restore);
    const t = opts.tracker;
    if (t.requests) stdout.write(`Shrike: ${t.requests} ${t.requests === 1 ? "request" : "requests"} · ${formatUsage(t.usage, t.pricedCostUsd)}\n`);
  }
}
