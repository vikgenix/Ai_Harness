import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeProject, detectProject, projectBlock, toolVersion, withProject, type ProjectInfo } from "../../src/repo/detect.js";

let base: string;
let n = 0;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "harness-detect-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A repository made of the given files. */
async function repo(files: Record<string, string>): Promise<string> {
  const root = path.join(base, `r${n++}`);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

/** Fake installed tools: everything is installed at 1.0 except the listed ones. */
const tools =
  (missing: string[] = ["python"]) =>
  async (tool: string) =>
    missing.includes(tool) ? null : "1.0";

async function detect(files: Record<string, string>, missing?: string[]): Promise<ProjectInfo> {
  return detectProject(await repo(files), { versionOf: tools(missing) });
}

describe("detectProject: Python", () => {
  it("uv project with pytest configured, CI and Makefile hints", async () => {
    const info = await detect({
      "pyproject.toml": '[project]\nname = "demo"\nrequires-python = ">=3.10"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      "uv.lock": "",
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - run: |\n          uv sync\n          uv run pytest -q tests\n",
      Makefile: "lint:\n\truff .\ntest:\n\tpytest\n",
    });
    expect(info.ecosystems).toEqual([
      {
        name: "Python",
        dir: ".",
        manifest: "pyproject.toml",
        packageManager: "uv",
        requires: ">=3.10",
        install: "uv sync",
        test: { command: "python3 -m pytest", reason: "pytest is configured in pyproject.toml" },
        testOne: "python3 -m pytest <file>::<test name>",
        tools: ["python3", "uv"],
      },
    ]);
    expect(info.hints).toEqual(["CI runs `uv run pytest -q tests` (.github/workflows/ci.yml)", "the Makefile has a `test` target (make test)"]);
    expect(info.tools).toEqual({ python3: "1.0", uv: "1.0" });
  });

  it("pip project: install command with test extras and dev requirements", async () => {
    const info = await detect({
      "setup.py": "from setuptools import setup\nsetup(name='x', python_requires='>=3.8')\n",
      "pyproject.toml": "[project.optional-dependencies]\ntest = [\"pytest\"]\n",
      "requirements-dev.txt": "pytest\n",
    });
    expect(info.ecosystems[0]).toMatchObject({
      packageManager: "pip",
      install: "pip install -e .[test] -r requirements-dev.txt",
      test: { command: "python3 -m pytest", reason: "pytest is listed in the project files" },
    });
  });

  it.each([
    [{ "setup.py": "", "tests/runtests.py": "" }, "python3 tests/runtests.py"],
    [{ "requirements.txt": "django\n", "manage.py": "" }, "python3 manage.py test"],
    [{ "setup.py": "", "tests/test_x.py": "" }, "python3 -m unittest discover -s tests"],
    [{ "Pipfile": "[dev-packages]\npytest = '*'\n" }, "python3 -m pytest"],
  ])("picks the test runner (%#)", async (files, command) => {
    expect((await detect(files)).ecosystems[0]?.test?.command).toBe(command);
  });

  it("uses `python` when only that is installed (a virtualenv)", async () => {
    const info = await detect({ "pytest.ini": "", "setup.py": "" }, ["python3"]);
    expect(info.ecosystems[0]?.test?.command).toBe("python -m pytest");
    expect(info.tools).toEqual({ python: "1.0" });
  });
});

describe("detectProject: other ecosystems", () => {
  it("Node: package manager from the lockfile, test script, single-file runner", async () => {
    const info = await detect({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^2" }, engines: { node: ">=20" } }),
      "pnpm-lock.yaml": "",
    });
    expect(info.ecosystems[0]).toEqual({
      name: "Node.js",
      dir: ".",
      manifest: "package.json",
      packageManager: "pnpm",
      requires: ">=20",
      install: "pnpm install",
      test: { command: "pnpm test", reason: 'package.json "test" script: vitest run' },
      testOne: "pnpm exec vitest run <file>",
      tools: ["node", "pnpm"],
    });
  });

  it("Node: ignores npm's placeholder test script and falls back to the test framework", async () => {
    const info = await detect({
      "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { jest: "^29" } }),
    });
    expect(info.ecosystems[0]).toMatchObject({ packageManager: "yarn", test: { command: "yarn jest" }, testOne: "yarn jest <file>" });
  });

  it.each([
    ["Go", { "go.mod": "module x\n\ngo 1.22\n" }, { requires: "1.22", test: { command: "go test ./..." } }],
    ["Rust", { "Cargo.toml": '[package]\nname = "x"\nrust-version = "1.75"\n' }, { requires: "1.75", test: { command: "cargo test" } }],
    ["Maven", { "pom.xml": "<project/>", mvnw: "" }, { name: "Java (Maven)", test: { command: "./mvnw -q test" }, tools: ["java"] }],
    ["Gradle", { "build.gradle.kts": "" }, { name: "Java/Kotlin (Gradle)", test: { command: "gradle test" }, tools: ["java", "gradle"] }],
    ["Ruby", { Gemfile: "gem 'rspec'\n" }, { test: { command: "bundle exec rspec" } }],
    ["PHP", { "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }), "phpunit.xml.dist": "" }, { test: { command: "composer test" }, testOne: "vendor/bin/phpunit <file>" }],
    [".NET", { "App.sln": "" }, { name: ".NET", test: { command: "dotnet test" } }],
  ])("%s", async (_name, files, expected) => {
    expect((await detect(files)).ecosystems[0]).toMatchObject(expected);
  });

  it("finds projects in first-level directories, skipping docs and examples", async () => {
    const info = await detect({
      "README.md": "",
      "backend/pyproject.toml": "[tool.pytest.ini_options]\n",
      "frontend/package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "docs/requirements.txt": "sphinx\n",
      "examples/demo/package.json": "{}",
      "scripts/requirements.txt": "requests\n", // a requirements file alone does not count below the root
    });
    expect(info.ecosystems.map((e) => `${e.name} ${e.dir} ${e.test?.command}`)).toEqual(["Python backend python3 -m pytest", "Node.js frontend npm test"]);
  });

  it("reports what is not installed", async () => {
    const info = await detect({ "go.mod": "module x\n" }, ["go"]);
    expect(info.tools).toEqual({ go: null });
    expect(describeProject(info)).toBe("Project: Go · tests: go test ./... · not installed: go");
    expect(projectBlock(info)).toContain("Not installed: go (commands that need them will fail;");
  });

  it("runs nothing from the repository", async () => {
    const root = await repo({
      "package.json": JSON.stringify({ scripts: { test: "touch ran-npm" }, devDependencies: {} }),
      "setup.py": "open('ran-setup', 'w')\n",
      Makefile: "test:\n\ttouch ran-make\n",
    });
    await detectProject(root); // with the real tool lookup
    for (const marker of ["ran-npm", "ran-setup", "ran-make"]) expect(existsSync(path.join(root, marker))).toBe(false);
  });
});

describe("output", () => {
  it("writes a project block for the task message", async () => {
    const info = await detect({ "pyproject.toml": "[tool.pytest.ini_options]\n", "uv.lock": "" }, ["python", "uv"]);
    expect(projectBlock(info)).toBe(
      [
        "<project>",
        "Detected from the project files (check them if a command fails):",
        "- Python (pyproject.toml, package manager uv)",
        "  Tests: python3 -m pytest  (pytest is configured in pyproject.toml)",
        "  One test: python3 -m pytest <file>::<test name>",
        "  Install: uv sync",
        "Installed: python3 1.0",
        "Not installed: uv (commands that need them will fail; say so in the summary if the tests cannot run)",
        "Dependencies may not be installed yet: if the tests fail to import packages, install them first.",
        "</project>",
      ].join("\n"),
    );
    expect(withProject("Fix it", info)).toMatch(/^<project>\n[^]*<\/project>\n\nFix it$/);
    expect(describeProject(info)).toBe("Project: Python (uv) · tests: python3 -m pytest · not installed: uv");
  });

  it("says when nothing was found", async () => {
    const info = await detect({ "README.md": "# hi\n" });
    expect(projectBlock(info)).toBe("<project>\nNo known project files (pyproject.toml, package.json, go.mod, ...) were found. Look at the README for how to build and test.\n</project>");
    expect(describeProject(info)).toBe("Project: no known project files found.");
  });
});

describe("toolVersion", () => {
  it("reads the version of an installed tool, null for a missing one", async () => {
    expect(await toolVersion("node")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await toolVersion("no-such-tool-harness")).toBeNull();
  });
});
