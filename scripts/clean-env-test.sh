#!/usr/bin/env bash
# Simulates the evaluator: copies only the files git would commit into a fresh
# Ubuntu container with no Node.js, then runs make setup, make test and a
# config check (with a dummy key, so no API call is made).
set -euo pipefail
cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "Docker is required for this check." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start Docker and retry." >&2; exit 1; }

echo "==> Building a clean Ubuntu environment (this takes a minute)..."
git ls-files -co --exclude-standard -z \
  | tar --null -T - -cf - \
  | docker run --rm -i ubuntu:24.04 bash -c '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >/dev/null
      apt-get install -y -qq make curl git ca-certificates >/dev/null
      mkdir /work && cd /work && tar -xf -
      make setup
      make test
      AI_API_KEY=sk-ant-dummy-key-for-config-check node dist/index.js --check
      echo "==> Clean-environment check PASSED"
    '
