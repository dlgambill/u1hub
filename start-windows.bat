@echo off
title U1 Print Hub
REM Run from this file's own folder, wherever it was launched from (a shortcut
REM with the wrong "Start in", a double-click from Explorer, a stale copy).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS build from https://nodejs.org , then run this again.
  pause & exit /b 1
)
if not exist node_modules (
  echo First run - installing dependencies, one moment...
  call npm install
)
REM Already running (a logon task, another window)? Then this would only die
REM with "address already in use" - open the page instead.
powershell -NoProfile -Command "exit [int]![bool](Get-NetTCPConnection -LocalPort 4545 -State Listen -ErrorAction SilentlyContinue)" >nul 2>nul
if not errorlevel 1 (
  echo U1 Print Hub is already running at http://localhost:4545 - opening it.
  start "" http://localhost:4545
  timeout /t 3 >nul
  exit /b 0
)
echo Starting U1 Print Hub at http://localhost:4545
start "" http://localhost:4545
node server.js
pause
