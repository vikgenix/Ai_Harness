/**
 * Terminal text: colours, and measuring, cutting, padding and wrapping text
 * that contains colour codes and wide characters (CJK, emoji), so panels line
 * up exactly. Only SGR codes (colours and styles) are kept; any other escape
 * sequence in text is removed before it reaches the screen.
 */

export const RESET = "\x1b[0m";
const sgr = (code: string) => (s: string) => `\x1b[${code}m${s}${RESET}`;
export const style = {
  bold: sgr("1"),
  dim: sgr("2"),
  italic: sgr("3"),
  inverse: sgr("7"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  gray: sgr("90"),
  brightRed: sgr("91"),
  brightGreen: sgr("92"),
  brightCyan: sgr("96"),
};

// SGR codes are kept; every other escape sequence (cursor moves, OSC titles...) is dropped.
const SGR = /\x1b\[[0-9;]*m/;
const OTHER_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-ln-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g;

/** Text safe to draw: tabs as spaces, no control characters, colour codes only. */
export function sanitize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(OTHER_ESCAPES, "").replace(CONTROL, "");
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Columns a code point takes: 0 for combining marks, 2 for wide characters, else 1. */
export function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Splits text into colour codes and characters. */
function* tokens(text: string): Generator<{ code: string } | { ch: string; width: number }> {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = SGR.exec(text.slice(i, i + 32));
      if (m && m.index === 0) {
        yield { code: m[0] };
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    yield { ch, width: charWidth(cp) };
    i += ch.length;
  }
}

/** Columns the text takes on screen. */
export function width(text: string): number {
  let w = 0;
  for (const t of tokens(text)) if ("ch" in t) w += t.width;
  return w;
}

/** Cuts text to at most `max` columns, ending in "…" when cut; colours are closed. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (width(text) <= max) return text;
  let out = "";
  let w = 0;
  let coloured = false;
  for (const t of tokens(text)) {
    if ("code" in t) {
      out += t.code;
      coloured = t.code !== RESET;
      continue;
    }
    if (w + t.width > max - 1) break;
    out += t.ch;
    w += t.width;
  }
  return `${out}…${coloured ? RESET : ""}`;
}

/** Pads (or cuts) text to exactly `cols` columns. */
export function fit(text: string, cols: number): string {
  const cut = truncate(text, cols);
  return cut + " ".repeat(Math.max(0, cols - width(cut)));
}

/**
 * Wraps text to `cols` columns: at spaces where possible, else mid-word.
 * Colours carry over to the continuation lines.
 */
export function wrap(text: string, cols: number): string[] {
  if (cols <= 0) return [];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let w = 0;
    let active = ""; // colour codes in effect, to reopen on the next line
    let lastSpace = -1; // position in `line` after the last space, and its width there
    let widthAtSpace = 0;
    const flush = (rest: string) => {
      out.push(line + (active ? RESET : ""));
      line = active + rest;
      w = width(rest);
      lastSpace = -1;
    };
    for (const t of tokens(paragraph)) {
      if ("code" in t) {
        line += t.code;
        active = t.code === RESET ? "" : active + t.code;
        continue;
      }
      if (w + t.width > cols) {
        if (lastSpace > 0 && widthAtSpace > cols / 3) {
          // Break at the last space: the word moves to the next line.
          const rest = line.slice(lastSpace);
          line = line.slice(0, lastSpace).replace(/ +$/, "");
          flush(rest);
        } else flush("");
      }
      line += t.ch;
      w += t.width;
      if (t.ch === " ") {
        lastSpace = line.length;
        widthAtSpace = w;
      }
    }
    out.push(line + (active ? RESET : ""));
  }
  return out;
}
