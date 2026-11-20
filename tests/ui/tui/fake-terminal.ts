import { EventEmitter } from "node:events";
import { charWidth } from "../../../src/ui/tui/ansi.js";
import type { TuiTerminal } from "../../../src/ui/tui/tui.js";

/**
 * A pretend terminal for TUI tests: stdout replays text, cursor moves and
 * clears onto a grid of characters (colours ignored), lines scrolled off the
 * top go to the scrollback, and stdin takes keys.
 */
export function fakeTerminal(cols: number, rows: number) {
  const blankRow = () => Array<string>(cols).fill(" ");
  let grid = Array.from({ length: rows }, blankRow);
  const scrollback: string[] = [];
  let row = 0;
  let col = 0;
  let pendingWrap = false;
  const raw: boolean[] = [];
  let written = "";

  const newline = () => {
    row++;
    if (row >= rows) {
      scrollback.push(grid.shift()!.join(""));
      grid.push(blankRow());
      row = rows - 1;
    }
  };

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
            const [params, cmd] = [m[1]!, m[2]!];
            const n = Number(params) || 1;
            if (!params.startsWith("?")) {
              if (cmd === "H") {
                const [r, c] = (params || "1;1").split(";").map(Number);
                row = (r || 1) - 1;
                col = (c || 1) - 1;
              } else if (cmd === "A") row = Math.max(0, row - n);
              else if (cmd === "B") row = Math.min(rows - 1, row + n);
              else if (cmd === "C") col = Math.min(cols - 1, col + n);
              else if (cmd === "G") col = n - 1;
              else if (cmd === "J" && params === "2") grid = Array.from({ length: rows }, blankRow);
              else if (cmd === "J") {
                grid[row]!.fill(" ", col);
                for (let r = row + 1; r < rows; r++) grid[r] = blankRow();
              } else if (cmd === "K") grid[row]!.fill(" ", col);
              pendingWrap = false;
            }
            i += m[0].length;
            continue;
          }
          i++;
          continue;
        }
        if (s[i] === "\r") {
          col = 0;
          pendingWrap = false;
          i++;
          continue;
        }
        if (s[i] === "\n") {
          newline();
          pendingWrap = false;
          i++;
          continue;
        }
        const cp = s.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        const w = charWidth(cp);
        if (pendingWrap || col + w > cols) {
          // Auto-wrap, as a terminal does when text runs past the last column.
          newline();
          col = 0;
          pendingWrap = false;
        }
        grid[row]![col] = ch;
        if (w === 2 && col + 1 < cols) grid[row]![col + 1] = "";
        col += w;
        if (col >= cols) {
          col = cols - 1;
          pendingWrap = true;
        }
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
  const screen = () => grid.map((line) => line.join(""));
  return {
    terminal,
    /** Keys, as the terminal would send them. */
    type: (keys: string) => stdin.emit("data", keys),
    /** The visible screen, one string per row. */
    screen,
    /** Scrollback and screen, as text. */
    text: () => [...scrollback, ...screen()].join("\n"),
    /** Everything written, escape codes included. */
    written: () => written,
    /** Where the cursor is (0-based). */
    cursor: () => ({ row, col }),
    raw,
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
