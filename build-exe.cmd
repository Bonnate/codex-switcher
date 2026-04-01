@echo off
setlocal
cd /d "%~dp0"

echo [Codex Switcher] Building Windows executable with Tauri...
call npx pnpm tauri build --no-bundle
if errorlevel 1 exit /b %errorlevel%

echo.
echo [Codex Switcher] Build completed:
echo %CD%\src-tauri\target\release\codex-switcher.exe
exit /b 0
