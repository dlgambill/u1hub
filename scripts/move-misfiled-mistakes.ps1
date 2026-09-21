$ErrorActionPreference = 'Stop'
$u1c    = 'C:\Users\Danny\code\u1-print-hub\MISTAKES.md'
$u1x    = 'X:\u1-print-hub\MISTAKES.md'
$shared = 'C:\Users\Danny\code\MISTAKES-shared.md'
$tmp    = 'C:\Users\Danny\AppData\Local\Temp'
$enc    = New-Object System.Text.UTF8Encoding($false)

Copy-Item $u1c    "$tmp\bk-u1c-20260921.md"    -Force
Copy-Item $u1x    "$tmp\bk-u1x-20260921.md"    -Force
Copy-Item $shared "$tmp\bk-shared-20260921.md" -Force

$lines = [System.IO.File]::ReadAllLines($u1c, $enc)
if ($lines.Count -ne 1016) { throw "u1 line count is $($lines.Count), expected 1016" }
if ($lines[876] -notlike '## 2026-09-07*stale ref*')     { throw "line 877 unexpected: $($lines[876])" }
if ($lines[939] -notlike '## 2026-09-07*moving number*') { throw "line 940 unexpected: $($lines[939])" }
if ($lines[874] -ne '---')                                { throw "line 875 not the rule: $($lines[874])" }
if ($lines[875] -ne '')                                   { throw "line 876 not blank: $($lines[875])" }

$move = $lines[939..1015]
$sh   = [System.IO.File]::ReadAllLines($shared, $enc)
$shOut = @($sh) + @('', '---', '') + @($move)
[System.IO.File]::WriteAllLines($shared, $shOut, $enc)

$ptr  = [System.IO.File]::ReadAllLines("$tmp\ptr-block.md", $enc)
$out  = @($lines[0..875]) + @($ptr)
[System.IO.File]::WriteAllLines($u1c, $out, $enc)
Copy-Item $u1c $u1x -Force

Write-Output "u1     lines: $(([System.IO.File]::ReadAllLines($u1c, $enc)).Count)"
Write-Output "u1 X:  lines: $(([System.IO.File]::ReadAllLines($u1x, $enc)).Count)"
Write-Output "shared lines: $(([System.IO.File]::ReadAllLines($shared, $enc)).Count)"
Write-Output 'OK'
