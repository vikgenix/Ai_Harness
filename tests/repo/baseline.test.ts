import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baselineBlock,
  baselineCommand,
  describeBaseline,
  judge,
  parseTestOutput,
  runBaseline,
  withBaseline,
  type BaselineOptions,
  type CommandOutcome,
} from "../../src/repo/baseline.js";
import type { Ecosystem, ProjectInfo } from "../../src/repo/detect.js";

const savedEnv = { ...process.env };
let base: string;
let n = 0;

beforeAll(async () => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  base = await realpath(await mkdtemp(path.join(tmpdir(), "harness-baseline-")));
});

afterAll(async () => {
  process.env = savedEnv;
  await rm(base, { recursive: true, force: true });
});

const gitIn = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: root }).toString();

async function repo(files: Record<string, string>): Promise<string> {
  const root = path.join(base, `r${n++}`);
  execFileSync("mkdir", ["-p", root]);
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  gitIn(root, "init", "-q");
  gitIn(root, "add", ".");
  gitIn(root, "commit", "-qm", "init");
  return root;
}

const project = (test: string, extra: Partial<Ecosystem> = {}): ProjectInfo => ({
  ecosystems: [{ name: "Python", dir: ".", manifest: "pyproject.toml", test: { command: test, reason: "" }, testOne: "python3 -m pytest <file>::<test name>", tools: [], ...extra }],
  hints: [],
  tools: {},
});

describe("parseTestOutput", () => {
  it.each([
    [
      "pytest",
      "tests/test_a.py ..F.\n=========================== short test summary info ===========================\nFAILED tests/test_a.py::test_add - AssertionError: assert 3 == 4\nERROR tests/test_b.py - ModuleNotFoundError: No module named 'yaml'\n==== 1 failed, 3 passed, 2 skipped, 1 xfailed, 1 error in 0.52s ====",
      { framework: "pytest", counts: { passed: 3, failed: 1, errors: 1, skipped: 3 }, failing: ["tests/test_a.py::test_add - AssertionError: assert 3 == 4", "tests/test_b.py - ModuleNotFoundError: No module named 'yaml'"] },
    ],
    ["pytest -q", "........\n109 passed in 0.08s", { framework: "pytest", counts: { passed: 109, failed: 0, errors: 0, skipped: 0 }, failing: [] }],
    [
      "unittest",
      "F.s\n======================================================================\nFAIL: test_add (tests.test_math.MathTest.test_add)\n----------------------------------------------------------------------\nRan 3 tests in 0.001s\n\nFAILED (failures=1, skipped=1)",
      { framework: "unittest", counts: { passed: 1, failed: 1, errors: 0, skipped: 1 }, failing: ["test_add (tests.test_math.MathTest.test_add)"] },
    ],
    [
      "cargo",
      "---- tests::adds stdout ----\nthread panicked\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured\ntest result: ok. 2 passed; 0 failed; 1 ignored; 0 measured",
      { framework: "cargo", counts: { passed: 5, failed: 1, errors: 0, skipped: 1 }, failing: ["tests::adds"] },
    ],
    [
      "go",
      "--- FAIL: TestParse (0.00s)\n    parse_test.go:12: got 1\nFAIL\nFAIL\texample.com/x/parse\t0.01s\nok  \texample.com/x/util\t0.02s\n?   \texample.com/x/cmd\t[no test files]\nFAIL",
      { framework: "go", unit: "packages", counts: { passed: 1, failed: 1, errors: 0, skipped: 0 }, failing: ["TestParse"] },
    ],
    [
      "jest",
      "FAIL src/a.test.js\n  ● math › adds\n\n    expect(received).toBe(expected)\n  ● Console\n\nTests:       1 failed, 1 skipped, 5 passed, 7 total",
      { framework: "jest", counts: { passed: 5, failed: 1, errors: 0, skipped: 1 }, failing: ["math › adds"] },
    ],
    [
      "vitest",
      " FAIL  tests/a.test.ts > math > adds\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 9 passed (10)",
      { framework: "vitest", counts: { passed: 9, failed: 1, errors: 0, skipped: 0 }, failing: ["tests/a.test.ts > math > adds"] },
    ],
    ["node:test", "not ok 2 - parses dates\n# tests 5\n# pass 4\n# fail 1\n# skipped 0", { framework: "node:test", counts: { passed: 4, failed: 1, errors: 0, skipped: 0 }, failing: ["parses dates"] }],
    ["mocha", "  4 passing (12ms)\n  1 pending\n  2 failing\n\n  1) parser\n  2) dates", { framework: "mocha", counts: { passed: 4, failed: 2, errors: 0, skipped: 1 }, failing: ["parser", "dates"] }],
    ["rspec", "10 examples, 2 failures, 1 pending\n\nrspec ./spec/a_spec.rb:12 # A adds", { framework: "rspec", counts: { passed: 7, failed: 2, errors: 0, skipped: 1 }, failing: ["./spec/a_spec.rb:12 # A adds"] }],
    ["phpunit", "1) Tests\\MathTest::testAdd\nFAILURES!\nTests: 12, Assertions: 30, Failures: 2, Errors: 1.", { framework: "phpunit", counts: { passed: 9, failed: 2, errors: 1, skipped: 0 }, failing: ["Tests\\MathTest::testAdd"] }],
    ["maven", "[ERROR]   CalcTest.adds:12 expected 4\n[INFO] Results:\n[ERROR] Tests run: 12, Failures: 1, Errors: 0, Skipped: 2", { framework: "maven", counts: { passed: 9, failed: 1, errors: 0, skipped: 2 }, failing: ["CalcTest.adds"] }],
    ["gradle", "CalcTest > adds() FAILED\n12 tests completed, 1 failed, 2 skipped", { framework: "gradle", counts: { passed: 9, failed: 1, errors: 0, skipped: 2 }, failing: ["CalcTest > adds()"] }],
    ["dotnet", "  Failed Calc.Tests.Adds [12 ms]\nFailed!  - Failed:     1, Passed:    11, Skipped:     0, Total:    12", { framework: "dotnet", counts: { passed: 11, failed: 1, errors: 0, skipped: 0 }, failing: ["Calc.Tests.Adds"] }],
  ])("%s", (_name, output, expected) => {
    expect(parseTestOutput(output)).toEqual({ unit: "tests", ...expected });
  });

  it("pytest: gives a collection error its reason", () => {
    const output = [
      "____________________ ERROR collecting tests/test_broken.py _____________________",
      "ImportError while importing test module '/x/tests/test_broken.py'.",
      "tests/test_broken.py:1: in <module>",
      "    import not_a_real_module",
      "E   ModuleNotFoundError: No module named 'not_a_real_module'",
      "=================================== FAILURES ===================================",
      "=========================== short test summary info ============================",
      "FAILED tests/test_math.py::test_known_bug - AssertionError: assert 'A' == 'a'",
      "ERROR tests/test_broken.py",
      "===================== 1 failed, 1 passed, 1 error in 0.02s =====================",
    ].join("\n");
    expect(parseTestOutput(output)?.failing).toEqual(["tests/test_math.py::test_known_bug - AssertionError: assert 'A' == 'a'", "tests/test_broken.py - ModuleNotFoundError: No module named 'not_a_real_module'"]);
  });

  it("knows no summary when there is none", () => {
    expect(parseTestOutput("Traceback (most recent call last):\nModuleNotFoundError: No module named 'x'")).toBeUndefined();
    expect(parseTestOutput("===== no tests ran in 0.01s =====")?.counts).toEqual({ passed: 0, failed: 0, errors: 0, skipped: 0 });
  });
});

describe("baselineCommand and judge", () => {
  it("asks pytest for the failing tests", () => {
    expect(baselineCommand("python3 -m pytest")).toBe("python3 -m pytest -rfE --continue-on-collection-errors");
    expect(baselineCommand("python -m pytest -ra")).toBe("python -m pytest -ra --continue-on-collection-errors");
    expect(baselineCommand("npm test")).toBe("npm test");
  });

  const outcome = (code: number | null, extra: Partial<CommandOutcome> = {}): CommandOutcome => ({ output: "", code, timedOut: false, cancelled: false, durationMs: 1, ...extra });
  it("tells passing, failing, broken and slow suites apart", () => {
    const failing = parseTestOutput("1 failed, 2 passed in 0.1s");
    expect(judge(outcome(0), parseTestOutput("2 passed in 0.1s"))).toBe("passed");
    expect(judge(outcome(1), failing)).toBe("failed");
    expect(judge(outcome(2), undefined)).toBe("error");
    expect(judge(outcome(5), parseTestOutput("no tests ran in 0.01s"))).toBe("no_tests");
    expect(judge(outcome(null, { timedOut: true }), undefined)).toBe("timed_out");
    expect(judge(outcome(null, { cancelled: true }), undefined)).toBe("cancelled");
  });
});

/** A fake test runner that returns `outputs` in turn and records the calls. */
function fakeRun(outputs: Partial<CommandOutcome>[]) {
  const calls: string[] = [];
  const run: BaselineOptions["run"] = async (command) => {
    calls.push(command);
    return { output: "", code: 0, timedOut: false, cancelled: false, durationMs: 1500, ...outputs[calls.length - 1] };
  };
  return { calls, run };
}

const PYTEST_FAILING = "FAILED tests/test_a.py::test_add - AssertionError\nFAILED tests/test_a.py::test_sub - AssertionError\n2 failed, 40 passed in 1.50s";

describe("runBaseline", () => {
  it("runs the tests, tells the agent what already fails, and caches per commit", async () => {
    const root = await repo({ "pyproject.toml": "" });
    const envsDir = path.join(base, "envs-a");
    const lines: string[] = [];
    const first = fakeRun([{ output: PYTEST_FAILING, code: 1 }]);
    const baseline = (await runBaseline(root, project("python3 -m pytest"), { envsDir, run: first.run, onProgress: (l) => lines.push(l), env: { VIRTUAL_ENV: "/v" } }))!;

    expect(first.calls).toEqual(["python3 -m pytest -rfE --continue-on-collection-errors"]);
    expect(baseline.runs[0]).toMatchObject({ status: "failed", framework: "pytest", counts: { passed: 40, failed: 2 }, failing: ["tests/test_a.py::test_add - AssertionError", "tests/test_a.py::test_sub - AssertionError"], cached: false });
    expect(lines).toEqual(["  Python: python3 -m pytest -rfE --continue-on-collection-errors", "  ✗ Python: 2 failed, 40 passed (1.5s)"]);
    expect(describeBaseline(baseline)).toBe("Baseline: Python: 2 failed, 40 passed (1.5s).");
    expect(baselineBlock(baseline, project("x"))).toBe(
      [
        "<baseline>",
        "The tests were run once on the unchanged code, before you started:",
        "- `python3 -m pytest -rfE --continue-on-collection-errors`: 2 failed, 40 passed (1.5s). Already failing before your change (fix them only if the task is about them; do not count them as caused by you):",
        "  - tests/test_a.py::test_add - AssertionError",
        "  - tests/test_a.py::test_sub - AssertionError",
        "</baseline>",
      ].join("\n"),
    );
    expect(withBaseline("Fix it", baseline, project("x"))).toMatch(/^<baseline>\n[^]*<\/baseline>\n\nFix it$/);
    expect(withBaseline("Fix it", undefined, project("x"))).toBe("Fix it");

    // Same commit: from the cache, without running.
    const second = fakeRun([]);
    const again = (await runBaseline(root, project("python3 -m pytest"), { envsDir, run: second.run }))!;
    expect(second.calls).toEqual([]);
    expect(again.runs[0]).toMatchObject({ status: "failed", cached: true });
    expect(describeBaseline(again)).toBe("Baseline: Python: 2 failed, 40 passed (1.5s) (cached).");

    // A new commit runs again.
    await writeFile(path.join(root, "a.py"), "");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-qm", "more");
    const third = fakeRun([{ output: "42 passed in 1.0s" }]);
    expect((await runBaseline(root, project("python3 -m pytest"), { envsDir, run: third.run }))!.runs[0]).toMatchObject({ status: "passed", cached: false });
    expect(third.calls).toHaveLength(1);
  });

  it("explains a suite that cannot run, and does not cache it", async () => {
    const root = await repo({ "pyproject.toml": "" });
    const envsDir = path.join(base, "envs-b");
    const output = "ImportError while loading conftest '/x/conftest.py'.\nModuleNotFoundError: No module named 'hypothesis'";
    const baseline = (await runBaseline(root, project("python3 -m pytest"), { envsDir, run: fakeRun([{ output, code: 4 }]).run }))!;
    expect(baseline.runs[0]).toMatchObject({ status: "error", detail: output, exitCode: 4 });
    expect(baselineBlock(baseline, project("x"))).toContain(
      "- `python3 -m pytest -rfE --continue-on-collection-errors`: could not run (exit 4, 1.5s). Output:\n    ImportError while loading conftest '/x/conftest.py'.\n    ModuleNotFoundError: No module named 'hypothesis'\n  Fix the setup if you can",
    );
    const again = fakeRun([{ output, code: 4 }]);
    await runBaseline(root, project("python3 -m pytest"), { envsDir, run: again.run });
    expect(again.calls).toHaveLength(1);
  });

  it("points a slow suite to single tests", async () => {
    const root = await repo({ "pyproject.toml": "" });
    const baseline = (await runBaseline(root, project("python3 -m pytest"), { envsDir: path.join(base, "envs-c"), timeoutS: 120, run: fakeRun([{ code: null, timedOut: true }]).run }))!;
    expect(baselineBlock(baseline, project("x"))).toContain("- `python3 -m pytest -rfE --continue-on-collection-errors`: did not finish within 120s. Run only the tests related to your change (one test: python3 -m pytest <file>::<test name>).");
  });

  it("does nothing without a test command", async () => {
    expect(await runBaseline(base, project("x", { test: undefined }), { envsDir: path.join(base, "envs-d") })).toBeUndefined();
  });

  it("runs the real command in the ecosystem's directory, and keeps what the tests leave out of git", async () => {
    const root = await repo({
      "run-tests.sh": 'echo changed >> tracked.txt\necho "secret=${AI_API_KEY:-none}" > test-output.log\necho "ok  \texample.com/x\t0.01s"\n',
      "tracked.txt": "original\n",
    });
    process.env.AI_API_KEY = "sk-test-secret";
    try {
      const baseline = (await runBaseline(root, project("sh run-tests.sh"), { envsDir: path.join(base, "envs-e") }))!;
      expect(baseline.runs[0]).toMatchObject({ status: "passed", framework: "go", counts: { passed: 1 }, unit: "packages", exitCode: 0 });
      expect(describeBaseline(baseline)).toMatch(/^Baseline: Python: all 1 package passed \(\d+\.\ds\) · kept out of git: tracked\.txt, test-output\.log\.$/);
      expect(await readFile(path.join(root, "tracked.txt"), "utf8")).toBe("original\n");
      expect(gitIn(root, "status", "--porcelain")).toBe("");
      expect(await readFile(path.join(root, "test-output.log"), "utf8")).toBe("secret=none\n"); // credentials are not passed to the tests
    } finally {
      delete process.env.AI_API_KEY;
    }
  });
});
