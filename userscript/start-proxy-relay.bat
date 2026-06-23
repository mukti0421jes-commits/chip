@echo off
REM ============================================================
REM  RJ SLOT - Proxy Relay launcher (Windows)
REM  Double-click this file. It installs deps once, then runs
REM  the relay on http://127.0.0.1:8781 and keeps it open.
REM  Keep this window OPEN while you use the userscript proxy.
REM ============================================================
title RJ SLOT Proxy Relay (port 8781)
cd /d "%~dp0"

echo.
echo ===== RJ SLOT Proxy Relay =====
echo.

REM --- check Node ---
where node >nul 2>nul
if errorlevel 1 (
    echo [X] Node.js paowa jayni.
    echo     nodejs.org theke Node install kore abar double-click korun.
    echo.
    pause
    exit /b 1
)

REM --- check relay file ---
if not exist "proxy-relay.js" (
    echo [X] proxy-relay.js ei folder e nei.
    echo     proxy-relay.js ar ei .bat ekoi folder e rakhun.
    echo.
    pause
    exit /b 1
)

REM --- install deps only once ---
if not exist "node_modules\proxy-agent" (
    echo [*] Prothombar setup - package install hocche... ^(internet lagbe^)
    echo.
    if not exist "package.json" call npm init -y >nul 2>nul
    call npm i node-fetch@2 proxy-agent
    if errorlevel 1 (
        echo.
        echo [X] npm install fail holo. Internet check kore abar try korun.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] Setup sesh.
    echo.
)

echo [*] Relay cholche... http://127.0.0.1:8781
echo     EI WINDOW KHOLA RAKHUN. Bondho korte: Ctrl+C othoba window close.
echo.
node proxy-relay.js

echo.
echo [!] Relay bondho hoye geche.
pause
