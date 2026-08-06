@echo off
REM ====================================================================
REM  run-fetch.bat
REM  Auto-detects the daily web bundle (largest .js in this folder,
REM  excluding the known helper/output files) and runs
REM  extract_fetch.js on it. No need to edit anything when the
REM  bundle's name changes.
REM
REM  Keep this file in the autocheck folder (next to extract_fetch.js).
REM ====================================================================

cd /d "%USERPROFILE%\Desktop\autocheck"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)

REM List .js files biggest-first, skip known helper/output files; first hit = the bundle.
set "BUNDLE="
for /f "delims=" %%F in ('dir /b /a-d /o-s *.js 2^>nul ^| findstr /v /i /b /c:"extract_fetch.js" /c:"extract_ciphers.js" /c:"cipher.js" /c:"cipher-server.js" /c:"start-cipher-hidden.js" /c:"fetch-api.js" /c:"watcher.js"') do (
    if not defined BUNDLE set "BUNDLE=%%F"
)

if not defined BUNDLE (
    echo [ERROR] No bundle .js found in this folder.
    echo Put the daily web bundle .js here and try again.
    pause
    exit /b 1
)

echo Detected bundle: %BUNDLE%
echo Running extract_fetch...
echo.
node extract_fetch.js "%BUNDLE%"

echo.
echo [DONE] fetch-api.js has been regenerated (dg-epay + slot + endpoints).
pause
