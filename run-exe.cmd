@echo off
setlocal
cd /d "%~dp0"

set "APP_EXE=%CD%\src-tauri\target\release\codex-switcher.exe"

if not exist "%APP_EXE%" (
  echo [Codex Switcher] Release executable was not found.
  echo Run build-exe.cmd first.
  exit /b 1
)

echo [Codex Switcher] Launching release executable...
start "" "%APP_EXE%"
exit /b 0
