import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { git } from "../agent/fix.js";
import { runCommand } from "../tools/bash.js";
import type { CommandSandbox } from "../tools/types.js";
import type { ProjectInfo } from "./detect.js";
import { envDirFor, keepClean, statusOf } from "./env.js";

/**
 * The baseline: the project's tests, run once on the unchanged code before the
 * agent starts. The agent learns whether the tests run at all and which ones
 * already fail, so it does not chase failures it did not cause (or think it
 * broke them).
 *
 * A result is cached per commit, command and installed dependencies, so a
 * second /fix of the same code does not run the suite again.
 */

export const DEFAULT_BASELINE_TIMEOUT_S = 120;
/** Failing tests listed for the agent; the run record keeps more. */
const FAILING_SHOWN = 20;
const FAILING_KEPT = 200;
const ERROR_LINES = 8;
const ERROR_CHARS = 1000;

export interface TestCounts {
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

export interface ParsedTests {
  /** Which runner's output was recognised. */
  framework: string;
  counts: TestCounts;
  /** Go counts packages, the others tests. */
  unit: "tests" | "packages";
  /** Failing tests (with a short reason where the runner gives one). */
  failing: string[];
}

export type BaselineStatus = "passed" | "failed" | "no_tests" | "error" | "timed_out" | "cancelled";

export interface BaselineRun {
  name: string;
  dir: string;
  command: string;
  status: BaselineStatus;
  framework?: string;
  counts?: TestCounts;
  unit?: "tests" | "packages";
  failing: string[];
  /** The end of the output when the tests could not run. */
  detail?: string;
  exitCode: number | null;
  durationMs: number;
  /** Taken from an earlier run of the same code. */
  cached: boolean;
}

export interface Baseline {
  runs: BaselineRun[];
  timeoutS: number;
  /** Tracked files the tests changed, put back; new files they made, added to .git/info/exclude. */
  restored: string[];
  excluded: string[];
  durationMs: number;
}

export interface CommandOutcome {
  output: string;
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface BaselineOptions {
  /** Environment of the installed dependencies. */
  env?: Record<string, string>;
  envsDir?: string;
  timeoutS?: number;
  signal?: AbortSignal;
  onProgress?(line: string): void;
  /** Run the tests inside this sandbox (the Docker container) instead of on this machine. */
  sandbox?: CommandSandbox;
  /** For tests: runs the test command (default: bash, credentials removed). */
  run?(command: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<CommandOutcome>;
}

// --- parsing ---------------------------------------------------------------------

const zero = (): TestCounts => ({ passed: 0, failed: 0, errors: 0, skipped: 0 });
const total = (c: TestCounts) => c.passed + c.failed + c.errors + c.skipped;

/** "3 failed, 120 passed" / "Failures: 2, Errors: 1" → { failed: 3, passed: 120 } (keys lowercased). */
function tally(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (key: string, n: string) => (out[key.toLowerCase()] = (out[key.toLowerCase()] ?? 0) + Number(n));
  for (const m of text.matchAll(/(\d+) ([a-z]+)/gi)) add(m[2]!, m[1]!);
  for (const m of text.matchAll(/([a-z]+): (\d+)/gi)) add(m[1]!, m[2]!);
  return out;
}

const all = (text: string, re: RegExp, group = 1) => [...text.matchAll(re)].map((m) => m[group]!.trim());
const last = (text: string, re: RegExp) => [...text.matchAll(re)].at(-1);

type Parser = (out: string) => Omit<ParsedTests, "unit"> & { unit?: ParsedTests["unit"] } | undefined;

const PARSERS: Parser[] = [
  // pytest: "== 3 failed, 120 passed, 2 skipped in 4.50s ==" (-q drops the ==), names from -rfE: "FAILED tests/x.py::test_y - AssertionError"
  (out) => {
    const m = last(out, /^=*\s*((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+) in [\d.]+\s*s(?:econds)?\b.*$/gm);
    if (!m) return /^=*\s*no tests ran\b/m.test(out) ? { framework: "pytest", counts: zero(), failing: [] } : undefined;
    const t = tally(m[1]!);
    const counts = { passed: (t.passed ?? 0) + (t.xpassed ?? 0), failed: t.failed ?? 0, errors: (t.error ?? 0) + (t.errors ?? 0), skipped: (t.skipped ?? 0) + (t.xfailed ?? 0) };
    // A collection error's reason is not on its summary line, but in its "ERROR collecting" section.
    const reasons = new Map<string, string>();
    for (const section of out.matchAll(/^_+ ERROR collecting (\S+) _+$\n([^]*?)(?=^[_=]{3,})/gm)) {
      const reason = /^E\s+(.+)$/m.exec(section[2]!)?.[1]?.trim();
      if (reason) reasons.set(section[1]!, reason);
    }
    const failing = all(out, /^(?:FAILED|ERROR) (.+)$/gm).map((f) => (!f.includes(" - ") && reasons.has(f) ? `${f} - ${reasons.get(f)}` : f));
    return { framework: "pytest", counts, failing };
  },
  // unittest and Django: "Ran 120 tests in 4.5s" then "OK" or "FAILED (failures=2, errors=1, skipped=3)"
  (out) => {
    const ran = last(out, /^Ran (\d+) tests? in /gm);
    if (!ran) return undefined;
    const result = last(out, /^(OK|FAILED)(?: \((.*)\))?\s*$/gm);
    const detail = Object.fromEntries(all(result?.[2] ?? "", /([a-z ]+=\d+)/g).map((kv) => [kv.split("=")[0]!.trim(), Number(kv.split("=")[1])]));
    const failed = detail.failures ?? 0;
    const errors = detail.errors ?? 0;
    const skipped = (detail.skipped ?? 0) + (detail["expected failures"] ?? 0);
    const counts = { passed: Math.max(0, Number(ran[1]) - failed - errors - skipped), failed, errors, skipped };
    return { framework: "unittest", counts, failing: all(out, /^(?:FAIL|ERROR): (.+)$/gm) };
  },
  // cargo: one "test result: FAILED. 3 passed; 1 failed; 0 ignored" per test binary
  (out) => {
    const results = [...out.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
    if (!results.length) return undefined;
    const counts = zero();
    for (const r of results) {
      counts.passed += Number(r[1]);
      counts.failed += Number(r[2]);
      counts.skipped += Number(r[3]);
    }
    return { framework: "cargo", counts, failing: all(out, /^---- (\S+) stdout ----$/gm) };
  },
  // go: "ok  \tpkg\t0.1s" / "FAIL\tpkg\t0.2s" per package, "--- FAIL: TestX (0.00s)" per test
  (out) => {
    const ok = all(out, /^ok\s*\t(\S+)/gm);
    const failedPkgs = all(out, /^FAIL\t(\S+)/gm);
    if (!ok.length && !failedPkgs.length) return undefined;
    const tests = all(out, /^\s*--- FAIL: (\S+)/gm);
    return { framework: "go", unit: "packages", counts: { ...zero(), passed: ok.length, failed: failedPkgs.length }, failing: tests.length ? tests : failedPkgs };
  },
  // jest: "Tests:       1 failed, 5 passed, 6 total", "● Suite › name"
  (out) => {
    const m = last(out, /^Tests:\s+(.*\d+ total)$/gm);
    if (!m) return undefined;
    const t = tally(m[1]!);
    return { framework: "jest", counts: { passed: t.passed ?? 0, failed: t.failed ?? 0, errors: 0, skipped: (t.skipped ?? 0) + (t.todo ?? 0) }, failing: all(out, /^\s+● (?!Console)(.+)$/gm) };
  },
  // vitest: "Tests  1 failed | 5 passed (6)", " FAIL  tests/a.test.ts > suite > name"
  (out) => {
    const m = last(out, /^\s*Tests\s{2,}(\d+ .+)$/gm);
    if (!m) return undefined;
    const t = tally(m[1]!.replace(/\(\d+\)/, ""));
    return { framework: "vitest", counts: { passed: t.passed ?? 0, failed: t.failed ?? 0, errors: 0, skipped: (t.skipped ?? 0) + (t.todo ?? 0) }, failing: all(out, /^\s*FAIL\s+(.+)$/gm) };
  },
  // node --test (TAP or spec reporter): "# pass 5" / "ℹ fail 1", "not ok 3 - name"
  (out) => {
    const pass = last(out, /^(?:#|ℹ) pass (\d+)/gm);
    if (!pass) return undefined;
    const n = (re: RegExp) => Number(last(out, re)?.[1] ?? 0);
    const counts = { passed: Number(pass[1]), failed: n(/^(?:#|ℹ) fail (\d+)/gm), errors: 0, skipped: n(/^(?:#|ℹ) skipped (\d+)/gm) + n(/^(?:#|ℹ) todo (\d+)/gm) };
    return { framework: "node:test", counts, failing: all(out, /^\s*not ok \d+ - (.+)$/gm) };
  },
  // mocha: "  5 passing", "  1 failing", "  2 pending"
  (out) => {
    const pass = last(out, /^\s+(\d+) passing\b/gm);
    if (!pass) return undefined;
    const n = (re: RegExp) => Number(last(out, re)?.[1] ?? 0);
    return { framework: "mocha", counts: { passed: Number(pass[1]), failed: n(/^\s+(\d+) failing\b/gm), errors: 0, skipped: n(/^\s+(\d+) pending\b/gm) }, failing: all(out, /^\s+\d+\) (.+)$/gm) };
  },
  // rspec: "10 examples, 2 failures, 1 pending", "rspec ./spec/x_spec.rb:12 # does a thing"
  (out) => {
    const m = last(out, /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/gm);
    if (!m) return undefined;
    const counts = { passed: Number(m[1]) - Number(m[2]) - Number(m[3] ?? 0), failed: Number(m[2]), errors: 0, skipped: Number(m[3] ?? 0) };
    return { framework: "rspec", counts, failing: all(out, /^rspec (\S+ # .+)$/gm) };
  },
  // phpunit: "OK (12 tests, 30 assertions)" or "Tests: 12, Assertions: 30, Failures: 2, Errors: 1, Skipped: 1."
  (out) => {
    const ok = last(out, /^OK \((\d+) tests?/gm);
    if (ok) return { framework: "phpunit", counts: { ...zero(), passed: Number(ok[1]) }, failing: [] };
    const m = last(out, /^Tests: (\d+), Assertions: \d+(.*)$/gm);
    if (!m) return undefined;
    const t = tally(m[2]!);
    const counts = { failed: t.failures ?? 0, errors: t.errors ?? 0, skipped: (t.skipped ?? 0) + (t.incomplete ?? 0), passed: 0 };
    counts.passed = Math.max(0, Number(m[1]) - counts.failed - counts.errors - counts.skipped);
    return { framework: "phpunit", counts, failing: all(out, /^\d+\) (\S+)$/gm) };
  },
  // Maven surefire: "Tests run: 12, Failures: 1, Errors: 0, Skipped: 2" (the last one is the total)
  (out) => {
    const m = last(out, /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g);
    if (!m) return undefined;
    const [run, failed, errors, skipped] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    return { framework: "maven", counts: { passed: run - failed - errors - skipped, failed, errors, skipped }, failing: all(out, /^\[ERROR\] {2,}(\S+?)(?::\d+)?(?:\s|$)/gm) };
  },
  // Gradle: "12 tests completed, 1 failed, 2 skipped", "CalcTest > adds() FAILED"
  (out) => {
    const m = last(out, /(\d+) tests completed, (\d+) failed(?:, (\d+) skipped)?/g);
    if (!m) return undefined;
    const counts = { passed: Number(m[1]) - Number(m[2]) - Number(m[3] ?? 0), failed: Number(m[2]), errors: 0, skipped: Number(m[3] ?? 0) };
    return { framework: "gradle", counts, failing: all(out, /^(\S.* > .+) FAILED$/gm) };
  },
  // dotnet: "Failed!  - Failed:     1, Passed:    11, Skipped:     0, Total:    12" per test project
  (out) => {
    const results = [...out.matchAll(/(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+)/g)];
    if (!results.length) return undefined;
    const counts = zero();
    for (const r of results) {
      counts.failed += Number(r[1]);
      counts.passed += Number(r[2]);
      counts.skipped += Number(r[3]);
    }
    return { framework: "dotnet", counts, failing: all(out, /^\s+Failed (\S+) \[/gm) };
  },
];

/** Counts and failing tests from a test runner's output, or undefined if no known runner's summary is in it. */
export function parseTestOutput(output: string): ParsedTests | undefined {
  for (const parse of PARSERS) {
    const found = parse(output);
    if (found) return { unit: "tests", ...found, failing: [...new Set(found.failing)].slice(0, FAILING_KEPT) };
  }
  return undefined;
}

// --- running ---------------------------------------------------------------------

/**
 * The command run for the baseline. pytest also lists failing tests with
 * their reason (-rfE), and runs the other tests when a file fails to import.
 */
export function baselineCommand(testCommand: string): string {
  if (!/\bpytest\b/.test(testCommand)) return testCommand;
  let command = testCommand;
  if (!/\s-r\w*/.test(command)) command += " -rfE";
  if (!command.includes("--continue-on-collection-errors")) command += " --continue-on-collection-errors";
  return command;
}

/** What a finished command means for the baseline. */
export function judge(outcome: CommandOutcome, parsed: ParsedTests | undefined): BaselineStatus {
  if (outcome.cancelled) return "cancelled";
  if (outcome.timedOut) return "timed_out";
  if (parsed && total(parsed.counts) === 0) return "no_tests";
  if (outcome.code === 0) return "passed";
  if (parsed && parsed.counts.failed + parsed.counts.errors > 0) return "failed";
  if (outcome.code === 5 && parsed?.framework === "pytest") return "no_tests";
  return "error";
}

function tail(output: string): string {
  const text = output.trim().split("\n").filter((l) => l.trim()).slice(-ERROR_LINES).join("\n");
  return text.length > ERROR_CHARS ? `…${text.slice(-ERROR_CHARS)}` : text;
}

async function defaultRun(command: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal, sandbox?: CommandSandbox): Promise<CommandOutcome> {
  const r = await runCommand(command, cwd, timeoutMs, { signal, env, sandbox });
  return { output: r.output, code: r.code, timedOut: r.timedOut, cancelled: r.cancelled, durationMs: r.durationMs };
}

/** Cache key: the commit, the command, and what is installed (the dependency stamps). */
async function cacheKey(root: string, envDir: string, dir: string, command: string): Promise<string | undefined> {
  let head: string;
  try {
    head = await git(root, ["rev-parse", "HEAD"]);
  } catch {
    return undefined; // not a git repository: nothing identifies the code
  }
  const hash = createHash("sha256").update(`${head}\0${dir}\0${command}`);
  const stamps = path.join(envDir, "stamps");
  for (const f of (await readdir(stamps).catch(() => [] as string[])).sort()) hash.update(`\0${f}\0${await readFile(path.join(stamps, f), "utf8").catch(() => "")}`);
  return hash.digest("hex");
}

/** Statuses worth caching: a slow suite stays slow; an error may be fixed by installing something. */
const CACHEABLE: BaselineStatus[] = ["passed", "failed", "no_tests", "timed_out"];

/**
 * Runs each detected test command once on the current code. Returns
 * undefined when no test command was detected. Never throws for failing
 * tests; the result says what happened.
 */
export async function runBaseline(root: string, info: ProjectInfo, opts: BaselineOptions = {}): Promise<Baseline | undefined> {
  const targets = info.ecosystems.filter((e) => e.test);
  if (!targets.length) return undefined;
  const started = Date.now();
  const timeoutS = opts.timeoutS ?? DEFAULT_BASELINE_TIMEOUT_S;
  const progress = opts.onProgress ?? (() => {});
  const run = opts.run ?? ((command, cwd, env, ms, signal) => defaultRun(command, cwd, env, ms, signal, opts.sandbox));
  const envDir = envDirFor(root, opts.envsDir);
  const before = await statusOf(root);

  const runs: BaselineRun[] = [];
  for (const e of targets) {
    const command = baselineCommand(e.test!.command);
    const label = `${e.name}${e.dir === "." ? "" : ` in ${e.dir}/`}`;
    const key = await cacheKey(root, envDir, e.dir, command);
    const cacheFile = key && path.join(envDir, "baselines", `${key}.json`);
    const cached = cacheFile ? await readFile(cacheFile, "utf8").then((t) => JSON.parse(t) as BaselineRun, () => undefined) : undefined;
    if (cached) {
      runs.push({ ...cached, cached: true });
      progress(`  = ${label}: ${summarize(cached)} (same code as an earlier run)`);
      continue;
    }

    progress(`  ${label}: ${command}`);
    const outcome = await run(command, path.join(root, e.dir), opts.env ?? {}, timeoutS * 1000, opts.signal);
    const parsed = parseTestOutput(outcome.output);
    const status = judge(outcome, parsed);
    const result: BaselineRun = {
      name: e.name,
      dir: e.dir,
      command,
      status,
      ...(parsed && { framework: parsed.framework, counts: parsed.counts, unit: parsed.unit }),
      failing: parsed?.failing ?? [],
      ...(status === "error" && { detail: tail(outcome.output) || "(no output)" }),
      exitCode: outcome.code,
      durationMs: outcome.durationMs,
      cached: false,
    };
    runs.push(result);
    progress(`  ${status === "passed" || status === "no_tests" ? "✓" : "✗"} ${label}: ${summarize(result, timeoutS)}`);
    if (cacheFile && CACHEABLE.includes(status)) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(result));
    }
    if (status === "cancelled") break;
  }

  const clean = before ? await keepClean(root, before, "running the baseline tests") : { restored: [], excluded: [] };
  return { runs, timeoutS, ...clean, durationMs: Date.now() - started };
}

// --- output ----------------------------------------------------------------------

function countText(r: BaselineRun): string {
  const c = r.counts!;
  const unit = r.unit === "packages" ? (n: number) => (n === 1 ? "package" : "packages") : (n: number) => (n === 1 ? "test" : "tests");
  const parts = [
    c.failed && `${c.failed} failed`,
    c.errors && `${c.errors} ${c.errors === 1 ? "error" : "errors"}`,
    c.passed && `${c.passed} passed`,
    c.skipped && `${c.skipped} skipped`,
  ].filter(Boolean);
  return r.status === "passed" && !c.failed && !c.errors ? `all ${c.passed} ${unit(c.passed)} passed${c.skipped ? `, ${c.skipped} skipped` : ""}` : parts.join(", ");
}

/** "3 failed, 120 passed (4.5s)", "did not finish within 120s", ... */
function summarize(r: BaselineRun, timeoutS?: number): string {
  const secs = `${(r.durationMs / 1000).toFixed(1)}s`;
  switch (r.status) {
    case "passed":
    case "failed":
      return r.counts ? `${countText(r)} (${secs})` : `${r.status === "passed" ? "passed" : "failed"}, exit ${r.exitCode} (${secs})`;
    case "no_tests":
      return `no tests were collected (${secs})`;
    case "timed_out":
      return `did not finish within ${timeoutS ?? Math.round(r.durationMs / 1000)}s`;
    case "cancelled":
      return "cancelled";
    case "error":
      return `could not run (exit ${r.exitCode}, ${secs})`;
  }
}

/** The <baseline> block for the task message. */
export function baselineBlock(baseline: Baseline, info: ProjectInfo): string {
  const lines = ["<baseline>", "The tests were run once on the unchanged code, before you started:"];
  for (const r of baseline.runs) {
    const where = r.dir === "." ? "" : ` (in ${r.dir}/)`;
    const head = `- \`${r.command}\`${where}: ${summarize(r, baseline.timeoutS)}`;
    if (r.status === "failed" && r.failing.length) {
      lines.push(`${head}. Already failing before your change (fix them only if the task is about them; do not count them as caused by you):`);
      for (const name of r.failing.slice(0, FAILING_SHOWN)) lines.push(`  - ${name.length > 160 ? `${name.slice(0, 159)}…` : name}`);
      if (r.failing.length > FAILING_SHOWN) lines.push(`  - … and ${r.failing.length - FAILING_SHOWN} more`);
    } else if (r.status === "failed") {
      lines.push(`${head}. Some tests already fail before your change; run them to see which.`);
    } else if (r.status === "timed_out") {
      const one = info.ecosystems.find((e) => e.name === r.name && e.dir === r.dir)?.testOne;
      lines.push(`${head}. Run only the tests related to your change${one ? ` (one test: ${one})` : ""}.`);
    } else if (r.status === "error") {
      lines.push(`${head}. Output:`, ...r.detail!.split("\n").map((l) => `    ${l}`), "  Fix the setup if you can (a missing package, a wrong command), or verify another way and say so in the summary.");
    } else if (r.status === "no_tests") {
      lines.push(`${head}. Check how the project runs its tests.`);
    } else {
      lines.push(`${head}.`);
    }
  }
  lines.push("</baseline>");
  return lines.join("\n");
}

/** The task message with the baseline block in front. */
export function withBaseline(prompt: string, baseline: Baseline | undefined, info: ProjectInfo | undefined): string {
  return baseline && info ? `${baselineBlock(baseline, info)}\n\n${prompt}` : prompt;
}

/** One line for the terminal. */
export function describeBaseline(baseline: Baseline): string {
  const parts = baseline.runs.map((r) => `${r.name}${r.dir === "." ? "" : ` in ${r.dir}/`}: ${summarize(r, baseline.timeoutS)}${r.cached ? " (cached)" : ""}`);
  const kept = baseline.restored.length + baseline.excluded.length ? ` · kept out of git: ${[...baseline.restored, ...baseline.excluded].slice(0, 4).join(", ")}` : "";
  return `Baseline: ${parts.join("; ")}${kept}.`;
}
