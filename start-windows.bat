@echo off
title U1 Print Hub
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS build from https://nodejs.org , then run this again.
  pause & exit /b 1
)
if not exist node_modules (
  echo First run - installing dependencies, one moment...
  call npm install
)
echo Starting U1 Print Hub at http://localhost:4545
start "" http://localhost:4545
node server.js
pause
