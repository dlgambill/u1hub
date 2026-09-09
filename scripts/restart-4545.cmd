@echo off
REM Restarts the PRODUCTION Hub on 4545. Kills by LISTENING PORT, never by
REM image name - Desktop Commander is itself node.exe (MISTAKES.md 2026-08-30).
REM
REM v2.21: the Hub is started through WMI (Win32_Process.Create), NOT as a
REM child of whatever ran this script. A child rides its parent's job object,
REM and when the parent is the remote-automation bridge, the Hub silently dies
REM whenever the bridge recycles its sessions - production went down twice on
REM 2026-09-01 exactly this way, minutes after a clean "UP", no crash, no log.
REM WMI creates the process outside the caller's tree, so it outlives everyone.
REM Console output lands in hub-console.log (gitignored) - a crash finally
REM leaves its stack somewhere readable instead of in a vanished window.
REM
REM Restarting does NOT stop anything on the printers: Klipper runs the prints,
REM the Hub watches and dispatches. In-flight jobs are re-adopted on boot.
powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 4545 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){ $p | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force; 'stopped ' + $_ } } else { 'nothing was listening on 4545' }"
timeout /t 2 /nobreak >nul
REM 2026-09-09: the Hub runs from the git clone on C: (staging on X: retired);
REM the path is taken from this script's own location, so a moved checkout
REM still works. Gcode lives on X:\gcode via config.json's gcodeFolder.
set HUBDIR=%~dp0..
for %%I in ("%HUBDIR%") do set HUBDIR=%%~fI
powershell -NoProfile -Command "$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine='cmd /c node %HUBDIR%\server.js >> %HUBDIR%\hub-console.log 2>&1'; CurrentDirectory='%HUBDIR%' }; if($r.ReturnValue -eq 0){ 'started detached, pid ' + $r.ProcessId } else { 'WMI create FAILED rv=' + $r.ReturnValue }"
for /l %%i in (1,1,40) do (
  ping -n 2 127.0.0.1 >nul
  curl -s -o nul http://127.0.0.1:4545/api/version && goto :up
)
echo TIMED OUT waiting for 4545
exit /b 1
:up
echo UP on 4545
