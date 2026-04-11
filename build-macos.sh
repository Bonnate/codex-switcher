#!/usr/bin/env sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

APP_BUNDLE="$PWD/src-tauri/target/release/bundle/macos/Codex Switcher.app"
APP_BIN="$PWD/src-tauri/target/release/codex-switcher"
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/codex-switcher-build.XXXXXX.log")"
trap 'rm -f "$BUILD_LOG"' EXIT INT TERM

echo "[Codex Switcher] Building macOS app bundle with Tauri..."
node ./scripts/tauri.mjs build >"$BUILD_LOG" 2>&1
cat "$BUILD_LOG"

echo
echo "[Codex Switcher] Build completed:"
if [ -d "$APP_BUNDLE" ]; then
  echo "$APP_BUNDLE"
elif [ -f "$APP_BIN" ]; then
  echo "$APP_BIN"
else
  echo "$PWD/src-tauri/target/release"
fi
