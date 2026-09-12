@echo off
REM ── Bundle Analyzer (Windows) ─────────────────────────────────────────────
REM Usage:
REM   1. Keep this .bat next to bundle-analyzer.js
REM   2. Drag your bundle .js file onto this .bat  (or run: analyze.bat bundle.js)
REM ──────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

if "%~1"=="" (
  set /p BUNDLE="Bundle file path: "
) else (
  set "BUNDLE=%~1"
)

if not exist "%BUNDLE%" (
  echo [ERROR] File not found: %BUNDLE%
  echo.
  pause
  exit /b 1
)

echo Analyzing: %BUNDLE%
echo.
node "%~dp0bundle-analyzer.js" "%BUNDLE%"

echo.
echo ==== done ====
pause
