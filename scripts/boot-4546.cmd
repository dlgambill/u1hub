@echo off
REM Boots a THROWAWAY Hub on 4546 and leaves it running, so a browser can be
REM pointed at it for a live gate without going near production on 4545.
REM
REM v2.19: it now runs with U1HUB_DIR set to an isolated state directory seeded
REM from production's files. That matters — before U1HUB_DIR existed, both
REM instances shared one dispatch.json, so live-checking anything that WRITES
REM state meant writing to the real farm's scheduling file. Now the throwaway
REM can be clicked around freely: mark printers down, dismiss update notices,
REM whatever. Nothing it does reaches the install.
REM
REM Stop it with scripts\stop-4546.cmd — by listening port, never by image name
REM (Desktop Commander is node.exe too).
cd /d "%~dp0.."
set U1HUB_DIR=%TEMP%\u1hub-4546
set U1HUB_PORT=4546
rmdir /s /q "%U1HUB_DIR%" 2>nul
node scripts\seed-4546.js "%U1HUB_DIR%" || exit /b 1
start "" /b cmd /c "node server.js > scripts\_boot4546.log 2>&1"
for /l %%i in (1,1,40) do (
  ping -n 2 127.0.0.1 >nul
  curl -s -o nul http://127.0.0.1:4546/api/version && goto :up
)
echo TIMED OUT waiting for 4546
type scripts\_boot4546.log
exit /b 1
:up
echo UP on 4546  (state in %U1HUB_DIR%, production untouched)
