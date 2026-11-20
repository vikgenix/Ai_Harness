# AI Harness

A coding agent for the terminal. Give it a GitHub repository and an issue (or a description of a bug). It clones the repo, finds the relevant code, reproduces the problem, fixes it, runs the tests and commits the fix. It can also open a pull request.

> **Status:** Phases 1–4 done; Phase 5 in progress (pull requests done, `/audit` next). The harness talks to Anthropic, OpenAI, Gemini, Groq and any OpenAI-compatible model, runs an agent loop with eight tools, and fixes GitHub issues or described bugs end to end: repository map, project detection, dependency install, baseline tests, branch, reproduce → fix → verify, self-review, commit, optionally inside a Docker sandbox, and pushes the fix and opens a pull request when you ask. It runs interactively or headless with exit codes and run records. See [Roadmap](#roadmap).

## Quick start

```bash
export AI_API_KEY="<your key>"   # Anthropic, OpenAI, Gemini, Groq or any OpenAI-compatible key
make setup                       # installs dependencies (downloads Node.js locally if needed)
make ping                        # optional: one tiny request to check the key and model
make run                         # starts the interactive harness
```

Inside the harness, type a request about the code in the working directory (by default the directory you started in), or use a command:

```
/repo https://github.com/owner/project   # clone it and work in the clone
/repo owner/project                      # same, GitHub shorthand
/repo ../some/local/project              # work in a local directory as-is
/fix 123                      # fix issue #123 of the cloned GitHub repository
/fix owner/project#123        # or an issue URL
/fix parser crashes on empty input   # a task in your own words
/pr                           # push the fix branch and open a pull request (asks first)
/map [words]                  # show the repository map (files related to the words first)
/project                      # show how the project is built and tested
/cost                         # tokens and cost so far
/clear                        # start a new conversation
/config                       # show provider and model
```

`make run REPO=https://github.com/owner/project` clones the repository at start.

### Cloning

`/repo <url>` makes a shallow clone (`--depth 1`) in `workspaces/<owner>__<repo>` and switches to it, so the original is never touched. Opening the same URL again reuses the clone; `make clean` removes all clones. GitHub (`https://`, `owner/repo`, `git@github.com:...`), GitLab, Bitbucket and `file://` URLs are accepted. Git never prompts for a password: a private repository fails with a clear message unless `GITHUB_TOKEN` is set. Ctrl-C cancels a clone.

### Fixing an issue

`/fix 123` reads issue #123 (title, labels, description and up to 30 comments) from the GitHub repository the clone came from, using the public API; `GITHUB_TOKEN` is needed only for private repositories or more than 60 requests an hour. Issue text is written by anyone, so it is handed to the agent fenced as untrusted data, with an instruction not to follow anything in it beyond fixing the problem. Anything that is not an issue reference is taken as a task in your own words.

Then:

1. **Branch.** The working directory must be a git repository without uncommitted changes. The fix goes on a new branch, `harness/fix-123` (or `harness/<first-words-of-the-task>`), created from the default branch, so fixes never stack on each other or touch your branch.
2. **Repository map and project setup.** The task message starts with a map of the repository (its source files with their classes, functions and methods and their line numbers, then the other files by path) and how the project is built and tested (see below).
3. **Agent.** The agent gets a fix-specific system prompt and works alone through *understand → reproduce (failing test first) → fix at the root cause → verify with the tests → finish*. It is told never to run git commit/branch/checkout itself.
4. **Self-review.** The first time the agent finishes with `completed`, the harness holds the finish back and shows it its whole diff, with problems found automatically and a checklist (see below). The agent fixes what it finds and finishes again.
5. **Commit.** If the agent finishes with `completed`, all changes are committed on the branch: the subject is `Fix #123: <issue title>`, the body is the agent's summary (what changed, which tests ran), ending with `Fixes #123`. Caches left by running tests (`__pycache__`, `node_modules`, `.pytest_cache`, ...) are never committed. Your git identity is used if configured, otherwise `AI Harness <ai-harness@localhost>`. If the agent is blocked or hits a limit, the changes stay uncommitted on the branch for you to inspect, and the reason is shown.

After a fix, the chat continues from it, so you can ask follow-up questions or for more changes.

### Pull requests

With `GITHUB_TOKEN` set, `/pr` publishes the fix branch that is checked out. It works on a fix from an earlier session too. It shows the pull request first and pushes nothing without a yes:

```
Pull request to acme/demo (draft):
  harness/fix-7 → main (1 commit)
  Title: Fix #7: Greeting is too quiet
  │ Made the greeting loud. Tests: tests/test_greet.py passed.
  │
  │ Fixes #7
  │
  │ ---
  │ _Prepared by AI Harness, an AI coding agent. Please review it like any other contribution._
Push harness/fix-7 and open this pull request? [y/N] y
Pushed to me/demo:harness/fix-7 (your fork). Opened draft pull request #42: https://github.com/acme/demo/pull/42
```

- **Where it goes:** the branch is pushed to the repository if the token may push there. Otherwise it goes to your fork, which is created if needed, and the pull request is opened from it. Maintainers may edit the branch.
- **Contents:** the title and body come from the fix commit: the agent's summary and `Fixes #N`, which closes the issue when the pull request is merged. A last line says an AI coding agent prepared it.
- **Draft by default** (`pr_draft: true` in `config/model.yaml`), where the repository allows drafts.
- **Never overwrites anything:** no force push. If the remote already has a different branch of the same name, the next free name (`-2`, `-3`, ...) is used. If a pull request is already open for the branch, its link is shown.
- **The token** goes to git for the push command only, as a header in the environment; it is never written to the clone's `.git/config`. It needs write access to contents and pull requests (classic tokens: `public_repo` or `repo`).

Without the UI, `make run REPO=... ISSUE=... PR=1` (`--pr`) pushes and opens the pull request right after the commit, with no question: the flag is the yes.

### Project detection

The harness reads the project files to tell the agent how the tests run, so it does not spend steps finding out:

```
Project: Python (uv) · tests: python3 -m pytest
```

| Ecosystem | Detected from | Test command |
|---|---|---|
| Python | `pyproject.toml`, `setup.py`/`setup.cfg`, `Pipfile`, `requirements*.txt`; package manager from `uv.lock`, `poetry.lock`, `Pipfile`, `pdm.lock` | `python -m pytest` when pytest is configured or listed; `tests/runtests.py` or `manage.py test` (Django); `unittest discover` otherwise |
| Node.js | `package.json` (its `test` script, ignoring npm's placeholder); package manager from `packageManager` or the lockfile | `npm`/`pnpm`/`yarn test`, `bun run test`, or the test framework (vitest, jest, mocha) |
| Go · Rust | `go.mod` · `Cargo.toml` | `go test ./...` · `cargo test` |
| Java/Kotlin | `pom.xml` · `build.gradle(.kts)` | `./mvnw test` or `mvn test` · `./gradlew test` or `gradle test` |
| Ruby · PHP · .NET | `Gemfile` · `composer.json`, `phpunit.xml` · `*.sln`, `*.csproj` | `bundle exec rspec` or `rake test` · `composer test` or `vendor/bin/phpunit` · `dotnet test` |

It also notes how to run a single test, the install command, the required runtime version (`requires-python`, `engines.node`, `go.mod`, ...), test commands used in `.github/workflows`, a Makefile `test` target and `tox.ini`. Projects in first-level directories (`backend/`, `frontend/`) are found too. Finally, it checks which tools (`python3`, `node`, `uv`, `go`, ...) are installed and their versions, so a missing one is flagged up front.

Detection runs nothing from the repository: files are only read, and tool versions are checked from outside the repository (so version files and Go toolchain switches in it have no effect).

### Dependencies

Before the agent starts, `/fix` installs the project's dependencies, so its first test run works instead of failing on imports:

```
Project: Python (uv) · tests: python3 -m pytest
  Python: uv venv --quiet --allow-existing "$VIRTUAL_ENV"; uv sync --frozen; uv pip install --quiet pytest
  ✓ Python: installed in 11.7s
Dependencies: 1 installed (11.7s).
```

| Ecosystem | Installs with | Where |
|---|---|---|
| Python | `uv` when installed (fast; it also fetches a Python that fits `requires-python`), else `python3 -m venv` + pip. `uv sync`, `poetry install` or `pipenv sync` when the project uses them; otherwise `pip install -e .[test extra]`, test dependency groups and requirements files. pytest is added when the tests use it. | a virtualenv in `envs/` (outside the repository) |
| Node.js | `npm ci` (or `npm install`), `pnpm install`, `yarn install`, `bun install` | `node_modules/` |
| Go · Rust | `go mod download` · `cargo fetch` | the tools' own caches |
| Ruby · PHP · .NET | `bundle install` · `composer install` · `dotnet restore` | `envs/` · `vendor/` · NuGet cache |
| Java/Kotlin | not installed beforehand: Maven and Gradle download on the first build | |

The agent's `bash` commands run with the environment active (`VIRTUAL_ENV`, the virtualenv and `node_modules/.bin` first on `PATH`), so `python -m pytest` and `pip install` use the virtualenv, not the system Python. The `<project>` block tells the agent what was installed, and for a failed install, the command and the end of its output.

- **The repository stays clean.** Lockfiles the install rewrote are restored, and new files it made (`*.egg-info`, `node_modules/` without a `.gitignore`, ...) are added to `.git/info/exclude`, so they never end up in the fix commit.
- **Fast the second time.** An install is skipped when the project files (`pyproject.toml`, lockfiles, `package.json`, ...) have not changed since the last successful one. Reopening the repository with `/repo` in a later session uses the environment again.
- **Bounded.** Each install command stops after `install_timeout_s` (default 600). A failed install never stops the fix. Ctrl-C skips the rest of the install. Set `install_deps: false` in `config/model.yaml` to turn it off.
- **Same trust as running the tests.** Installing runs the project's build code (`setup.py`, install scripts), as running its tests does; the harness's API keys and tokens are removed from its environment. For untrusted repositories, use the [Docker sandbox](#docker-sandbox).

`make clean` removes `envs/`.

### Baseline

Next, `/fix` runs the detected test command once on the unchanged code, so the agent knows whether the tests run at all and which ones already fail. It then doesn't chase failures it didn't cause, or think it broke them:

```
  Python: python3 -m pytest -rfE --continue-on-collection-errors
  ✗ Python: 1 failed, 1 error, 1 passed (0.2s)
Baseline: Python: 1 failed, 1 error, 1 passed (0.2s).
```

The agent gets the result in a `<baseline>` block:

```
- `python3 -m pytest -rfE --continue-on-collection-errors`: 1 failed, 1 error, 1 passed (0.2s). Already failing before your change (...):
  - tests/test_math.py::test_known_bug - AssertionError: assert 'A' == 'a'
  - tests/test_broken.py - ModuleNotFoundError: No module named 'not_a_real_module'
```

- **Counts and failing tests** are read from the output of pytest, unittest (and Django), cargo, `go test`, jest, vitest, `node --test`, mocha, RSpec, PHPUnit, Maven, Gradle and `dotnet test`. For pytest, the harness adds `-rfE` (failing tests with their reason) and `--continue-on-collection-errors` (one broken test file does not stop the rest).
- **Could not run:** the agent gets the end of the output (a missing module, a wrong command) and is told to fix the setup or verify another way.
- **Slow suites** are stopped after `baseline_timeout_s` (default 120). The agent is then told to run only the tests near its change, with the command for a single test.
- **Cached** per commit, command and installed dependencies, so a second `/fix` of the same code takes no time.
- **The repository stays clean:** files the tests change or leave behind are restored or added to `.git/info/exclude`, as for the install.

The tests run with the installed dependencies, and without the harness's API keys. Ctrl-C skips the baseline. Set `baseline_tests: false` in `config/model.yaml` to turn it off.

### Docker sandbox

By default, commands run on your machine with your user's rights; the `bash` tool's refusals are a guard rail, not a wall. For a repository you don't trust, run them in a Docker container instead:

```bash
make run SANDBOX=docker REPO=owner/project TASK="..."   # one run
# or for good: sandbox: docker in config/model.yaml
```

```
Sandbox: Docker container ai-harness-pallets__click-196474b7 (python:3.12-slim-bookworm, network on).
Project: Python (uv) · tests: python3 -m pytest · not installed: uv
  Python: python3 -m venv "$VIRTUAL_ENV"; python -m pip install --quiet --disable-pip-version-check -e .; ...
  ✓ Python: installed in 8.0s
```

- **What runs inside:** the agent's `bash` commands, the dependency install and the baseline tests. The file tools and git still run outside, on the same files.
- **What it sees:** only the repository and its dependency environment, mounted at the same paths as outside, so paths in error messages match the files the agent edits. Your home directory, other projects and the harness's API keys are not there.
- **Locked down:** it runs as your user (files it writes stay yours), with all Linux capabilities dropped, `no-new-privileges` and a process limit. Network access is on by default, since installs need it; `sandbox_network: false` turns it off.
- **The image** is picked from the project: `python:3.12-slim-bookworm` (or the version `requires-python` asks for), `node:22-bookworm-slim`, `golang:<go.mod version>-bookworm`, `rust:1-slim-bookworm`, Maven, Gradle, Ruby, PHP (`composer:2`), .NET, else `debian:bookworm-slim`. Set `sandbox_image` to use your own (with the project's tools installed). An image is pulled on first use.
- **Separate environments:** dependencies installed in the container go in `envs/docker/<image>/`, since a Linux virtualenv does not work outside it. Package caches (pip, npm, Go, Cargo, Maven, Gradle) are kept there too, so a second container installs quickly. The tool versions in the `<project>` block are the container's.
- **Cleaned up:** one container per fix, or per repository in the interactive session. It is removed when the fix ends or the harness exits, and leftovers of a killed harness are removed on the next start. A timeout or Ctrl-C kills every process the command started in the container, background ones included.
- **Docker is required:** if it is not installed or not running, the run stops with exit code 2 before making a branch.

Slim images lack some tools (git, `less`, compilers). The baseline shows the effect: tests that need them already fail there, so the agent does not blame itself for them.

### Self-review

Agents often finish with a working fix plus things that should not be committed: a `print` left from debugging, a `repro.py` scratch script, a reformatted file, or no regression test. Before a fix is accepted, the agent sees its whole diff against the base branch (new files included, caches left out) and what the harness found automatically:

| Check | Example |
|---|---|
| Debugging leftovers in added lines | `print(`, `console.log(`, `breakpoint()`, `pdb`, `debugger`, `dbg!`, TODO/FIXME, merge conflict markers (prints are allowed in tests) |
| Temporary files | new `repro*.py`, `scratch*`, `debug*`, `*.orig`, `*.rej`, `*.bak`, `*.log` |
| Formatting-only changes | a file whose diff is empty when whitespace is ignored |
| Tests | no test file added or changed; a test file deleted; fewer assertion lines than before |
| Scope | more than 8 non-test files changed |

The review runs in the same conversation, so it costs one extra step on an already-cached prompt rather than a separate model call. If the agent changes files after the review and problems remain, it is reviewed once more; after that the finish is accepted. It is skipped for `blocked`, and when the step or cost limit would leave no room to act on it. Set `self_review: false` in `config/model.yaml` to turn it off. The run record keeps the findings.

### Repository map

Without a map, an agent spends its first steps listing directories and opening files to find its way around. The map gives it that overview up front, in one cached message, so it can go straight to the right lines:

```
src/click/core.py:
  2232: class Parameter(ABC)
  2852:   def resolve_envvar_value(self, ctx: Context) -> str | None
  3041: class Option(Parameter)
  3211:   def is_bool_flag(self) -> bool
  …
Other files:
  ./: README.md, pyproject.toml, tox.ini
  tests/: conftest.py, test_options.py, ...
```

- **Symbols** come from [tree-sitter](https://tree-sitter.github.io/) grammars compiled to WebAssembly (no native build on install) for Python, JavaScript, TypeScript/TSX, Go, Rust, Java, C#, Ruby, PHP and C/C++. Each symbol is shown as its signature on one line. Files in other languages are listed by path.
- **Size**: about `repo_map_tokens` tokens (default 3000, set in `config/model.yaml`; `0` turns the map off). Files are listed using `.gitignore`, like the tools.
- **Ranking**: when the repository does not fit, the files that look most related to the task come first. A file ranks higher when the task mentions its name or path, or names its functions and classes. Words that appear in many files (like `model` in Django) count less, and tests rank below the code they test. Big files are trimmed to the symbols the task mentions, their classes and public names, instead of being dropped.
- **Speed**: the map takes about 0.2 s for a repository of a few hundred files and about 2 s for Django (7,000 files). Parsing stops at 1,500 files or 8 s, whichever comes first.

### Without the UI

```
make run REPO=https://github.com/owner/project ISSUE=123
make run REPO=owner/project TASK="parser crashes on empty input"
make run REPO=../local/project TASK="..."
make run REPO=owner/project ISSUE=123 PR=1   # then push and open a pull request
```

Runs the same fix workflow without the interactive session (clone, branch, agent, commit) and prints each step. The exit code tells scripts what happened: `0` a fix was committed, `1` no fix (the agent was blocked, hit a limit or changed nothing; its changes stay on the branch), `2` a setup problem (clone failed, issue not found, uncommitted changes), `3` the fix was committed but the pull request asked for with `PR=1` could not be opened (no `GITHUB_TOKEN`, no permission, ...). Ctrl-C stops the run cleanly; a second Ctrl-C quits at once.

Every run is saved in `runs/<date>-<time>-<branch>/` (git-ignored, removed by `make clean`):

| File | Content |
|---|---|
| `result.json` | task, branch, status and outcome, summary, commit, changed files, steps, tokens, cost, duration, self-review findings, repository map size, detected project and tools, dependency install results, baseline test results, sandbox image, pull request (link and number, or why it failed) |
| `fix.patch` | the fix commit as a `git format-patch` file, ready for `git am` (only when committed) |
| `transcript.json` | the full conversation with the model, for debugging (the first message holds the repository map) |

| Command | What it does |
|---|---|
| `make setup` | Installs dependencies and builds. Needs only `make`, `bash`, `curl` and `git`. |
| `make run` | Starts the harness (rebuilding first if the source changed). Stops with a clear message if `AI_API_KEY` is not set. With `REPO=` and `ISSUE=` or `TASK=` it runs one fix without the UI. `SANDBOX=docker` runs the commands in a [Docker container](#docker-sandbox). |
| `make ping` | Sends one tiny request to check that the key, model and endpoint work. |
| `make test` | Runs the offline test suite (no API key, no network) and a secret scan. |
| `make clean` | Removes build output, run logs, cloned repos, dependency environments and the local Node.js copy. |
| `make clean-env-test` | Runs setup + test in a fresh Ubuntu container (needs Docker). |

## Model configuration

All model settings live in [config/model.yaml](config/model.yaml). The key is only ever read from `AI_API_KEY`, never from a file in the repo.

The provider is chosen in this order:

1. The `AI_PROVIDER` environment variable.
2. `provider:` in `config/model.yaml`.
3. The key's prefix (`provider: auto`, the default):

| Key starts with | Provider |
|---|---|
| `sk-ant-` | Anthropic |
| `gsk_` | Groq |
| `AIza` | Gemini |
| `sk-or-` | OpenRouter (OpenAI-compatible) |
| `sk-` | OpenAI |

For any other OpenAI-compatible endpoint (Ollama, DeepSeek, Together, ...):

```bash
export AI_PROVIDER=openai-compatible AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=qwen3-coder
```

### Repeatable results

`temperature: 0` and a fixed `seed` are set in the config. Each is sent only to models that accept it: the Anthropic API and OpenAI reasoning models reject `temperature`, and Google advises keeping the default on Gemini 3. Limits on steps and cost per task are also in the config.

### Effort, caching and cost

- **`effort`** (`low` … `max`) sets how hard the model thinks. Each adapter translates it: Anthropic `output_config.effort`, OpenAI/Groq `reasoning_effort`, Gemini `thinkingLevel` / `thinkingBudget`.
- **Prompt caching** is on for every provider: explicit `cache_control` for Anthropic, a stable `prompt_cache_key` for OpenAI, and the automatic caches of Gemini and others. The usage line after each reply shows how many tokens came from the cache.
- **Cost** is computed from the `pricing` table in the config (USD per 1M tokens). Models missing from the table still work; their cost shows as unknown.
- **Refusal fallback** (Anthropic): if a safety filter declines a request, the API retries it on another Claude model. Set `refusal_fallback: false` to turn it off.
- **Retries**: rate limits, overloads and network errors are retried by each provider's SDK, up to `limits.max_retries` times. Some hosts (Groq) check tool calls against the tool's schema and reject the whole reply when one does not match, and Gemini can return a malformed call. The harness then tells the model what was wrong and lets it try again, up to 3 times in a row.

## Tools

The agent works in a loop: it asks the model, runs the tools the model calls, sends back the results, and repeats until the model answers. Each tool call is shown as it happens (`→ view_file(path=src/index.ts)`).

| Tool | What it does |
|---|---|
| `view_file` | Reads a file with line numbers. Shows up to 400 lines unless given a range (max 1000), cuts very long lines, and skips binary files. |
| `list_dir` | Shows a directory as a tree with file sizes, 2 levels deep by default (max 5). Lists `.git`, `node_modules`, caches and build output without opening them. Symlinks are shown, never followed. |
| `grep` | Searches file contents: regex or plain text, optional glob (`*.py`, `src/**/*.{js,ts}`), case-insensitive, context lines. In a git repo, files ignored by `.gitignore` are skipped. Shows up to 100 matches. |
| `find_files` | Finds files by name or path: a glob (`*.py`, `tests/**/test_*.ts`, `*.{js,ts}`) or plain text matched anywhere in the path, ignoring case (`config`). Skips files ignored by git. Shows up to 200 paths. |
| `edit_file` | Changes an existing file by replacing exact text (`old_string` → `new_string`). The text must be unique unless `replace_all` is set; a miss explains why (different indentation, copied line numbers). Keeps CRLF line endings and file permissions, writes atomically, never touches `.git/`. Returns the edited lines with their new numbers. |
| `create_file` | Creates a new file (and missing parent directories). Never overwrites: an existing file is an error pointing to `edit_file`. Files starting with `#!` are made executable. Max 1 MB, never inside `.git/`. |
| `bash` | Runs a shell command in the repository root (tests, builds, git status). Fresh shell per call, no input (prompts get EOF), timeout 120s by default (max 600s) that stops the whole process tree. Output keeps the first 10k and last 20k characters, without colour codes. The installed dependencies are active ([Dependencies](#dependencies)); API keys and tokens are removed from the command's environment. Refuses `sudo`, `git push`, `rm` outside the repo or of `.git`, `curl \| sh` and similar. This is a guard rail, not a sandbox: for untrusted repositories, turn on the [Docker sandbox](#docker-sandbox), which runs the commands in a container. |
| `finish` | Ends a task with an outcome (`completed` or `blocked`) and a summary of what changed and how it was verified; the agent loop stops there. Must be called on its own, so the model has seen every tool result (e.g. failing tests) before declaring it is done. Plain questions are just answered. |

Safety and limits:

- Tools only see files inside the working directory. Paths that leave it (`../`, absolute paths, symlinks) are refused.
- Every tool input is checked against the tool's schema before it runs. Mistakes come back to the model as an error it can fix, not a crash.
- Tools from a reply cut off by the output limit are never run.
- A request stops at `limits.max_steps` model calls or `limits.max_cost_usd`, whichever comes first.

## Optional: GitHub access

Set `GITHUB_TOKEN` to clone private repositories and to push fixes and open [pull requests](#pull-requests). The token is passed to git for each command only, never saved in the clone, and is removed from the environment of the agent's commands. Without it, the harness still clones, fixes and commits locally and saves the patch.

## Security

- No credentials are stored in the repo. [.env.example](.env.example) lists the variables with empty values.
- `make test` runs [scripts/check-secrets.sh](scripts/check-secrets.sh), which fails if anything that looks like an API key or GitHub token is in a committed file, or if `.env` is tracked.

## Project layout

```
Makefile              evaluation interface (setup / run / test / clean)
config/model.yaml     provider, model, limits
src/index.ts          entry point
src/config.ts         loads and validates config; reads AI_API_KEY
src/providers.ts      provider list, endpoints, key-prefix detection
src/cli/args.ts       command-line options
src/repo/clone.ts     parses repository URLs, clones into workspaces/
src/repo/map.ts       repository map: tree-sitter symbols, ranked by the task, within a token budget
src/repo/detect.ts    project detection: ecosystems, test commands, installed tools
src/repo/env.ts       dependency install into envs/, keeping the repository clean
src/repo/baseline.ts  baseline test run: test output parsers, cache, the <baseline> block
src/sandbox/docker.ts optional Docker sandbox: image choice, container lifecycle, commands inside it
src/agent/workspace.ts what /fix prepares before the agent: map, project, sandbox, install, baseline
src/headless.ts       fix without the UI: exit codes, run records in runs/
src/agent/            agent loop (model → tools → model ...), prompts, /fix tasks and workflow (branch, self-review, commit)
src/github/issues.ts  reads GitHub issues (REST API, no SDK)
src/github/pr.ts      pushes the fix branch (to a fork if needed) and opens the pull request
src/tools/            tools the agent can call
  registry.ts         looks up tools, validates input, turns failures into results
  view_file.ts        reads files with line numbers
  list_dir.ts         directory tree with sizes
  grep.ts             content search (regex or plain text)
  find_files.ts       find files by glob or name
  edit_file.ts        exact find-and-replace edits
  create_file.ts      new files, never overwrites
  bash.ts             shell commands: timeout, output cap, no secrets, refusals
  finish.ts           ends a task with an outcome and summary
  files.ts            file listing (git-aware) and glob matching, shared by tools
  paths.ts            keeps every path inside the working directory
src/model/            provider-neutral model client
  types.ts            messages, tool calls, usage, ModelClient interface
  anthropic.ts        Anthropic adapter (official SDK)
  openai.ts           OpenAI / Groq / OpenRouter / compatible adapter
  gemini.ts           Gemini adapter
  errors.ts           one error type for all providers
  cost.ts             price table lookup and usage tracking
src/ui/repl.ts        interactive session (replaced by the TUI in Phase 6)
scripts/              Node.js bootstrap, secret scan, clean-environment test
tests/                offline tests (vitest)
```

## Roadmap

| Phase | Scope |
|---|---|
| 1 ✅ | Skeleton, Makefile, config, provider detection, secret scan, clean-environment test |
| 2 🚧 | ✅ Provider adapters (Anthropic, OpenAI-compatible, Gemini), streaming, prompt caching, cost tracking · ✅ agent loop, tool calling, `view_file`, `list_dir`, `grep`, `find_files`, `edit_file`, `create_file`, `bash`, `finish` |
| 3 ✅ | ✅ `/fix` reads GitHub issues or a described task · ✅ fix branch, fix prompt (reproduce → fix → verify), commit · ✅ headless mode with run records · ✅ repo map · ✅ self-review |
| 4 ✅ | ✅ detect the ecosystem, test command and installed tools · ✅ install dependencies in an isolated environment · ✅ baseline test run · ✅ optional Docker sandbox |
| 5 🚧 | ✅ push the fix (forking if needed) and open a pull request, with confirmation · ⬜ `/audit` with duplicate check and confirmation before posting |
| 6 | Full TUI |
| 7 | `make eval` on SWE-bench Lite |
| 8 | Hardening, docs, demo |
