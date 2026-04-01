#!/usr/bin/env sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

APP_BUNDLE="$PWD/src-tauri/target/release/bundle/macos/Codex Switcher.app"
APP_BIN="$PWD/src-tauri/target/release/codex-switcher"
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/codex-switcher-build.XXXXXX.log")"
trap 'rm -f "$BUILD_LOG"' EXIT INT TERM

echo "[Codex Switcher] Building macOS app bundle with Tauri..."
if node ./scripts/tauri.mjs build >"$BUILD_LOG" 2>&1; then
  cat "$BUILD_LOG"
else
  STATUS=$?
  cat "$BUILD_LOG"

  if [ -d "$APP_BUNDLE" ] && grep -q 'TAURI_SIGNING_PRIVATE_KEY' "$BUILD_LOG"; then
    echo
    echo "[Codex Switcher] App bundle was created, but updater signing was skipped because TAURI_SIGNING_PRIVATE_KEY is not configured."
  else
    exit "$STATUS"
  fi
fi

echo
echo "[Codex Switcher] Build completed:"
if [ -d "$APP_BUNDLE" ]; then
  echo "$APP_BUNDLE"
elif [ -f "$APP_BIN" ]; then
  echo "$APP_BIN"
else
  echo "$PWD/src-tauri/target/release"
fi
