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

REM --- proxy-relay.js আছে কিনা দেখা ---
if not exist "%~dp0proxy-relay.js" (
    echo.
    echo  [!] proxy-relay.js ei folder e nei.
    echo      ei bat file ta proxy-relay.js er pashei rakhun.
    echo.
    pause
    exit /b 1
)

echo.
echo  RJ Proxy Relay chalu hocche...
echo  (bondho korte: ei window e Ctrl + C, othoba window close korun)
echo.

node "%~dp0proxy-relay.js"

REM relay bondho / crash korle window khola thakbe jate error dekha jay
echo.
echo  Relay bondho hoyeche.
pause
