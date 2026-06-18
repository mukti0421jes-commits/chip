@echo off
REM ====================================================================
REM  install-autostart.bat  (run ONCE)
REM  Makes the cipher server start automatically (hidden) every time
REM  Windows starts. After this, you never touch CMD again:
REM  just reload the IVAC page and the cipher auto-loads.
REM
REM  Keep this file in the SAME folder as cipher-server.js, cipher.js
REM  and start-cipher-hidden.vbs.
REM ====================================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Install it from https://nodejs.org and run this again.
    pause
    exit /b 1
)

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%STARTUP%\cipher-server.vbs"

echo Copying hidden launcher to Startup folder...
copy /Y "%~dp0start-cipher-hidden.vbs" "%TARGET%" >nul
if errorlevel 1 (
    echo [ERROR] Could not copy to Startup folder.
    pause
    exit /b 1
)

echo Starting the server now (hidden) so you don't have to reboot...
start "" "%TARGET%"

echo.
echo [DONE] Cipher server will now auto-start (hidden) on every login.
echo You can close this window. Reload the IVAC page to test.
pause
