@echo off
REM Runs the full harness to a log file. Launched hidden and polled, because the
REM remote-device bridge has a hard ~60 s per-call ceiling and npm test takes
REM ~2.5 min over SMB — a foreground run dies with its output (MISTAKES.md
REM 2026-08-30). The harness stages into %TEMP% and binds 45990, so the live Hub
REM on 4545 and every state file on X: are untouched.
cd /d X:\u1-print-hub
del /Q scripts\harness.log 2>nul
echo START %DATE% %TIME% > scripts\harness.log
call npm test >> scripts\harness.log 2>&1
echo EXITCODE=%ERRORLEVEL% >> scripts\harness.log
echo END %DATE% %TIME% >> scripts\harness.log
