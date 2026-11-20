import { describe, expect, it } from "vitest";
import { fit, RESET, sanitize, stripAnsi, style, truncate, width, wrap } from "../../../src/ui/tui/ansi.js";

describe("width", () => {
  it("counts columns: colour codes take none, wide characters two, combining marks none", () => {
    expect(width(style.red("abc"))).toBe(3);
    expect(width("日本語")).toBe(6);
    expect(width("é")).toBe(1);
    expect(width("🙂 ok")).toBe(5);
  });
});

describe("truncate and fit", () => {
  it("cuts to the width with an ellipsis and closes colours", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("short", 8)).toBe("short");
    expect(truncate(style.green("hello world"), 6)).toBe(`\x1b[32mhello…${RESET}`);
    expect(truncate("日本語です", 5)).toBe("日本…");
    expect(width(truncate("日本語です", 5))).toBeLessThanOrEqual(5);
  });

  it("pads to exactly the width", () => {
    expect(fit("ab", 5)).toBe("ab   ");
    expect(width(fit(style.bold("a long text that is cut"), 10))).toBe(10);
  });
});

describe("wrap", () => {
  it("wraps at spaces, and mid-word when a word is too long", () => {
    expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
    expect(wrap("abcdefghijklmnop", 6)).toEqual(["abcdef", "ghijkl", "mnop"]);
    expect(wrap("one\n\ntwo", 10)).toEqual(["one", "", "two"]);
  });

  it("carries colours over to the next line", () => {
    const lines = wrap(style.red("red text that wraps"), 9);
    expect(lines.map(stripAnsi)).toEqual(["red text", "that", "wraps"]);
    expect(lines[1]).toBe(`\x1b[31mthat${RESET}`);
  });
});

describe("sanitize", () => {
  it("keeps colours, and drops cursor moves, titles and control characters", () => {
    expect(sanitize(`a\x1b[2J\x1b[10;5Hb\x1b]0;title\x07c${style.green("d")}\x07\x00e\tf\r\n`)).toBe(`abc${style.green("d")}e    f\n`);
  });
});
