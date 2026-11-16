#!/usr/bin/env bash
# Fails if anything that looks like a real credential is in the files git
# would commit, or if a .env file is tracked (spec section 8).
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN='(sk-ant-[A-Za-z0-9_-]{30,}|sk-(proj-)?[A-Za-z0-9_-]{40,}|sk-or-v1-[A-Za-z0-9]{40,}|gsk_[A-Za-z0-9]{40,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})'

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  files=$(git ls-files -co --exclude-standard)
else
  files=$(find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './.tools/*' -not -path './dist/*')
fi

status=0
if [ -n "$files" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    if grep -EnI "$PATTERN" "$f" >/dev/null 2>&1; then
      echo "Possible secret in: $f" >&2
      status=1
    fi
  done <<< "$files"
fi

if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo ".env is tracked by git. Remove it: git rm --cached .env" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "Secret scan: clean."
fi
exit "$status"
