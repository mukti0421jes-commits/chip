@echo off
title RJ Proxy Relay
cd /d "%~dp0"

echo ============================================
echo   RJ SLOT Proxy Relay (Playwright / real browser)
echo ============================================
echo.

set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
    echo [!] Node.js paoa jayni.
    echo     Install korun: https://nodejs.org  ^(LTS^)
    echo     Install-er por PC restart kore abar double-click korun.
    echo.
    pause
    exit /b 1
)

for %%D in ("%NODE%") do set "NODEDIR=%%~dpD"
set "NPM=%NODEDIR%npm.cmd"
set "NPX=%NODEDIR%npx.cmd"

if not exist "%~dp0proxy-relay.js" (
    echo [!] proxy-relay.js ei folder e nei. ek folder e rakhun.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0node_modules\playwright" (
    echo playwright install kora hocche ^(ekbar-i^)...
    call "%NPM%" i playwright --no-audit --no-fund
    if errorlevel 1 (
        echo [!] playwright install fail. Internet check korun.
        echo.
        pause
        exit /b 1
    )
)

if not exist "%USERPROFILE%\AppData\Local\ms-playwright" (
    echo Chromium download kora hocche ^(ekbar-i, boro download^)...
    call "%NPX%" playwright install chromium
)

echo.
echo Node  : %NODE%
echo Relay chalu hocche... ^(bondho korte ei window CLOSE korun^)
echo.
"%NODE%" "%~dp0proxy-relay.js"

echo.
echo Relay bondho hoyeche.
pause
