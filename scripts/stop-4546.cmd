@echo off
REM Stops the throwaway Hub started by boot-4546.cmd. Kills by LISTENING PORT,
REM never by image name: Desktop Commander is itself node.exe and
REM `taskkill /IM node.exe` takes the tool running this (MISTAKES.md 2026-08-30).
REM Port 4546 is only ever the throwaway instance; 4545 is production.
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 4546 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){ $p | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force; 'stopped ' + $_ } } else { 'nothing listening on 4546' }"
