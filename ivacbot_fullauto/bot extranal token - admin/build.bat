@echo off
title Build IVAC Bot
color 0A
echo ================================================
echo     Building IVAC Payment Bot Executable
echo ================================================
echo.

:: Install dependencies first
echo Installing dependencies...
go mod tidy

:: Build Windows executable (whole package — ALL .go files, not just main.go)
echo Building for Windows...
go build -o ivac-bot.exe .

if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)

echo.
echo Build successful!
echo Created: ivac-bot.exe
echo.
echo You can now run ivac-bot.exe directly
pause