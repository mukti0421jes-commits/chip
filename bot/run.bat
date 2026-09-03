@echo off
title IVAC Payment Bot Dashboard
color 0A
echo ================================================
echo     IVAC PAYMENT BOT DASHBOARD v6
echo ================================================
echo.
echo Starting server...
echo.

:: Check if Go is installed
go version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Go is not installed!
    echo Please install Go from https://golang.org/dl/
    pause
    exit /b 1
)

:: Download dependencies
echo Installing dependencies...
go mod tidy

:: Run the application
echo Starting dashboard...
echo.
echo Dashboard will open automatically in your browser
echo Press Ctrl+C to stop the server
echo.

go run .

pause