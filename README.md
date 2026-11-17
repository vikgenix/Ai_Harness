# AI Harness

A coding agent for the terminal. Give it a GitHub repository and an issue (or a description of a bug). It clones the repo, finds the relevant code, reproduces the problem, fixes it, runs the tests and commits the fix. It can also open a pull request.

> **Status:** Phase 2 in progress. The harness talks to Anthropic, OpenAI, Gemini, Groq and any OpenAI-compatible model (streaming, prompt caching, cost tracking), and runs an agent loop with tool calling. All Phase 2 tools are in: `view_file`, `list_dir`, `search`, `find_files`, `edit_file`, `create_file`, `bash` and `finish`. See [Roadmap](#roadmap).

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
2. **Agent.** The agent gets a fix-specific system prompt and works alone through *understand → reproduce (failing test first) → fix at the root cause → verify with the tests → finish*. It is told never to run git commit/branch/checkout itself.
3. **Commit.** If the agent finishes with `completed`, all changes are committed on the branch: the subject is `Fix #123: <issue title>`, the body is the agent's summary (what changed, which tests ran), ending with `Fixes #123`. Caches left by running tests (`__pycache__`, `node_modules`, `.pytest_cache`, ...) are never committed. Your git identity is used if configured, otherwise `AI Harness <ai-harness@localhost>`. If the agent is blocked or hits a limit, the changes stay uncommitted on the branch for you to inspect, and the reason is shown.

After a fix, the chat continues from it, so you can ask follow-up questions or for more changes.

Without the UI: `make run REPO=<url> ISSUE=123` or `make run REPO=<url> TASK="..."`.

| Command | What it does |
|---|---|
| `make setup` | Installs dependencies and builds. Needs only `make`, `bash`, `curl` and `git`. |
| `make run` | Starts the harness. Stops with a clear message if `AI_API_KEY` is not set. |
| `make ping` | Sends one tiny request to check that the key, model and endpoint work. |
| `make test` | Runs the offline test suite (no API key, no network) and a secret scan. |
| `make clean` | Removes build output, run logs, cloned repos and the local Node.js copy. |
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
- **Retries**: rate limits, overloads and network errors are retried by each provider's SDK, up to `limits.max_retries` times.

## Tools

The agent works in a loop: it asks the model, runs the tools the model calls, sends back the results, and repeats until the model answers. Each tool call is shown as it happens (`→ view_file(path=src/index.ts)`).

| Tool | What it does |
|---|---|
| `view_file` | Reads a file with line numbers. Shows up to 400 lines unless given a range (max 1000), cuts very long lines, and skips binary files. |
| `list_dir` | Shows a directory as a tree with file sizes, 2 levels deep by default (max 5). Lists `.git`, `node_modules`, caches and build output without opening them. Symlinks are shown, never followed. |
| `search` | Searches file contents like grep: regex or plain text, optional glob (`*.py`, `src/**/*.{js,ts}`), case-insensitive, context lines. In a git repo, files ignored by `.gitignore` are skipped. Shows up to 100 matches. |
| `find_files` | Finds files by name or path: a glob (`*.py`, `tests/**/test_*.ts`, `*.{js,ts}`) or plain text matched anywhere in the path, ignoring case (`config`). Skips files ignored by git. Shows up to 200 paths. |
| `edit_file` | Changes an existing file by replacing exact text (`old_string` → `new_string`). The text must be unique unless `replace_all` is set; a miss explains why (different indentation, copied line numbers). Keeps CRLF line endings and file permissions, writes atomically, never touches `.git/`. Returns the edited lines with their new numbers. |
| `create_file` | Creates a new file (and missing parent directories). Never overwrites: an existing file is an error pointing to `edit_file`. Files starting with `#!` are made executable. Max 1 MB, never inside `.git/`. |
| `bash` | Runs a shell command in the repository root (tests, builds, git status). Fresh shell per call, no input (prompts get EOF), timeout 120s by default (max 600s) that stops the whole process tree. Output keeps the first 10k and last 20k characters, without colour codes. API keys and tokens are removed from the command's environment. Refuses `sudo`, `git push`, `rm` outside the repo or of `.git`, `curl \| sh` and similar. This is a guard rail, not a sandbox: for untrusted repositories, run the harness in a container. |
| `finish` | Ends a task with an outcome (`completed` or `blocked`) and a summary of what changed and how it was verified; the agent loop stops there. Must be called on its own, so the model has seen every tool result (e.g. failing tests) before declaring it is done. Plain questions are just answered. |

Safety and limits:

- Tools only see files inside the working directory. Paths that leave it (`../`, absolute paths, symlinks) are refused.
- Every tool input is checked against the tool's schema before it runs. Mistakes come back to the model as an error it can fix, not a crash.
- Tools from a reply cut off by the output limit are never run.
- A request stops at `limits.max_steps` model calls or `limits.max_cost_usd`, whichever comes first.

## Optional: GitHub access

Set `GITHUB_TOKEN` to clone private repositories (the token is passed to git for that command only, never saved in the clone), and later to push branches, open pull requests and post issues. Without it, the harness still clones, fixes and commits locally and saves the patch.

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
src/agent/            agent loop (model → tools → model ...), prompts, /fix tasks and workflow (branch, commit)
src/github/issues.ts  reads GitHub issues (REST API, no SDK)
src/tools/            tools the agent can call
  registry.ts         looks up tools, validates input, turns failures into results
  view_file.ts        reads files with line numbers
  list_dir.ts         directory tree with sizes
  search.ts           grep-style content search
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
| 2 🚧 | ✅ Provider adapters (Anthropic, OpenAI-compatible, Gemini), streaming, prompt caching, cost tracking · ✅ agent loop, tool calling, `view_file`, `list_dir`, `search`, `find_files`, `edit_file`, `create_file`, `bash`, `finish` |
| 3 🚧 | ✅ `/fix` reads GitHub issues or a described task · ✅ fix branch, fix prompt (reproduce → fix → verify), commit · ⬜ repo map, self-review |
| 4 | Installing the target repo's dependencies and detecting its test command |
| 5 | GitHub: push, PR, `/audit` with duplicate check and confirmation before posting |
| 6 | Full TUI |
| 7 | `make eval` on SWE-bench Lite |
| 8 | Hardening, docs, demo |
