import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Language, Node, Parser } from "@vscode/tree-sitter-wasm";
import { listFiles } from "../tools/files.js";

/**
 * Repository map: a compact overview of the repository (its files, and the
 * classes and functions in its source files, with line numbers) that the agent
 * gets up front instead of exploring file by file.
 *
 * Symbols come from tree-sitter grammars (WebAssembly, so nothing is compiled
 * on install). When the map would not fit its budget, the files that look most
 * related to the task (by words in the task) are shown first.
 */

/** Files bigger than this are listed but not parsed (generated or minified code). */
const MAX_PARSE_BYTES = 256 * 1024;
/** At most this many files are parsed; the rest of a huge repository is listed by path only. */
const MAX_PARSED_FILES = 1500;
/** Stop parsing after this long; what was parsed so far is used. */
const PARSE_TIME_BUDGET_MS = 8000;
/**
 * Symbols shown per file: a file that does not fit with the first limit is
 * tried with the next ones (keeping the symbols that matter most) before it
 * is listed by path only.
 */
const SYMBOL_LIMITS = [40, 15, 6];
const MAX_HEADER_CHARS = 100;
/** Rough characters per token for code-like text, to turn the token budget into characters. */
export const CHARS_PER_TOKEN = 4;

type Kind = "container" | "leaf";
interface DefSpec {
  kind: Kind;
  /** Only nodes for which this returns true count as definitions. */
  when?: (n: Node) => boolean;
  /** Shown before the header, e.g. "type " for Go type specs (the keyword sits on the parent). */
  prefix?: string;
}
interface LangSpec {
  grammar: string;
  defs: Record<string, DefSpec>;
}

const C: DefSpec = { kind: "container" };
const L: DefSpec = { kind: "leaf" };
const hasBody: DefSpec = { kind: "container", when: (n) => n.childForFieldName("body") !== null };
const functionValue = (n: Node) => /^(arrow_function|function_expression|function|generator_function)$/.test(n.childForFieldName("value")?.type ?? "");
const declaresFunction = (n: Node) => n.childForFieldName("declarator")?.type === "function_declarator";

const JS_DEFS: Record<string, DefSpec> = {
  class_declaration: C,
  abstract_class_declaration: C,
  function_declaration: L,
  generator_function_declaration: L,
  method_definition: L,
  abstract_method_signature: L,
  interface_declaration: L,
  type_alias_declaration: L,
  enum_declaration: L,
  internal_module: hasBody, // namespace X { ... }
  variable_declarator: { kind: "leaf", when: functionValue }, // const f = () => ...
};
const CPP_DEFS: Record<string, DefSpec> = {
  namespace_definition: hasBody,
  class_specifier: hasBody,
  struct_specifier: hasBody,
  enum_specifier: { kind: "leaf", when: (n) => n.childForFieldName("body") !== null },
  function_definition: L,
  field_declaration: { kind: "leaf", when: declaresFunction }, // method declared in a class
  declaration: { kind: "leaf", when: declaresFunction }, // prototype in a header
};

const LANGUAGES: Record<string, LangSpec> = {
  python: { grammar: "python", defs: { class_definition: C, function_definition: L } },
  javascript: { grammar: "javascript", defs: JS_DEFS },
  typescript: { grammar: "typescript", defs: JS_DEFS },
  tsx: { grammar: "tsx", defs: JS_DEFS },
  go: {
    grammar: "go",
    defs: { function_declaration: L, method_declaration: L, type_spec: { kind: "leaf", prefix: "type " } },
  },
  rust: {
    grammar: "rust",
    defs: {
      function_item: L,
      function_signature_item: L,
      struct_item: L,
      enum_item: L,
      union_item: L,
      type_item: L,
      macro_definition: L,
      trait_item: C,
      impl_item: C,
      mod_item: hasBody,
    },
  },
  java: {
    grammar: "java",
    defs: {
      class_declaration: C,
      interface_declaration: C,
      enum_declaration: C,
      record_declaration: C,
      annotation_type_declaration: L,
      method_declaration: L,
      constructor_declaration: L,
    },
  },
  csharp: {
    grammar: "c-sharp",
    defs: {
      namespace_declaration: C,
      class_declaration: C,
      struct_declaration: C,
      interface_declaration: C,
      record_declaration: C,
      enum_declaration: L,
      method_declaration: L,
      constructor_declaration: L,
    },
  },
  ruby: { grammar: "ruby", defs: { module: C, class: C, method: L, singleton_method: L } },
  php: {
    grammar: "php",
    defs: {
      class_declaration: C,
      interface_declaration: C,
      trait_declaration: C,
      enum_declaration: C,
      function_definition: L,
      method_declaration: L,
    },
  },
  cpp: { grammar: "cpp", defs: CPP_DEFS },
};

const EXTENSIONS: Record<string, keyof typeof LANGUAGES> = {
  ".py": "python",
  ".pyi": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  // C is parsed with the C++ grammar, which accepts nearly all of it.
  ".c": "cpp",
  ".h": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
};

/** Nodes the walk never enters looking for definitions: function bodies, expressions, literals. */
const OPAQUE = /function|lambda|arrow|closure|method|call|expression|string|comment|argument|literal|array|object|dictionary|list$|block$|body$|compound_statement/;
/** How deep the walk goes through nodes that are not definitions (export, decorators, templates, ...). */
const MAX_PLAIN_DEPTH = 4;

/** A class, function, method or type found in a file. */
export interface MapSymbol {
  /** 1-based line of the definition. */
  line: number;
  /** Nesting level: 0 at the top of the file, 1 for methods in a class, ... */
  depth: number;
  /** The definition's first line(s) up to its body, e.g. "def greet(self, name: str) -> str". */
  header: string;
  /** The defined name, e.g. "greet". */
  name: string;
  /** Classes, modules, impl blocks: definitions that hold other definitions. */
  container: boolean;
}

// --- tree-sitter loading -------------------------------------------------------

type TreeSitter = typeof import("@vscode/tree-sitter-wasm");
let runtime: Promise<{ ts: TreeSitter; dir: string }> | undefined;
const languages = new Map<string, Promise<Language>>();

/** Loads the WebAssembly runtime once, on first use (so startup stays fast). */
function loadRuntime(): Promise<{ ts: TreeSitter; dir: string }> {
  runtime ??= (async () => {
    const require = createRequire(import.meta.url);
    const main = require.resolve("@vscode/tree-sitter-wasm");
    const ts = require("@vscode/tree-sitter-wasm") as TreeSitter;
    await ts.Parser.init();
    return { ts, dir: path.dirname(main) };
  })();
  runtime.catch(() => (runtime = undefined)); // a failed load may be retried
  return runtime;
}

async function languageFor(grammar: string): Promise<Language> {
  const { ts, dir } = await loadRuntime();
  let lang = languages.get(grammar);
  if (!lang) {
    lang = ts.Language.load(path.join(dir, `tree-sitter-${grammar}.wasm`));
    languages.set(grammar, lang);
  }
  return lang;
}

/** The language of a file from its extension, or undefined if no grammar covers it. */
export function languageOf(file: string): string | undefined {
  return EXTENSIONS[path.extname(file).toLowerCase()];
}

// --- symbols -------------------------------------------------------------------

/** Parses source code and returns its definitions in file order. */
export async function extractSymbols(source: string, language: string): Promise<MapSymbol[]> {
  const spec = LANGUAGES[language];
  if (!spec) return [];
  const { ts } = await loadRuntime();
  const parser: Parser = new ts.Parser();
  try {
    parser.setLanguage(await languageFor(spec.grammar));
    const tree = parser.parse(source);
    if (!tree) return [];
    try {
      const out: MapSymbol[] = [];
      collect(tree.rootNode, spec, 0, 0, out);
      // Overloads (Python @overload, TypeScript signatures) repeat a name: keep the last, the implementation.
      return out.filter((sym, i) => {
        const next = out[i + 1];
        return !(next && next.depth === sym.depth && next.name === sym.name && !sym.container && !next.container);
      });
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

function collect(node: Node, spec: LangSpec, depth: number, plainDepth: number, out: MapSymbol[]): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    const def = spec.defs[child.type];
    if (def) {
      if (def.when && !def.when(child)) continue; // e.g. a variable that is not a function
      const header = (def.prefix ?? "") + headerOf(child);
      const name = child.childForFieldName("name")?.text ?? nameOf(header) ?? "";
      out.push({ line: child.startPosition.row + 1, depth, header, name, container: def.kind === "container" });
      const body = def.kind === "container" ? child.childForFieldName("body") : null;
      if (body) collect(body, spec, depth + 1, 0, out);
    } else if (plainDepth < MAX_PLAIN_DEPTH && !OPAQUE.test(child.type)) {
      collect(child, spec, depth, plainDepth + 1, out); // export_statement, decorated_definition, template_declaration, ...
    }
  }
}

/** The definition's text before its body, on one line: "class Greeter(Base)", "fn m(&self) -> i32". */
function headerOf(node: Node): string {
  // For `const f = (x) => ...` the body belongs to the function in `value`.
  const body = node.childForFieldName("body") ?? node.childForFieldName("value")?.childForFieldName("body") ?? null;
  let text = body ? node.text.slice(0, body.startIndex - node.startIndex) : (node.text.split("\n")[0] ?? "");
  text = text
    .replace(/\s+/g, " ")
    .replace(/([([]) /g, "$1")
    .replace(/,? ([)\]])/g, "$1") // "f( a, b, )" -> "f(a, b)"
    .trim()
    .replace(/\s*[{:;]$/, "")
    .trim();
  return text.length > MAX_HEADER_CHARS ? `${text.slice(0, MAX_HEADER_CHARS - 1).trimEnd()}…` : text;
}

// --- ranking -------------------------------------------------------------------

const STOP_WORDS = new Set(
  (
    "the and for with this that when from into should would could does doesn don not but are was were been have has had " +
    "its it's can cannot will what which who how why where there here then than them they their our your you use used " +
    "using get gets set sets add adds new old fix fixes fixed bug bugs issue error errors work works working instead also " +
    "only just like some any all one two same other more most very need needs want wants make makes made file files code " +
    "line lines see expected actual return returns true false none null value values"
  ).split(" "),
);

/** Lower-case words of an identifier or path: "parseArgs" -> ["parse", "args"], "max_steps" -> ["max", "steps"]. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

interface Query {
  /** Words from the task. */
  words: Set<string>;
  /** Whole identifiers from the task (lower case), e.g. "parse_args". */
  identifiers: Set<string>;
  /** The task text, lower case, to spot mentioned file names. */
  text: string;
}

function makeQuery(text: string): Query {
  const identifiers = new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map((s) => s.toLowerCase()).filter((s) => !STOP_WORDS.has(s)));
  return { words: new Set(words(text)), identifiers, text: text.toLowerCase() };
}

/** True for test files and files in test directories: tests/x.py, test_x.py, x.test.ts, x_test.go. */
export const isTestPath = (file: string) => /(^|\/)(tests?|spec|__tests__)\/|(^|[/_.-])(test|spec)s?[_.-]|_test\.[a-z]+$/i.test(file);

/**
 * Weight of each task word: 1 for a word only a few files have, near 0 for
 * one nearly every file has ("model" in a Django repository).
 */
type Weights = Map<string, number>;

function weights(terms: Set<string>, docs: Set<string>[]): Weights {
  const n = docs.length;
  const out: Weights = new Map();
  for (const w of terms) {
    const df = docs.reduce((c, d) => c + (d.has(w) ? 1 : 0), 0);
    out.set(w, df === 0 ? 0 : Math.log((n + 1) / (df + 1)) / Math.log(n + 1));
  }
  return out;
}

/** How strongly the file's path matches the task (before parsing). */
function pathScore(file: string, q: Query, w: Weights): number {
  let score = 0;
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (q.text.includes(lower) || (base.includes(".") && q.text.includes(base))) score += 10;
  for (const word of new Set(words(file))) score += 3 * (w.get(word) ?? 0);
  return score;
}

/**
 * How strongly the file's symbols match the task. A name the task mentions
 * counts most, once per name, and less when many files define it.
 */
function symbolScore(symbols: MapSymbol[], q: Query, nameWeights: Weights, wordWeights: Weights): number {
  const named = new Set<string>();
  let partial = 0;
  for (const s of symbols) {
    const name = s.name.toLowerCase();
    if (q.identifiers.has(name)) named.add(name);
    else partial += Math.max(0, ...words(s.name).map((word) => wordWeights.get(word) ?? 0));
  }
  let exact = 0;
  for (const name of named) exact += nameWeights.get(name) ?? 0;
  return 5 * Math.min(exact, 3) + Math.min(partial, 3);
}

/** 2 if the task names the symbol, 1 if it shares a word with it, else 0. */
function symbolMatch(s: MapSymbol, q: Query): number {
  if (!s.name) return 0;
  if (q.identifiers.has(s.name.toLowerCase())) return 2;
  return words(s.name).some((w) => q.words.has(w)) ? 1 : 0;
}

/**
 * Picks at most `limit` symbols of a file, in file order: those the task
 * mentions first, then classes, then public names, always with the class
 * that holds each picked method.
 */
function selectSymbols(symbols: MapSymbol[], q: Query, limit: number): MapSymbol[] {
  if (symbols.length <= limit) return symbols;
  const parent = symbols.map((s, i) => {
    for (let j = i - 1; j >= 0; j--) if (symbols[j]!.depth < s.depth) return j;
    return -1;
  });
  const priority = (s: MapSymbol) => {
    const priv = s.name.startsWith("_") && !/^__\w+__$/.test(s.name);
    return 10 * symbolMatch(s, q) + (s.container ? 4 : 0) - (priv ? 3 : 0) - s.depth;
  };
  const order = symbols.map((_, i) => i).sort((a, b) => priority(symbols[b]!) - priority(symbols[a]!) || a - b);
  const picked = new Set<number>();
  for (const i of order) {
    const chain: number[] = [];
    for (let j = i; j >= 0 && !picked.has(j); j = parent[j]!) chain.push(j);
    if (picked.size + chain.length > limit) continue;
    for (const j of chain) picked.add(j);
    if (picked.size === limit) break;
  }
  return symbols.filter((_, i) => picked.has(i));
}

/** The defined name in a header: the last identifier before "(" or the first after a keyword. */
function nameOf(header: string): string | undefined {
  const beforeParen = header.split("(")[0] ?? "";
  const ids = beforeParen.match(/[A-Za-z_$][\w$]*/g);
  return ids?.[ids.length - 1];
}

// --- the map -------------------------------------------------------------------

export interface RepoMapOptions {
  /** Text of the task; files whose paths or symbols match its words are shown first. */
  query?: string;
  /** Size budget in characters. */
  maxChars: number;
  signal?: AbortSignal;
}

export interface RepoMap {
  text: string;
  /** Files in the repository. */
  files: number;
  /** Files shown with their symbols. */
  detailedFiles: number;
  symbols: number;
  /** Files left out entirely because of the budget. */
  omittedFiles: number;
  durationMs: number;
}

interface FileEntry {
  file: string;
  score: number;
  symbols?: MapSymbol[];
}

/** Builds the map for the repository at `root`. */
export async function buildRepoMap(root: string, opts: RepoMapOptions): Promise<RepoMap> {
  const started = Date.now();
  const q = makeQuery(opts.query ?? "");
  const { files } = await listFiles(root, root, opts.signal);

  const pathWeights = weights(q.words, files.map((f) => new Set(words(f))));
  const entries: FileEntry[] = files.map((file) => ({ file, score: pathScore(file, q, pathWeights) }));
  const byRelevance = (a: FileEntry, b: FileEntry) => b.score - a.score || depthOf(a.file) - depthOf(b.file) || compare(a.file, b.file);

  // Parse source files, most promising first, within the file and time limits.
  // Without the parser (it failed to load), the map lists paths only.
  const canParse = await loadRuntime().then(
    () => true,
    () => false,
  );
  const toParse = !canParse ? [] : entries.filter((e) => languageOf(e.file) && !/\.min\.[cm]?js$/.test(e.file)).sort(byRelevance).slice(0, MAX_PARSED_FILES);
  for (const entry of toParse) {
    if (opts.signal?.aborted || Date.now() - started > PARSE_TIME_BUDGET_MS) break;
    const source = await readSource(path.join(root, entry.file));
    if (source === undefined) continue;
    try {
      entry.symbols = await extractSymbols(source, languageOf(entry.file)!);
    } catch {
      continue; // a file the grammar cannot handle is listed by path only
    }
  }
  const parsed = entries.filter((e) => e.symbols);
  const nameWeights = weights(q.identifiers, parsed.map((e) => new Set(e.symbols!.map((s) => s.name.toLowerCase()))));
  const wordWeights = weights(q.words, parsed.map((e) => new Set(e.symbols!.flatMap((s) => words(s.name)))));
  for (const entry of parsed) entry.score += symbolScore(entry.symbols!, q, nameWeights, wordWeights);
  // The code under test comes first; tests the task mentions still rank well.
  for (const entry of entries) if (isTestPath(entry.file)) entry.score = entry.score / 2 - 0.5;

  // Detailed blocks for the most relevant files that fit, then plain paths for the rest.
  const header = "Repository map: source files with their classes and functions (line numbers first), then the other files.";
  // Plain paths (README, configs, tests) matter too: up to a quarter of the budget is kept for them.
  const reserved = Math.min(pathsCost(files) + 80, Math.floor(opts.maxChars / 4));
  let budget = opts.maxChars - header.length - 1 - reserved;
  const detailed: { file: string; block: string; count: number }[] = [];
  const rest: FileEntry[] = [];
  for (const entry of [...entries].sort(byRelevance)) {
    const symbols = entry.symbols ?? [];
    const fitting = symbols.length
      ? SYMBOL_LIMITS.map((limit) => selectSymbols(symbols, q, limit))
          .map((shown) => ({ shown, block: renderFile(entry.file, shown, symbols.length) }))
          .find((r) => r.block.length + 1 <= budget)
      : undefined;
    if (fitting) {
      detailed.push({ file: entry.file, block: fitting.block, count: fitting.shown.length });
      budget -= fitting.block.length + 1;
    } else {
      rest.push(entry);
    }
  }
  // Then the other files by path, the most relevant first when not all fit.
  const listed: string[] = [];
  const omitted: string[] = [];
  const restBudget = budget + reserved - 80; // room for the "Other files" title and the omission note
  const dirs = new Set<string>();
  let used = 0;
  for (const entry of rest) {
    const cost = pathCost(entry.file, dirs);
    if (used + cost <= restBudget) {
      listed.push(entry.file);
      dirs.add(dirOf(entry.file));
      used += cost;
    } else {
      omitted.push(entry.file);
    }
  }

  const lines = [header];
  for (const d of detailed.sort((a, b) => compare(a.file, b.file))) lines.push(d.block);
  if (listed.length) lines.push(detailed.length ? "\nOther files:" : "Files:", ...renderPaths(listed));
  if (omitted.length) lines.push(`(${omitted.length} more ${omitted.length === 1 ? "file" : "files"} not shown; use find_files or list_dir to see them.)`);

  return {
    text: lines.join("\n"),
    files: files.length,
    detailedFiles: detailed.length,
    symbols: detailed.reduce((n, d) => n + d.count, 0),
    omittedFiles: omitted.length,
    durationMs: Date.now() - started,
  };
}

function renderFile(file: string, shown: MapSymbol[], total: number): string {
  const width = String(shown[shown.length - 1]?.line ?? 1).length;
  const lines = [`${file}:`, ...shown.map((s) => `  ${String(s.line).padStart(width)}: ${"  ".repeat(s.depth)}${s.header}`)];
  if (total > shown.length) lines.push(`  … ${total - shown.length} more`);
  return lines.join("\n");
}

/** Paths grouped by directory: "  src/util/: a.py, b.py". */
function renderPaths(files: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const f of [...files].sort(compare)) {
    const dir = dirOf(f);
    groups.set(dir, [...(groups.get(dir) ?? []), path.posix.basename(f)]);
  }
  const dirs = [...groups.keys()].sort((a, b) => (a === "./" ? -1 : b === "./" ? 1 : compare(a, b)));
  return dirs.map((dir) => `  ${dir}: ${groups.get(dir)!.join(", ")}`);
}

/** Characters a path adds to the grouped list; a new directory opens a new "  dir/: " line. */
function pathCost(file: string, dirs: Set<string>): number {
  const dir = dirOf(file);
  return path.posix.basename(file).length + 2 + (dirs.has(dir) ? 0 : dir.length + 4);
}

function pathsCost(files: string[]): number {
  const dirs = new Set<string>();
  let total = 0;
  for (const f of files) {
    total += pathCost(f, dirs);
    dirs.add(dirOf(f));
  }
  return total;
}

const dirOf = (file: string) => (file.includes("/") ? `${file.slice(0, file.lastIndexOf("/"))}/` : "./");
const depthOf = (file: string) => file.split("/").length;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function readSource(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_PARSE_BYTES) return undefined;
    const data = await readFile(file);
    if (data.subarray(0, 8000).includes(0)) return undefined; // binary
    return data.toString("utf8");
  } catch {
    return undefined;
  }
}

/** The map as the start of the first message of a task, marked as generated context. */
export function withRepoMap(prompt: string, map: RepoMap | undefined): string {
  if (!map) return prompt;
  return [
    "<repo_map>",
    map.text,
    "</repo_map>",
    "The map above was generated from the repository when the task started. Use it to choose which files to open; view the lines before you edit them.",
    "",
    prompt,
  ].join("\n");
}

/** One line for the terminal: "Repo map: 42 files, 18 with symbols (130 symbols), ~2.1k tokens, 0.3s." */
export function describeRepoMap(map: RepoMap): string {
  const tokens = map.text.length / CHARS_PER_TOKEN;
  const size = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens));
  const omitted = map.omittedFiles ? `, ${map.omittedFiles} not shown` : "";
  const files = `${map.files} ${map.files === 1 ? "file" : "files"}`;
  return `Repo map: ${files}, ${map.detailedFiles} with symbols (${map.symbols} symbols)${omitted}, ~${size} tokens, ${(map.durationMs / 1000).toFixed(1)}s.`;
}

/**
 * The map for a task, or undefined when it is turned off or cannot be built:
 * the map only saves exploring steps, so a failure never stops the task.
 */
export async function repoMapFor(root: string, query: string, tokens: number, signal?: AbortSignal): Promise<RepoMap | undefined> {
  if (tokens <= 0) return undefined;
  try {
    return await buildRepoMap(root, { query, maxChars: tokens * CHARS_PER_TOKEN, signal });
  } catch {
    return undefined;
  }
}
