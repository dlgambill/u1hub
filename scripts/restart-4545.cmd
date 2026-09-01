@echo off
REM Restarts the PRODUCTION Hub on 4545 in a visible console window, the way it
REM was already running. Kills by LISTENING PORT, never by image name —
REM Desktop Commander is itself node.exe (MISTAKES.md 2026-08-30).
REM
REM Restarting does NOT stop anything on the printers: Klipper runs the prints,
REM the Hub watches and dispatches. In-flight jobs are re-adopted on boot.
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 4545 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){ $p | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force; 'stopped ' + $_ } } else { 'nothing was listening on 4545' }"
timeout /t 2 /nobreak >nul
start "U1 Print Hub" cmd /k "cd /d X:\u1-print-hub && node server.js"
for /l %%i in (1,1,40) do (
  ping -n 2 127.0.0.1 >nul
  curl -s -o nul http://127.0.0.1:4545/api/version && goto :up
)
echo TIMED OUT waiting for 4545
exit /b 1
:up
echo UP on 4545
