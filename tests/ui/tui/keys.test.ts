import { describe, expect, it } from "vitest";
import { LineEditor, parseKeys, type Key } from "../../../src/ui/tui/keys.js";

describe("parseKeys", () => {
  it("reads characters, control keys and escape sequences", () => {
    expect(parseKeys("a\x1b[A\x1b[5~\x1b[1;5B\r\x7f\x03\t").map((k) => k.name)).toEqual(["char", "up", "pageup", "ctrl-down", "enter", "backspace", "ctrl-c", "tab"]);
    expect(parseKeys("日本")).toEqual([
      { name: "char", ch: "日" },
      { name: "char", ch: "本" },
    ]);
  });

  it("keeps a bracketed paste together, and skips unknown sequences", () => {
    expect(parseKeys("\x1b[200~line one\nline two\x1b[201~x")).toEqual([{ name: "paste", text: "line one\nline two" }, { name: "char", ch: "x" }]);
    expect(parseKeys("\x1b[15~a")).toEqual([{ name: "char", ch: "a" }]); // F5
    expect(parseKeys("\x1b")).toEqual([{ name: "escape" }]);
  });

  it("reads the mouse wheel, and drops clicks so they never reach the input line", () => {
    expect(parseKeys("\x1b[<64;10;5M\x1b[<65;3;20M\x1b[<80;1;1M")).toEqual([
      { name: "wheel", delta: -1, row: 4, col: 9 },
      { name: "wheel", delta: 1, row: 19, col: 2 },
      { name: "wheel", delta: -1, row: 0, col: 0 }, // with Ctrl held
    ]);
    expect(parseKeys("\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<32;11;5M\x1b[<66;1;1Ma")).toEqual([{ name: "char", ch: "a" }]); // click, release, drag, sideways wheel
    expect(parseKeys(`\x1b[M${String.fromCharCode(96, 42, 37)}`)).toEqual([{ name: "wheel", delta: -1, row: 4, col: 9 }]); // terminals without SGR
    expect(parseKeys("\x1b[1;2A\x1b[1;2B").map((k) => k.name)).toEqual(["shift-up", "shift-down"]);
  });
});

describe("LineEditor", () => {
  const typed = (editor: LineEditor, text: string) => parseKeys(text).map((k) => editor.apply(k)).filter((r) => r !== undefined);

  it("edits: insert, move, delete words and lines", () => {
    const e = new LineEditor();
    typed(e, "hello world");
    expect(e.cursor).toBe(11);
    e.apply({ name: "word-left" });
    typed(e, "big ");
    expect(e.text).toBe("hello big world");
    e.apply({ name: "end" });
    e.apply({ name: "ctrl-w" });
    expect(e.text).toBe("hello big ");
    e.apply({ name: "home" });
    e.apply({ name: "delete" });
    expect(e.text).toBe("ello big ");
    e.apply({ name: "ctrl-k" });
    expect(e.text).toBe("");
  });

  it("turns a paste into one line", () => {
    const e = new LineEditor();
    e.apply({ name: "paste", text: "a\nb\r\nc" });
    expect(e.text).toBe("a b c");
  });

  it("submits with Enter and remembers the history, keeping the draft", () => {
    const e = new LineEditor();
    expect(typed(e, "first\rsecond\r")).toEqual(["first", "second"]);
    typed(e, "draft");
    const keys = (names: Key["name"][]) => names.forEach((name) => e.apply({ name } as Key));
    keys(["up"]);
    expect(e.text).toBe("second");
    keys(["up", "up"]);
    expect(e.text).toBe("first");
    keys(["down", "down"]);
    expect(e.text).toBe("draft");
  });

  it("completes slash commands with Tab and suggests the matches", () => {
    const e = new LineEditor(["/fix", "/project", "/pr", "/repo"]);
    typed(e, "/p");
    expect(e.suggestions()).toEqual(["/project", "/pr"]);
    e.apply({ name: "tab" });
    expect(e.text).toBe("/pr"); // the start both share
    typed(e, "o");
    e.apply({ name: "tab" });
    expect(e.text).toBe("/project ");
    expect(e.suggestions()).toEqual([]);
  });
});
