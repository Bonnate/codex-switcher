#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

cd "$SCRIPT_DIR"
"$SCRIPT_DIR/run-macos.sh" || {
  STATUS=$?
  echo
  echo "[Codex Switcher] Launch failed with exit code $STATUS."
  printf "Press Enter to close..."
  read -r _
  exit "$STATUS"
}

echo
printf "Press Enter to close..."
read -r _
