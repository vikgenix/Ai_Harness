import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { collectChanges } from "../../agent/review.js";
import { formatUsage } from "../../model/cost.js";
import type { ToolCall } from "../../model/types.js";
import { startRepl, type ReplOptions } from "../repl.js";
import type { SessionView, UsageInfo } from "../view.js";
import { RESET, sanitize, style, width, wrap } from "./ansi.js";
import { LineEditor, parseKeys, type Key } from "./keys.js";
import { COMMANDS, diffLines, editPreview, helpLines, INDENT, liveArea, markdownLine, matchingCommands, stageLine, toolLine, toolSummary, type LiveState } from "./render.js";

/**
 * The terminal UI. The conversation is printed into the terminal as it
 * happens, so it scrolls, selects and copies like any program's output;
 * only a few lines at the bottom (what is running, the input box and a
 * footer) are redrawn in place. The interactive session (repl.ts) runs
 * underneath unchanged: the TUI types its input lines and gets everything
 * else through the SessionView.
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

const FRAME_MS = 16;
const TICK_MS = 120;
const QUIT_WINDOW_MS = 2000;
const CANCELLING = "Cancelling...";

const ENTER = "\x1b[?2004h"; // bracketed paste
const LEAVE = "\x1b[?2004l\x1b[?25h";

type Kind = "model" | "info" | "user" | "tool" | "stage";

export async function startTui(opts: TuiOptions): Promise<void> {
  const terminal: TuiTerminal = opts.terminal ?? { stdin: process.stdin, stdout: process.stdout };
  const { stdin, stdout } = terminal;
  const now = opts.now ?? Date.now;
  const cols = () => Math.max(20, stdout.columns || 80); // 0 when the size is unknown
  const rows = () => Math.max(8, stdout.rows || 24);

  const editor = new LineEditor(COMMANDS.map((c) => c.name));
  const running = new Map<string, { call: ToolCall; started: number }>();
  let workdir = opts.workdir ?? process.cwd();
  let branch: string | undefined;
  let sandbox: string | undefined;
  let diffBase: string | undefined;
  let busy = 0;
  let busySince: number | undefined;
  let usage: UsageInfo | undefined;
  let stage: LiveState["stage"];
  let question: string | undefined;
  let notice: string | undefined;
  let menuSelected = 0;
  let interrupt: (() => void) | undefined;
  let quitArmedAt = 0;
  let ended = false;

  // --- printing the conversation -----------------------------------------------------
  /** Finished lines, written above the live area on the next frame. */
  let printed: string[] = [];
  let lastKind: Kind | undefined;
  let lastBlank = true;
  const model = { partial: "", fence: false };
  let infoPartial = "";

  /** Skipped stages, printed together on one line before whatever comes next. */
  let skipped: string[] = [];
  const print = (lines: string[], kind: Kind) => {
    if (skipped.length) {
      const names = skipped;
      skipped = [];
      print(indentWrap(style.gray(`– Skipped: ${names.join(", ")}`)), "stage");
    }
    for (const line of lines) {
      const blank = line.trim() === "";
      if (blank && lastBlank) continue; // one blank line at most
      printed.push(line);
      lastBlank = blank;
    }
    lastKind = kind;
    redraw();
  };
  const blankLine = () => print([""], lastKind ?? "info");
  const indentWrap = (text: string, first = INDENT) => wrap(text, cols() - INDENT.length - 1).map((l, i) => (i === 0 ? first : INDENT) + l);

  /** One finished line of the model's reply; its first line gets the bullet. */
  const modelLine = (raw: string) => {
    const starting = lastKind !== "model";
    if (starting) {
      if (!raw.trim()) return; // no blank lines before the reply
      model.fence = false;
      blankLine();
    }
    print(indentWrap(markdownLine(raw, model), starting ? `${style.magenta("●")} ` : INDENT), "model");
  };
  const flushModel = () => {
    if (model.partial) modelLine(model.partial);
    model.partial = "";
  };
  const infoLine = (raw: string) => print(raw.trim() ? indentWrap(raw) : [""], "info");
  const flushInfo = () => {
    if (infoPartial) infoLine(infoPartial);
    infoPartial = "";
  };
  const flush = () => {
    flushModel();
    flushInfo();
    if (skipped.length) print([], "stage");
  };

  // --- drawing -----------------------------------------------------------------------
  /** The live area as drawn: its lines' widths, the cursor row in it, and the width then. */
  let drawn: { widths: number[]; cursorRow: number; cols: number } | undefined;
  let lastLive = "";
  let pending: NodeJS.Timeout | undefined;

  const liveState = (): LiveState => {
    const items = matchingCommands(editor.text);
    if (menuSelected >= items.length) menuSelected = 0;
    const where = [path.basename(workdir) || workdir, branch, sandbox && `docker ${sandbox}`].filter(Boolean).join(" · ");
    return {
      partial: model.partial,
      running: [...running.values()],
      stage,
      busySince,
      usage,
      question,
      input: { text: editor.text, cursor: editor.cursor },
      menu: { items: items.length === 1 && items[0]!.name === editor.text ? [] : items, selected: menuSelected },
      notice,
      where,
    };
  };

  /** Moves to the top of the live area and clears it (allowing for a terminal that re-wrapped it after a resize). */
  const erase = (): string => {
    if (!drawn) return "";
    const c = cols();
    const rowsOf = (w: number) => (c >= drawn!.cols ? 1 : Math.max(1, Math.ceil(w / c)));
    let up = 0;
    for (let i = 0; i < drawn.cursorRow; i++) up += rowsOf(drawn.widths[i] ?? 0);
    return `\r${up ? `\x1b[${up}A` : ""}\x1b[J`;
  };

  const draw = () => {
    pending = undefined;
    if (ended) return;
    const c = cols();
    const live = liveArea(liveState(), c, rows(), now());
    const key = `${c}\n${live.cursor.row},${live.cursor.col}\n${live.lines.join("\n")}`;
    if (!printed.length && key === lastLive) return; // nothing changed
    let out = `\x1b[?2026h\x1b[?25l${erase()}`;
    for (const line of printed) out += `${line}${line.includes("\x1b") ? RESET : ""}\r\n`;
    printed = [];
    out += live.lines.map((l) => (l.includes("\x1b") ? l + RESET : l)).join("\r\n");
    const up = live.lines.length - 1 - live.cursor.row;
    out += `${up ? `\x1b[${up}A` : ""}\r${live.cursor.col ? `\x1b[${live.cursor.col}C` : ""}\x1b[?25h\x1b[?2026l`;
    stdout.write(out);
    drawn = { widths: live.lines.map(width), cursorRow: live.cursor.row, cols: c };
    lastLive = key;
  };
  const redraw = () => {
    if (!pending && !ended) pending = setTimeout(draw, FRAME_MS);
  };

  // Spinners and timers move while something runs.
  let ticker: NodeJS.Timeout | undefined;
  const tick = () => {
    const active = busy > 0 || running.size > 0;
    if (active && !ticker) ticker = setInterval(redraw, TICK_MS);
    if (!active && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  // --- the session's reports -------------------------------------------------------
  const view: SessionView = {
    text(chunk) {
      flushInfo();
      const parts = (model.partial + sanitize(chunk)).split("\n");
      model.partial = parts.pop()!;
      for (const line of parts) modelLine(line);
      redraw();
    },
    context(info) {
      const moved = info.workdir !== workdir;
      workdir = info.workdir;
      branch = info.branch ?? (moved ? undefined : branch);
      sandbox = info.sandbox;
      if (info.base || moved) diffBase = info.base;
      redraw();
    },
    task() {
      stage = undefined;
    },
    stage(name, state, detail) {
      flushModel();
      flushInfo(); // skipped stages keep gathering
      if (state === "running") stage = { name, detail };
      else if (state === "skipped") {
        if (stage?.name === name) stage = undefined;
        skipped.push(detail && detail !== "off" ? `${name} (${detail})` : name);
      } else {
        if (stage?.name === name) stage = undefined;
        print([stageLine(name, state, detail, cols())], "stage");
      }
      redraw();
    },
    busy(on) {
      busy = Math.max(0, busy + (on ? 1 : -1));
      if (on && busy === 1) busySince = now();
      if (busy === 0) {
        busySince = undefined;
        stage = undefined;
        if (notice === CANCELLING) notice = undefined;
        flush();
      }
      tick();
      redraw();
    },
    toolStarted(call) {
      flush();
      if (toolSummary(call)) running.set(call.id, { call, started: now() });
      tick();
      redraw();
    },
    toolFinished(result, ms) {
      const entry = running.get(result.callId);
      running.delete(result.callId);
      if (entry) {
        const lines = [toolLine(entry.call, result.isError ? "error" : "ok", ms, now(), cols() - 1)];
        if (result.isError) lines.push(...wrap(style.red(result.content.split("\n")[0]!.replace(/^Error:\s*/, "")), cols() - 9).map((l) => `${INDENT}    ${l}`));
        else lines.push(...editPreview(entry.call, cols() - 1));
        print(lines, "tool");
      }
      tick();
    },
    usage(info) {
      usage = info;
      redraw();
    },
    question(text) {
      flush();
      question = text;
      redraw();
    },
    onInterrupt(handler) {
      interrupt = handler;
    },
  };

  // --- what the session prints ---------------------------------------------------------
  const replIn = new PassThrough();
  const replOut = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        flushModel();
        const parts = (infoPartial + sanitize(String(chunk))).split("\n");
        infoPartial = parts.pop()!;
        for (const line of parts) infoLine(line);
        redraw();
        done();
      },
    }),
    { isTTY: true }, // keep the session's dim styling
  );

  /** /diff: the changes since the fix branch started (or uncommitted ones). */
  const showDiff = async () => {
    try {
      const changes = await collectChanges(workdir, { branch: "", base: diffBase ?? "HEAD", baseName: "" });
      if (!changes.files.length) return infoLine("No changes.");
      const added = changes.files.reduce((n, f) => n + f.added, 0);
      const removed = changes.files.reduce((n, f) => n + f.removed, 0);
      infoLine(`${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} changed  ${style.green(`+${added}`)} ${style.red(`-${removed}`)}`);
      print(diffLines(changes.patch, cols() - 1), "info");
    } catch {
      infoLine("No changes to show: this is not a git repository.");
    }
  };

  // --- input -------------------------------------------------------------------------
  const quit = () => {
    if (busy) interrupt?.();
    replIn.end();
  };

  const submit = (line: string) => {
    if (question) {
      print([`${INDENT}${style.yellow("?")} ${question} ${style.bold(line || "(no answer)")}`], "user");
      question = undefined;
      replIn.write(`${line}\n`);
      return;
    }
    if (!line.trim()) return;
    flush();
    blankLine();
    print(indentWrap(style.bold(line), `${style.cyan(style.bold("›"))} `), "user");
    const cmd = line.trim();
    if (cmd === "/help") return print(helpLines().flatMap((l) => indentWrap(l)), "info");
    if (cmd === "/diff") return void showDiff();
    replIn.write(`${line}\n`);
  };

  const onKey = (key: Key) => {
    if (key.name !== "ctrl-c") notice = undefined;
    const menu = liveState().menu;
    switch (key.name) {
      case "ctrl-c":
        if (busy) {
          interrupt?.();
          notice = CANCELLING;
        } else if (editor.text) {
          editor.apply({ name: "ctrl-a" });
          editor.apply({ name: "ctrl-k" });
        } else if (now() - quitArmedAt < QUIT_WINDOW_MS) quit();
        else {
          quitArmedAt = now();
          notice = "Press Ctrl-C again to quit.";
        }
        break;
      case "escape":
        if (busy) {
          interrupt?.();
          notice = CANCELLING;
        } else if (editor.text) {
          editor.apply({ name: "ctrl-a" });
          editor.apply({ name: "ctrl-k" });
        }
        break;
      case "ctrl-d":
        if (!editor.text) quit();
        break;
      case "ctrl-l":
        stdout.write("\x1b[H\x1b[2J");
        drawn = undefined;
        lastLive = "";
        break;
      case "up":
      case "down":
        if (menu.items.length) menuSelected = (menuSelected + (key.name === "up" ? -1 : 1) + menu.items.length) % menu.items.length;
        else editor.apply(key);
        break;
      case "tab":
        if (menu.items.length) {
          const c = menu.items[menuSelected]!;
          editor.text = c.args ? `${c.name} ` : c.name;
          editor.cursor = [...editor.text].length;
        }
        break;
      case "enter": {
        // Enter on a half-typed command runs (or starts) the highlighted one.
        const chosen = menu.items[menuSelected];
        if (chosen && !(chosen.name === editor.text)) {
          editor.text = chosen.name;
          editor.cursor = [...editor.text].length;
          if (chosen.required) {
            editor.apply({ name: "char", ch: " " });
            break;
          }
        }
        menuSelected = 0;
        const line = editor.apply(key);
        if (line !== undefined) submit(line);
        break;
      }
      default:
        editor.apply(key);
        menuSelected = 0;
    }
    redraw();
  };
  const onData = (data: Buffer | string) => {
    for (const key of parseKeys(String(data))) onKey(key);
  };
  const onResize = () => redraw();

  // --- terminal setup and teardown ---------------------------------------------------
  const restore = () => {
    if (ended) return;
    flush();
    // The last lines, without the live area: the conversation stays on screen.
    let out = `${erase()}`;
    for (const line of printed) out += `${line}${line.includes("\x1b") ? RESET : ""}\r\n`;
    printed = [];
    ended = true;
    clearInterval(ticker);
    clearTimeout(pending);
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // the terminal may be gone
    }
    stdin.pause?.();
    stdout.write(out + LEAVE);
  };
  // Whatever ends the process (a crash, process.exit), the terminal is given back.
  process.once("exit", restore);

  stdout.write(ENTER);
  stdin.setRawMode?.(true);
  stdin.setEncoding?.("utf8");
  stdin.on("data", onData);
  stdin.resume?.();
  stdout.on("resize", onResize);
  print([`${style.magenta(style.bold("▲ shrike"))}  ${style.gray(opts.model.model)}`, ...indentWrap(style.gray("Ask about the code, /fix an issue, or /audit for bugs. Type / for all commands.")), ""], "info");

  try {
    await startRepl({ ...opts, input: replIn, output: replOut, view });
  } finally {
    restore();
    process.off("exit", restore);
    const t = opts.tracker;
    if (t.requests) stdout.write(`Shrike: ${t.requests} ${t.requests === 1 ? "request" : "requests"} · ${formatUsage(t.usage, t.pricedCostUsd)}\n`);
  }
}
