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

REM --- relay ফাইল খোঁজা (nam/extension ja-i hok) ---
REM  node extension niye matha ghamay na — content JS holei chole.
set "RELAY="
for %%F in ("%~dp0proxy-relay.js" "%~dp0proxyrelay.js" "%~dp0proxy-relay.js.txt" "%~dp0proxyrelay.js.txt" "%~dp0proxy-relay.txt" "%~dp0proxyrelay.txt" "%~dp0proxy-relay" "%~dp0proxyrelay") do (
    if not defined RELAY if exist "%%~F" set "RELAY=%%~F"
)

if not defined RELAY (
    echo.
    echo  [!] relay file ei folder e paoa jayni.
    echo      ei bat er pashei "proxyrelay.js" ba "proxy-relay.js" rakhun.
    echo.
    echo  Ei folder e ja ache:
    dir /b "%~dp0"
    echo.
    pause
    exit /b 1
)

echo  Relay file paoa geche: "%RELAY%"

echo.
echo  RJ Proxy Relay chalu hocche...
echo  (bondho korte: ei window e Ctrl + C, othoba window close korun)
echo.

node "%RELAY%"

REM relay bondho / crash korle window khola thakbe jate error dekha jay
echo.
echo  Relay bondho hoyeche.
pause
