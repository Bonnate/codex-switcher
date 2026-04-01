@echo off
setlocal
cd /d "%~dp0"

echo [Codex Switcher] Starting development mode...
call npx pnpm tauri dev
exit /b %errorlevel%
