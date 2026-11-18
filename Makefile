# AI Harness: standard evaluation interface.
#
#   export AI_API_KEY="<key>"
#   make setup      install everything (downloads Node.js locally if needed)
#   make run        start the interactive harness
#   make test       run the offline test suite + secret scan
#   make clean      remove generated files
#
# Run without the UI:  make run REPO=<github url> ISSUE=<number|url>
#                      make run REPO=<github url> TASK="<description>"

SHELL := /bin/bash
.DEFAULT_GOAL := help

# A local Node.js (installed by `make setup` only when the system one is
# missing or unsupported) takes priority over the system one. It is set on
# each command line because older make versions (e.g. 3.81 on macOS) ignore
# an exported PATH when they run a simple command directly.
WITH_NODE := PATH="$(CURDIR)/.tools/node/bin:$$PATH"

RUN_ARGS := $(if $(REPO),--repo "$(REPO)") $(if $(ISSUE),--issue "$(ISSUE)") $(if $(TASK),--task "$(TASK)")

.PHONY: help setup run ping test clean check-key check-secrets clean-env-test

help:
	@echo "Targets: setup | run | ping | test | clean | clean-env-test"
	@echo "First:   export AI_API_KEY=\"<your key>\""

setup:
	@echo "==> Setting up AI Harness"
	@./scripts/ensure-node.sh
	@if [ -f package-lock.json ]; then $(WITH_NODE) npm ci --no-audit --no-fund; else $(WITH_NODE) npm install --no-audit --no-fund; fi
	@$(WITH_NODE) npm run --silent build
	@echo "==> Setup complete. Next: make run"

# Rebuilds only when a source file changed since the last build, so `make run`
# never runs stale code after an edit or a git pull.
dist/index.js: $(shell find src -name '*.ts' 2>/dev/null) tsconfig.json package.json
	@test -d node_modules || { echo "Not set up yet. Run: make setup" >&2; exit 1; }
	@$(WITH_NODE) npm run --silent build

run: check-key dist/index.js
	@$(WITH_NODE) node dist/index.js $(RUN_ARGS)

# One tiny request to check that the key, model and endpoint work.
ping: check-key dist/index.js
	@$(WITH_NODE) node dist/index.js --ping

test:
	@echo "==> Running tests"
	@$(WITH_NODE) npm test --silent
	@$(MAKE) --no-print-directory check-secrets

check-key:
	@if [ -z "$$AI_API_KEY" ]; then \
		echo "AI_API_KEY is not set. Run: export AI_API_KEY=\"<your key>\"" >&2; exit 1; \
	fi

check-secrets:
	@./scripts/check-secrets.sh

# Tries setup + test + config check in a fresh Ubuntu container (needs Docker).
clean-env-test:
	@./scripts/clean-env-test.sh

clean:
	rm -rf dist runs workspaces coverage node_modules .tools
