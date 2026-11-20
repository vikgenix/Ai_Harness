/**
 * Keyboard input in raw mode: turns the bytes a terminal sends into keys,
 * and a one-line editor with history and slash-command completion.
 */

export type Key =
  | { name: "char"; ch: string }
  | { name: "paste"; text: string }
  | {
      name:
        | "enter"
        | "backspace"
        | "delete"
        | "tab"
        | "escape"
        | "up"
        | "down"
        | "left"
        | "right"
        | "home"
        | "end"
        | "pageup"
        | "pagedown"
        | "ctrl-up"
        | "ctrl-down"
        | "word-left"
        | "word-right"
        | "ctrl-a"
        | "ctrl-c"
        | "ctrl-d"
        | "ctrl-e"
        | "ctrl-k"
        | "ctrl-l"
        | "ctrl-u"
        | "ctrl-w";
    };

/** Keys that are just a name (not a typed character or a paste). */
type NamedKey = Exclude<Key, { name: "char" } | { name: "paste" }>["name"];

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const SEQUENCES: Record<string, NamedKey> = {
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x1bOH": "home",
  "\x1bOF": "end",
  "\x1b[1~": "home",
  "\x1b[4~": "end",
  "\x1b[7~": "home",
  "\x1b[8~": "end",
  "\x1b[3~": "delete",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
  "\x1b[1;5A": "ctrl-up",
  "\x1b[1;5B": "ctrl-down",
  "\x1b[1;3A": "ctrl-up", // Alt-Up
  "\x1b[1;3B": "ctrl-down",
  "\x1b[1;5C": "word-right",
  "\x1b[1;5D": "word-left",
  "\x1b[1;3C": "word-right",
  "\x1b[1;3D": "word-left",
  "\x1bf": "word-right",
  "\x1bb": "word-left",
};
const CONTROLS: Record<string, NamedKey> = {
  "\r": "enter",
  "\n": "enter",
  "\x7f": "backspace",
  "\b": "backspace",
  "\t": "tab",
  "\x01": "ctrl-a",
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x05": "ctrl-e",
  "\x0b": "ctrl-k",
  "\x0c": "ctrl-l",
  "\x15": "ctrl-u",
  "\x17": "ctrl-w",
};

/** Keys in a chunk of terminal input. Unknown escape sequences are skipped. */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i);
      const text = data.slice(i + PASTE_START.length, end === -1 ? undefined : end);
      keys.push({ name: "paste", text });
      i = end === -1 ? data.length : end + PASTE_END.length;
      continue;
    }
    if (data[i] === "\x1b") {
      const seq = Object.keys(SEQUENCES)
        .filter((s) => data.startsWith(s, i))
        .sort((a, b) => b.length - a.length)[0];
      if (seq) {
        keys.push({ name: SEQUENCES[seq]! });
        i += seq.length;
        continue;
      }
      const other = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(data.slice(i));
      if (other) {
        i += other[0].length; // a key this editor does not use
        continue;
      }
      keys.push({ name: "escape" });
      i++;
      continue;
    }
    const control = CONTROLS[data[i]!];
    if (control) {
      keys.push({ name: control });
      i += data[i] === "\r" && data[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    const cp = data.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (cp >= 0x20) keys.push({ name: "char", ch });
    i += ch.length;
  }
  return keys;
}

/** The input line: editing, history (up/down) and Tab completion of slash commands. */
export class LineEditor {
  text = "";
  /** Cursor position, in characters of `text`. */
  cursor = 0;
  private history: string[] = [];
  private historyAt = 0;
  private draft = "";

  constructor(private readonly commands: string[] = []) {}

  /** Applies a key. Returns the line when Enter submits it. */
  apply(key: Key): string | undefined {
    const chars = [...this.text];
    const set = (next: string[], cursor: number) => {
      this.text = next.join("");
      this.cursor = Math.max(0, Math.min(cursor, next.length));
    };
    switch (key.name) {
      case "char":
        chars.splice(this.cursor, 0, key.ch);
        set(chars, this.cursor + 1);
        break;
      case "paste": {
        const pasted = [...key.text.replace(/\r?\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "")];
        chars.splice(this.cursor, 0, ...pasted);
        set(chars, this.cursor + pasted.length);
        break;
      }
      case "backspace":
        if (this.cursor > 0) {
          chars.splice(this.cursor - 1, 1);
          set(chars, this.cursor - 1);
        }
        break;
      case "delete":
        chars.splice(this.cursor, 1);
        set(chars, this.cursor);
        break;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "right":
        this.cursor = Math.min(chars.length, this.cursor + 1);
        break;
      case "home":
      case "ctrl-a":
        this.cursor = 0;
        break;
      case "end":
      case "ctrl-e":
        this.cursor = chars.length;
        break;
      case "word-left": {
        let c = this.cursor;
        while (c > 0 && chars[c - 1] === " ") c--;
        while (c > 0 && chars[c - 1] !== " ") c--;
        this.cursor = c;
        break;
      }
      case "word-right": {
        let c = this.cursor;
        while (c < chars.length && chars[c] === " ") c++;
        while (c < chars.length && chars[c] !== " ") c++;
        this.cursor = c;
        break;
      }
      case "ctrl-u":
        set(chars.slice(this.cursor), 0);
        break;
      case "ctrl-k":
        set(chars.slice(0, this.cursor), this.cursor);
        break;
      case "ctrl-w": {
        let c = this.cursor;
        while (c > 0 && chars[c - 1] === " ") c--;
        while (c > 0 && chars[c - 1] !== " ") c--;
        set([...chars.slice(0, c), ...chars.slice(this.cursor)], c);
        break;
      }
      case "up":
        if (this.historyAt > 0) {
          if (this.historyAt === this.history.length) this.draft = this.text;
          this.historyAt--;
          this.text = this.history[this.historyAt]!;
          this.cursor = [...this.text].length;
        }
        break;
      case "down":
        if (this.historyAt < this.history.length) {
          this.historyAt++;
          this.text = this.historyAt === this.history.length ? this.draft : this.history[this.historyAt]!;
          this.cursor = [...this.text].length;
        }
        break;
      case "tab":
        this.complete();
        break;
      case "enter": {
        const line = this.text;
        if (line.trim() && this.history.at(-1) !== line) this.history.push(line);
        this.historyAt = this.history.length;
        this.text = "";
        this.cursor = 0;
        this.draft = "";
        return line;
      }
      default:
    }
    return undefined;
  }

  /** Completes a slash command: the whole name when one matches, else the longest shared start. */
  private complete(): void {
    if (!this.text.startsWith("/") || this.text.includes(" ")) return;
    const matches = this.commands.filter((c) => c.startsWith(this.text));
    if (!matches.length) return;
    let shared = matches[0]!;
    for (const m of matches) while (!m.startsWith(shared)) shared = shared.slice(0, -1);
    this.text = matches.length === 1 ? `${matches[0]} ` : shared;
    this.cursor = [...this.text].length;
  }

  /** Commands that match what is typed, for a hint while typing a slash command. */
  suggestions(): string[] {
    if (!this.text.startsWith("/") || this.text.includes(" ")) return [];
    return this.commands.filter((c) => c.startsWith(this.text) && c !== this.text);
  }
}
