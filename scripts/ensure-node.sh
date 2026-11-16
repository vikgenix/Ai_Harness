#!/usr/bin/env bash
# Makes sure a supported Node.js is available. If the system has none (or an
# unsupported one), downloads a portable copy into .tools/node.
# No sudo, nothing installed globally.
set -euo pipefail

SUPPORTED="^22.12 || ^24 || >=26"   # matches package.json "engines" (set by vitest)
NODE_VERSION="v24.11.0"             # LTS used when a local copy must be downloaded
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.tools/node"

supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const [a, b] = process.versions.node.split(".").map(Number);
    process.exit((a === 22 && b >= 12) || a === 24 || a >= 26 ? 0 : 1);
  ' 2>/dev/null
}

if supported; then
  echo "Node.js $(node -v) found."
  exit 0
fi

case "$(uname -s)" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS $(uname -s). Install Node.js $SUPPORTED manually." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported CPU $(uname -m). Install Node.js $SUPPORTED manually." >&2; exit 1 ;;
esac

name="node-$NODE_VERSION-$os-$arch"
url="https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz"
echo "No supported Node.js ($SUPPORTED) found. Downloading $NODE_VERSION into .tools/ ..."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp/node.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$tmp/node.tar.gz"
else
  echo "Need curl or wget to download Node.js." >&2; exit 1
fi
tar -xzf "$tmp/node.tar.gz" -C "$tmp"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$tmp/$name" "$DEST"
echo "Installed $("$DEST/bin/node" -v) at .tools/node"
