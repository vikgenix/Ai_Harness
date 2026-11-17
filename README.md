# AI Harness

A coding agent for the terminal. Give it a GitHub repository and an issue (or a description of a bug). It clones the repo, finds the relevant code, reproduces the problem, fixes it, runs the tests and commits the fix. It can also open a pull request.

> **Status:** Phase 2 in progress. The harness talks to Anthropic, OpenAI, Gemini, Groq and any OpenAI-compatible model (streaming, prompt caching, cost tracking), and runs an agent loop with tool calling. The first tools, `view_file` and `list_dir`, are in; more tools are added one at a time. See [Roadmap](#roadmap).

## Quick start

```bash
export AI_API_KEY="<your key>"   # Anthropic, OpenAI, Gemini, Groq or any OpenAI-compatible key
make setup                       # installs dependencies (downloads Node.js locally if needed)
make ping                        # optional: one tiny request to check the key and model
make run                         # starts the interactive harness
```

Inside the harness, type a request about the code in the working directory (by default the directory you started in), or use a command:

```
/repo ../some/local/project   # work in a local directory
/repo https://github.com/owner/project
/fix 123                      # fix issue #123
/fix "parser crashes on empty input"
/cost                         # tokens and cost so far
/clear                        # start a new conversation
/config                       # show provider and model
```

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

Safety and limits:

- Tools only see files inside the working directory. Paths that leave it (`../`, absolute paths, symlinks) are refused.
- Every tool input is checked against the tool's schema before it runs. Mistakes come back to the model as an error it can fix, not a crash.
- Tools from a reply cut off by the output limit are never run.
- A request stops at `limits.max_steps` model calls or `limits.max_cost_usd`, whichever comes first.

## Optional: GitHub access

Set `GITHUB_TOKEN` to let the harness push branches, open pull requests and post issues. Without it, the harness still clones, fixes and commits locally and saves the patch.

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
src/agent/            agent loop (model → tools → model ...) and system prompt
src/tools/            tools the agent can call
  registry.ts         looks up tools, validates input, turns failures into results
  view_file.ts        reads files with line numbers
  list_dir.ts         directory tree with sizes
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
| 2 🚧 | ✅ Provider adapters (Anthropic, OpenAI-compatible, Gemini), streaming, prompt caching, cost tracking · ✅ agent loop, tool calling, `view_file`, `list_dir` · ⬜ `search`, `find_files`, `edit_file`, `create_file`, `bash`, `finish` |
| 3 | `/fix` workflow: clone, repo map, reproduce, fix, test, self-review, commit |
| 4 | Installing the target repo's dependencies and detecting its test command |
| 5 | GitHub: push, PR, `/audit` with duplicate check and confirmation before posting |
| 6 | Full TUI |
| 7 | `make eval` on SWE-bench Lite |
| 8 | Hardening, docs, demo |
