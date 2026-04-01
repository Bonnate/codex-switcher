#!/usr/bin/env sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

APP_BUNDLE="$PWD/src-tauri/target/release/bundle/macos/Codex Switcher.app"
APP_BIN="$PWD/src-tauri/target/release/codex-switcher"

if [ -d "$APP_BUNDLE" ]; then
  echo "[Codex Switcher] Launching macOS app bundle..."
  open "$APP_BUNDLE"
  exit 0
fi

if [ -f "$APP_BIN" ]; then
  echo "[Codex Switcher] Launching release executable..."
  nohup "$APP_BIN" >/dev/null 2>&1 &
  exit 0
fi

echo "[Codex Switcher] Release build was not found."
echo "Run ./build-macos.sh first."
exit 1
