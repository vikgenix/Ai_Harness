import { EventEmitter } from "node:events";
import { charWidth } from "../../../src/ui/tui/ansi.js";
import type { TuiTerminal } from "../../../src/ui/tui/tui.js";

/**
 * A pretend terminal for TUI tests: stdout replays cursor moves, clears and
 * text onto a grid of characters (colours ignored), and stdin takes keys.
 */
export function fakeTerminal(cols: number, rows: number) {
  const grid = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
  let row = 0;
  let col = 0;
  const raw: boolean[] = [];
  let written = "";
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    write(s: string) {
      written += s;
      let i = 0;
      while (i < s.length) {
        if (s[i] === "\x1b") {
          const m = /^\x1b\[([?0-9;]*)([A-Za-z~])/.exec(s.slice(i));
          if (m) {
            if (m[2] === "H") {
              const [r, c] = (m[1] || "1;1").split(";").map(Number);
              row = (r || 1) - 1;
              col = (c || 1) - 1;
            }
            if (m[2] === "J" && m[1] === "2") for (const line of grid) line.fill(" ");
            i += m[0].length;
            continue;
          }
          i++;
          continue;
        }
        if (s[i] === "\n") {
          row++;
          col = 0;
          i++;
          continue;
        }
        const cp = s.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        const w = charWidth(cp);
        if (row < rows && col < cols) {
          grid[row]![col] = ch;
          if (w === 2 && col + 1 < cols) grid[row]![col + 1] = "";
        }
        col += w;
        i += ch.length;
      }
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    setRawMode: (on: boolean) => raw.push(on),
    resume: () => undefined,
    pause: () => undefined,
    setEncoding: () => undefined,
  });
  const terminal: TuiTerminal = { stdin, stdout };
  return {
    terminal,
    /** Keys, as the terminal would send them. */
    type: (keys: string) => stdin.emit("data", keys),
    /** The screen as text, one string per row. */
    screen: () => grid.map((line) => line.join("")),
    text: () => grid.map((line) => line.join("")).join("\n"),
    /** Everything written, escape codes included. */
    written: () => written,
    raw,
    resize(c: number, r: number) {
      stdout.columns = c;
      stdout.rows = r;
      grid.length = 0;
      for (let i = 0; i < r; i++) grid.push(Array<string>(c).fill(" "));
      stdout.emit("resize");
    },
  };
}

/** Waits until `check` passes (polling), or fails with the last error. */
export async function eventually(check: () => void, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
