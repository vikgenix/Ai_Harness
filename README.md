# AI Harness

A coding agent for the terminal. Give it a GitHub repository and an issue (or a description of a bug). It clones the repo, finds the relevant code, reproduces the problem, fixes it, runs the tests and commits the fix. It can also open a pull request.

> **Status:** Phase 1 (project skeleton, config, evaluation interface). The agent loop arrives in Phases 2–3. See [Roadmap](#roadmap).

## Quick start

```bash
export AI_API_KEY="<your key>"   # Anthropic, OpenAI, Gemini, Groq or any OpenAI-compatible key
make setup                       # installs dependencies (downloads Node.js locally if needed)
make run                         # starts the interactive harness
```

Inside the harness:

```
/repo https://github.com/owner/project
/fix 123                      # fix issue #123
/fix "parser crashes on empty input"
/config                       # show provider and model
```

Without the UI: `make run REPO=<url> ISSUE=123` or `make run REPO=<url> TASK="..."`.

| Command | What it does |
|---|---|
| `make setup` | Installs dependencies and builds. Needs only `make`, `bash`, `curl` and `git`. |
| `make run` | Starts the harness. Stops with a clear message if `AI_API_KEY` is not set. |
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

`temperature: 0` and a fixed `seed` are set in the config. Each is sent only to providers that accept it; the Anthropic API rejects `temperature`, so it is left out there. Limits on steps and cost per task are also in the config.

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
src/ui/repl.ts        interactive session (replaced by the TUI in Phase 6)
scripts/              Node.js bootstrap, secret scan, clean-environment test
tests/                offline tests (vitest)
```

## Roadmap

| Phase | Scope |
|---|---|
| 1 ✅ | Skeleton, Makefile, config, provider detection, secret scan, clean-environment test |
| 2 | Provider adapters (Anthropic, OpenAI-compatible, Gemini), agent loop, tools, prompt caching, cost tracking |
| 3 | `/fix` workflow: clone, repo map, reproduce, fix, test, self-review, commit |
| 4 | Installing the target repo's dependencies and detecting its test command |
| 5 | GitHub: push, PR, `/audit` with duplicate check and confirmation before posting |
| 6 | Full TUI |
| 7 | `make eval` on SWE-bench Lite |
| 8 | Hardening, docs, demo |
