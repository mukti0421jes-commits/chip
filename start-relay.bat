@echo off
REM ============================================================
REM  RJ SLOT proxy relay launcher
REM  ব্যবহার: এই ফাইলটা proxy-relay.js এর পাশে রাখুন, ডাবল-ক্লিক করুন।
REM ============================================================
title RJ Proxy Relay
cd /d "%~dp0"

REM --- Node আছে কিনা দেখা ---
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [!] Node.js paoa jayni.
    echo      Node install korun: https://nodejs.org  (LTS version)
    echo      tarpor abar ei file double-click korun.
    echo.
    pause
    exit /b 1
)

REM --- relay ফাইল খোঁজা (proxy-relay.js othoba proxyrelay.js) ---
set "RELAY="
if exist "%~dp0proxy-relay.js" set "RELAY=%~dp0proxy-relay.js"
if not defined RELAY if exist "%~dp0proxyrelay.js" set "RELAY=%~dp0proxyrelay.js"

if not defined RELAY (
    echo.
    echo  [!] relay file ei folder e paoa jayni.
    echo      "proxy-relay.js" othoba "proxyrelay.js" ei bat er pashei rakhun.
    echo.
    pause
    exit /b 1
)

echo.
echo  RJ Proxy Relay chalu hocche...
echo  (bondho korte: ei window e Ctrl + C, othoba window close korun)
echo.

node "%RELAY%"

REM relay bondho / crash korle window khola thakbe jate error dekha jay
echo.
echo  Relay bondho hoyeche.
pause
