@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title IVAC Auto Extract

REM --- check Node ---
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js pawa jay ni. https://nodejs.org theke LTS install korun.
  echo.
  pause
  exit /b 1
)

REM --- auto-detect bundle = biggest .js that is NOT a tool/output script ---
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
  echo [X] Ei folder e kono bundle .js pawa jay ni.
  echo     IVAC index.js file ta ei folder e rakhun, tarpor abar double-click korun.
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo  Bundle detected : !BUNDLE!
echo  Size            : !MAXSIZE! bytes
echo ============================================================
echo.

echo [1/2] ===== CIPHER extract =====
node extract_ciphers.js "!BUNDLE!"
echo.
echo [2/2] ===== FETCH / dg-epay extract =====
node extract_fetch.js "!BUNDLE!"
echo.
echo ============================================================
echo  Done. Output files ei folder e toiri holo (cipher.js / fetch-api.js).
echo ============================================================
echo.
pause
