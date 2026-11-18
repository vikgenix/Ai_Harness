import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRepoMap, describeRepoMap, extractSymbols, languageOf, repoMapFor, withRepoMap, type RepoMap } from "../../src/repo/map.js";

/** Symbols as "line: indent header" lines, easy to compare. */
async function symbols(source: string, language: string): Promise<string[]> {
  return (await extractSymbols(source, language)).map((s) => `${s.line}: ${"  ".repeat(s.depth)}${s.header}`);
}

describe("extractSymbols", () => {
  it("python: classes with their methods, one line per signature, overloads collapsed", async () => {
    const source = [
      "import typing as t",
      "",
      "class Greeter(Base):",
      '    """Says hello."""',
      "    @property",
      "    def name(self) -> str:",
      "        def inner(): pass",
      "        return 'x'",
      "",
      "    def greet(",
      "        self,",
      "        who: str,",
      "    ) -> str:",
      "        return who",
      "",
      "@t.overload",
      "def parse(x: int) -> int: ...",
      "@t.overload",
      "def parse(x: str) -> str: ...",
      "def parse(x):",
      "    return x",
      "",
      "LIMIT = 3",
      "",
    ].join("\n");
    expect(await symbols(source, "python")).toEqual([
      "3: class Greeter(Base)",
      "6:   def name(self) -> str",
      "10:   def greet(self, who: str) -> str",
      "20: def parse(x)",
    ]);
  });

  it("typescript: classes, methods, interfaces, types and functions in constants", async () => {
    const source = [
      "export class Store<T> extends Base {",
      "  private items: T[] = [];",
      "  constructor(private readonly name: string) { super(); }",
      "  add(item: T): void { this.items.push(item); }",
      "}",
      "export interface Options { size: number }",
      "type Id = string;",
      "export function open(path: string): Store<string> { return new Store(path); }",
      "export const close = async (s: Store<string>): Promise<void> => { await s.flush(); };",
      "const LIMIT = 10;",
      "const helper = function (x: number) { return x * 2; };",
      "describe('x', () => { function nested() {} });",
    ].join("\n");
    expect(await symbols(source, "typescript")).toEqual([
      "1: class Store<T> extends Base",
      "3:   constructor(private readonly name: string)",
      "4:   add(item: T): void",
      "6: interface Options",
      "7: type Id = string",
      "8: function open(path: string): Store<string>",
      "9: close = async (s: Store<string>): Promise<void> =>",
      "11: helper = function (x: number)",
    ]);
  });

  it.each([
    ["go", "package main\ntype Server struct {\n\tAddr string\n}\nfunc (s *Server) Start(port int) error {\n\treturn nil\n}\nfunc main() {}\n", ["2: type Server struct", "5: func (s *Server) Start(port int) error", "8: func main()"]],
    ["rust", "pub struct S { a: i32 }\nimpl Display for S {\n    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }\n}\nfn main() {}\n", ["1: pub struct S", "2: impl Display for S", "3:   fn fmt(&self, f: &mut Formatter) -> Result", "5: fn main()"]],
    ["java", "public class A extends B {\n  private int x;\n  public A(int x) { this.x = x; }\n  public int get() { return x; }\n}\n", ["1: public class A extends B", "3:   public A(int x)", "4:   public int get()"]],
    ["ruby", "module M\n  class A < B\n    def initialize(x)\n      @x = x\n    end\n  end\nend\n", ["1: module M", "2:   class A < B", "3:     def initialize(x)"]],
    ["csharp", "namespace N {\n  public class A : B {\n    public int Get(int y) { return y; }\n  }\n}\n", ["1: namespace N", "2:   public class A : B", "3:     public int Get(int y)"]],
    ["php", "<?php\nclass A extends B {\n  public function get(int $x): int { return $x; }\n}\nfunction top($a) {}\n", ["2: class A extends B", "3:   public function get(int $x): int", "5: function top($a)"]],
    ["cpp", "#include <x>\nint add(int a, int b);\nclass A {\n public:\n  int get() const;\n};\nstatic int helper(void) { return 0; }\n", ["2: int add(int a, int b)", "3: class A", "5:   int get() const", "7: static int helper(void)"]],
  ])("%s", async (language, source, expected) => {
    expect(await symbols(source, language)).toEqual(expected);
  });

  it("knows languages by extension", () => {
    expect(languageOf("src/a.PY")).toBe("python");
    expect(languageOf("lib/x.h")).toBe("cpp");
    expect(languageOf("README.md")).toBeUndefined();
  });
});

describe("buildRepoMap", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-map-"));
    const files: Record<string, string> = {
      "README.md": "# demo\n",
      "pyproject.toml": "[project]\nname = 'demo'\n",
      "src/demo/__init__.py": "",
      "src/demo/billing.py": "class Invoice:\n    def total(self):\n        return 0\n\ndef refund_invoice(invoice):\n    pass\n",
      "src/demo/users.py": "class User:\n    def rename(self, name):\n        pass\n",
      "src/demo/big.py": `class Big:\n${Array.from({ length: 80 }, (_, i) => `    def method_${i}(self):\n        pass\n`).join("")}`,
      "tests/test_billing.py": "def test_total():\n    pass\n",
      "assets/logo.png": "\0PNG",
      "ignored/out.py": "def secret(): pass\n",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    await writeFile(path.join(root, ".gitignore"), "ignored/\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("shows source files with symbols and line numbers, then the other files", async () => {
    const map = await buildRepoMap(root, { maxChars: 20_000 });
    expect(map.text).toContain("src/demo/billing.py:\n  1: class Invoice\n  2:   def total(self)\n  5: def refund_invoice(invoice)");
    expect(map.text).toContain("tests/test_billing.py:\n  1: def test_total()");
    expect(map.text).toMatch(/Other files:\n {2}\.\/: \.gitignore, README\.md, pyproject\.toml\n {2}assets\/: logo\.png\n {2}src\/demo\/: __init__\.py/);
    expect(map.text).not.toContain("secret"); // git-ignored
    expect(map).toMatchObject({ files: 9, detailedFiles: 4, omittedFiles: 0 });
  });

  it("details the files that match the task when only one fits", async () => {
    const billing = await buildRepoMap(root, { query: "Refunds of an invoice are wrong in refund_invoice", maxChars: 300 });
    expect(billing.text).toContain("src/demo/billing.py:\n");
    expect(billing.text).not.toContain("class User");
    expect(billing.text.length).toBeLessThanOrEqual(300);

    const users = await buildRepoMap(root, { query: "Renaming a user fails", maxChars: 300 });
    expect(users.text).toContain("src/demo/users.py:\n  1: class User\n  2:   def rename(self, name)");
    expect(users.text).not.toContain("class Invoice");
  });

  it("shrinks big files instead of dropping them", async () => {
    const map = await buildRepoMap(root, { maxChars: 700 });
    expect(map.text).toMatch(/src\/demo\/big\.py:\n(.*\n){6,15} {2}… \d+ more\n/);
    expect(map.detailedFiles).toBe(4);
  });

  it("keeps the methods the task names in a big file, with their class", async () => {
    const map = await buildRepoMap(root, { query: "method_77 returns the wrong value", maxChars: 20_000 });
    const block = map.text.slice(map.text.indexOf("src/demo/big.py:"));
    expect(block).toMatch(/^src\/demo\/big\.py:\n {2}\s*1: class Big\n/);
    expect(block).toContain("def method_77(self)");
    expect(block).toContain("… 41 more"); // 81 symbols, 40 shown
  });

  it("says how many files are left out when even the paths do not fit", async () => {
    const map = await buildRepoMap(root, { maxChars: 300 });
    expect(map.omittedFiles).toBeGreaterThan(0);
    expect(map.text).toMatch(/\(\d+ more files not shown; use find_files or list_dir to see them\.\)$/);
  });

  it("works outside a git repository", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "harness-map-plain-"));
    try {
      await writeFile(path.join(plain, "main.go"), "package main\nfunc main() {}\n");
      expect((await buildRepoMap(plain, { maxChars: 2000 })).text).toContain("main.go:\n  2: func main()");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("is turned off with 0 tokens", async () => {
    expect(await repoMapFor(root, "x", 0)).toBeUndefined();
    expect((await repoMapFor(root, "x", 1000))?.text.length).toBeLessThanOrEqual(4000);
  });
});

describe("withRepoMap and describeRepoMap", () => {
  const map: RepoMap = { text: "Repository map: ...\na.py:\n  1: def f()", files: 42, detailedFiles: 18, symbols: 130, omittedFiles: 3, durationMs: 320 };

  it("puts the map before the task, fenced", () => {
    expect(withRepoMap("Fix this", map)).toMatch(/^<repo_map>\nRepository map: \.\.\.\na\.py:\n {2}1: def f\(\)\n<\/repo_map>\nThe map above .*\n\nFix this$/);
    expect(withRepoMap("Fix this", undefined)).toBe("Fix this");
  });

  it("summarizes the map in one line", () => {
    expect(describeRepoMap(map)).toBe("Repo map: 42 files, 18 with symbols (130 symbols), 3 not shown, ~10 tokens, 0.3s.");
  });
});
