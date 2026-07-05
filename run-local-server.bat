@echo off
REM Local Web Server Starter for Testing Static Files
REM Based on CLAUDE.md guidance - serves files from Outputs directory
REM DO NOT serve directories containing sensitive files like keys.txt

REM Check if Python is available
where python >nul 2>&1
if errorlevel 1 (
    echo Error: Python not found in PATH.
    echo Please install Python from https://python.org
    echo and ensure it's added to your PATH during installation.
    pause
    exit /b 1
)

echo.
echo Starting local web server...
echo Serving files from: %cd%
echo.
echo Open your browser and go to: http://localhost:8000
echo.
echo Press Ctrl+C to stop the server when done testing.
echo.

REM Start Python HTTP server on port 8000
python -m http.server 8000

REM Keep window open if server stops unexpectedly
if errorlevel 1 (
    echo.
    echo Server stopped unexpectedly.
    pause
)