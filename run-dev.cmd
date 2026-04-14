@echo off
setlocal
cd /d "%~dp0"

echo [Codex Switcher] Starting development mode...
call node .\scripts\tauri.mjs dev
exit /b %errorlevel%
