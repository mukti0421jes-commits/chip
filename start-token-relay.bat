@echo off
REM ============================================================
REM  start-token-relay.bat  — runs the RJ Turnstile token relay.
REM  Keep this next to token-relay.js. Double-click to start.
REM  Farm browser pushes tokens here; RJ SLOT browser pulls them.
REM ============================================================
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH. Install from https://nodejs.org
  pause
  exit /b 1
)
echo Starting RJ Token Relay on port 8787 ...
echo   Same machine  -> use  http://127.0.0.1:8787  in both userscripts
echo   Other machine -> use  http://THIS-PC-LAN-IP:8787  (open the port in firewall)
echo.
node token-relay.js
pause
