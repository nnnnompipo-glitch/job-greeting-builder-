$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $taskRoot 'private\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No helper PID file.'; exit }
$helperPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $helperPid" -ErrorAction SilentlyContinue
$expectedEntry = Join-Path $taskRoot 'server\index.mjs'
if ($processInfo -and $processInfo.Name -eq 'node.exe' -and $processInfo.CommandLine -and $processInfo.CommandLine.IndexOf($expectedEntry,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
    $modelWorkspace = Join-Path $taskRoot 'private\model-workspace'
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $helperPid" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'codex.exe' -and $_.CommandLine -and $_.CommandLine.Contains($modelWorkspace) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    Stop-Process -Id $helperPid
    Write-Host 'Helper stopped.'
} elseif ($processInfo) { throw 'PID now belongs to another process. It was left untouched.' }
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
