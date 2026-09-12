@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js NOT found. Install it from https://nodejs.org then run again.
  echo.
  pause
  exit /b 1
)
REM first run: install Playwright + Chromium (needed for the "browser-e chalao" probe).
if not exist "%~dp0node_modules\playwright" (
  echo First run: installing Playwright + Chromium ^(needs internet, 1-2 min^)...
  call npm install
  call npx playwright install chromium
)
echo.
echo Starting IVAC Node dashboard ...
echo If the browser does not open, go to:  http://localhost:8777
echo (Close this window to stop.)
echo.
node "%~dp0dashboard-server.js"
echo.
pause
