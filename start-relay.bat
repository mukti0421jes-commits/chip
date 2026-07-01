@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  RJ SLOT proxy relay launcher
REM  proxy-relay.js er pashe rakhun, double-click korun.
REM ============================================================
title RJ Proxy Relay
cd /d "%~dp0"

REM --- Node khoja: age PATH, na pele common install folder theke ---
set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
    echo.
    echo  [!] Node.js paoa jayni.
    echo      Jodi ekhoni Node install korechen, PC Restart korun.
    echo      Othoba install korun: https://nodejs.org  ^(LTS^)
    echo.
    pause
    exit /b 1
)

REM --- relay file khoja (nam/extension ja-i hok) ---
set "RELAY="
for %%F in ("%~dp0proxy-relay.js" "%~dp0proxyrelay.js" "%~dp0proxy-relay.js.txt" "%~dp0proxyrelay.js.txt" "%~dp0proxy-relay.txt" "%~dp0proxyrelay.txt" "%~dp0proxy-relay" "%~dp0proxyrelay") do (
    if not defined RELAY if exist "%%~F" set "RELAY=%%~F"
)

if not defined RELAY (
    echo.
    echo  [!] relay file ei folder e paoa jayni.
    echo      ei bat er pashei "proxy-relay.js" rakhun.
    echo.
    echo  Ei folder e ja ache:
    dir /b "%~dp0"
    echo.
    pause
    exit /b 1
)

echo  Node   : "%NODE%"
echo  Relay  : "%RELAY%"
echo.
echo  RJ Proxy Relay chalu hocche...
echo  (bondho korte: ei window e Ctrl + C, othoba window close korun)
echo.

"%NODE%" "%RELAY%"

echo.
echo  Relay bondho hoyeche.
pause
