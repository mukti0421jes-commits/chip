@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  RJ SLOT proxy relay launcher (Chrome-TLS / cycletls)
REM  proxy-relay.js er pashe rakhun, double-click korun.
REM ============================================================
title RJ Proxy Relay
cd /d "%~dp0"

REM --- Node + npm khoja (PATH, na pele common install folder) ---
set "NODE="
set "NPM="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
    echo.
    echo  [!] Node.js paoa jayni. Install korun: https://nodejs.org (LTS)
    echo      jodi ekhoni install korechen, PC Restart korun.
    echo.
    pause
    exit /b 1
)

REM npm.cmd node er pashei thake
for %%D in ("%NODE%") do set "NODEDIR=%%~dpD"
if exist "%NODEDIR%npm.cmd" set "NPM=%NODEDIR%npm.cmd"
if not defined NPM (
    for /f "delims=" %%M in ('where npm 2^>nul') do if not defined NPM set "NPM=%%M"
)

REM --- relay file khoja ---
set "RELAY="
for %%F in ("%~dp0proxy-relay.js" "%~dp0proxyrelay.js") do (
    if not defined RELAY if exist "%%~F" set "RELAY=%%~F"
)
if not defined RELAY (
    echo.
    echo  [!] proxy-relay.js ei folder e paoa jayni.
    echo  Ei folder e ja ache:
    dir /b "%~dp0"
    echo.
    pause
    exit /b 1
)

REM --- cycletls install ache kina; na thakle install ---
if not exist "%~dp0node_modules\cycletls" (
    echo.
    echo  cycletls install kora hocche (ekbar-i, ektu somoy nite pare)...
    if not defined NPM (
        echo  [!] npm paoa jayni. cmd te ei folder e gie chalao:  npm i cycletls
        pause
        exit /b 1
    )
    call "%NPM%" i cycletls --no-audit --no-fund
    if errorlevel 1 (
        echo  [!] cycletls install fail holo. Internet check korun, tarpor abar cholun.
        pause
        exit /b 1
    )
)

echo.
echo  Node   : "%NODE%"
echo  Relay  : "%RELAY%"
echo  RJ Proxy Relay (Chrome-TLS) chalu hocche...
echo  (bondho korte: Ctrl + C, othoba window close)
echo.

"%NODE%" "%RELAY%"

echo.
echo  Relay bondho hoyeche.
pause
