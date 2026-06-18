@echo off
REM ====================================================================
REM  start-cipher-server.bat
REM  Double-click this file to start the cipher server. That's it.
REM  Keep the window open (minimize it if you want). It serves
REM  cipher.js to the IVAC userscript's key button.
REM
REM  Put this file in the SAME folder as cipher.js and cipher-server.js
REM  e.g. C:\Users\mital\Desktop\autocheck\
REM ====================================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)

echo Starting cipher server... keep this window open.
echo (Close this window to stop the server.)
echo.
node cipher-server.js

REM If the server stops/crashes, keep the window open so you can read the error.
pause
