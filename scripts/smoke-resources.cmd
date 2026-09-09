@echo off
REM Throwaway read-only smoke test for the Resources module. Boots a SECOND Hub
REM on 4546 (U1HUB_PORT) so the live instance on 4545 is never touched, hits the
REM GET endpoints only, then stops the instance it started. Never POSTs — the
REM two instances share resources.json and a write race would be nobody's friend.
cd /d "%~dp0.."
set U1HUB_PORT=4546
start "" /b cmd /c "node server.js > scripts\_smoke.log 2>&1"
REM Booting off SMB with node_modules on the share takes a while; poll for the
REM listener instead of guessing a sleep.
for /l %%i in (1,1,30) do (
  ping -n 2 127.0.0.1 >nul
  curl -s -o nul http://127.0.0.1:4546/api/version && goto :up
)
:up
echo ===== BOOT LOG =====
type scripts\_smoke.log
echo.
echo ===== /api/version =====
curl -s http://127.0.0.1:4546/api/version
echo.
echo ===== /api/resources/badge =====
curl -s http://127.0.0.1:4546/api/resources/badge
echo.
echo ===== /api/resources/spools (count) =====
curl -s http://127.0.0.1:4546/api/resources/spools > scripts\_spools.json
powershell -NoProfile -Command "$j=Get-Content scripts\_spools.json -Raw | ConvertFrom-Json; 'spools: ' + $j.spools.Count"
echo ===== /api/resources (summary) =====
curl -s http://127.0.0.1:4546/api/resources > scripts\_res.json
powershell -NoProfile -Command "$j=Get-Content scripts\_res.json -Raw | ConvertFrom-Json; 'rows: '+$j.rows.Count+'  jobs: '+$j.counted_jobs+'  units: '+$j.counted_units+'  needed_g: '+$j.totals.needed_g+'  unresolved: '+$j.unresolved.Count+'  parsed: '+$j.cache_entries"
echo ===== index.html serves the module tag =====
curl -s http://127.0.0.1:4546/ | findstr /C:"resources-ui.js"
echo.
echo ===== stopping the smoke instance =====
REM Kill by LISTENING PORT, never by image name: Desktop Commander is itself
REM node.exe, and `taskkill /IM node.exe` takes the tool running this (see
REM MISTAKES.md 2026-08-30). Port 4546 is only ever this throwaway instance.
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 4546 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){ $p | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force; 'stopped ' + $_ } } else { 'nothing listening on 4546' }"
echo DONE
