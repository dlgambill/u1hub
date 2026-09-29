# Opens a program on the signed-in user's desktop, for a Hub running as a
# Windows service (v2.40). Services live in session 0, where nothing they
# start can be seen. Windows' own way across is the Task Scheduler: a task
# with an Interactive logon runs in the signed-in user's session. This
# re-points one task at the program and file, and starts it. The program
# itself is what the task runs - no hidden launcher in between.
#
# To use it, set this environment variable for the service:
#   U1_DESKTOP_LAUNCHER=<full path to this file>
# The Hub (modules/desktop.js) then calls:
#   powershell -NoProfile -ExecutionPolicy Bypass -File open-on-desktop.ps1 -Exe <program> -Target <file> [-Prefix "/select,"]
# The service must run as the same user who is signed in at the desktop.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Target = "",
  [string]$Prefix = ""
)
$ErrorActionPreference = "Stop"
$name = "Hub - open on desktop"
$user = "$env:USERDOMAIN\$env:USERNAME"
$argLine = if ($Target) { $Prefix + '"' + ($Target -replace '"', '') + '"' } else { $Prefix }
$action = if ($argLine) { New-ScheduledTaskAction -Execute $Exe -Argument $argLine } else { New-ScheduledTaskAction -Execute $Exe }
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
# No time limit (the program stays open as long as you want), and a second
# open while the first program is still running starts a second one.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
"started on the desktop: $Exe $argLine"
