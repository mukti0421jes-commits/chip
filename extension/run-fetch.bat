@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title IVAC extract_fetch

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js pawa jay ni. https://nodejs.org theke LTS install korun.
  echo.
  pause
  exit /b 1
)

REM auto-detect bundle = biggest .js that is NOT a tool/output script
set "BUNDLE="
set "MAXSIZE=0"
for %%F in (*.js) do (
  set "SKIP="
  for %%T in (extract_fetch.js extract_ciphers.js cipher.js cipher-server.js fetch-api.js watcher.js run-extract.js auto-extract.js) do (
    if /I "%%~nxF"=="%%T" set "SKIP=1"
  )
  if not defined SKIP (
    if %%~zF GTR !MAXSIZE! (
      set "MAXSIZE=%%~zF"
      set "BUNDLE=%%~nxF"
    )
  )
)

if not defined BUNDLE (
  echo [X] Ei folder e kono bundle .js pawa jay ni. IVAC index.js ekhane rakhun.
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo  Bundle : !BUNDLE!  ^(!MAXSIZE! bytes^)
echo ============================================================
echo.
node extract_fetch.js "!BUNDLE!"
echo.
pause
