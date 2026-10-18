@echo off
rem Sonic DOOM Special Stage - Windows launcher (twin of start.sh).
rem Usage: start.bat [port]   (default 8090)
setlocal
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8090"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on your PATH.
  echo Install it from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)

echo Starting the Sonic DOOM server at http://localhost:%PORT%/ ...
start "Sonic DOOM Server" /min node serve.mjs %PORT%
timeout /t 1 /nobreak >nul 2>nul
start "" "http://localhost:%PORT%/"
echo.
echo The game should open in your browser.
echo To stop the server, close the "Sonic DOOM Server" window.
endlocal
