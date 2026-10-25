$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $taskRoot 'private\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No helper PID file.'; exit }
$helperPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $helperPid" -ErrorAction SilentlyContinue
$expectedEntry = Join-Path $taskRoot 'server\index.mjs'
if ($processInfo -and $processInfo.Name -eq 'node.exe' -and $processInfo.CommandLine -and $processInfo.CommandLine.IndexOf($expectedEntry,[StringComparison]::OrdinalIgnoreCase) -ge 0) {
    $modelWorkspace = Join-Path $taskRoot 'private\model-workspace'
    $importScript = Join-Path $taskRoot 'scripts\import-document.ps1'
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $helperPid" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and (($_.Name -eq 'codex.exe' -and $_.CommandLine.Contains($modelWorkspace)) -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine.IndexOf($importScript,[StringComparison]::OrdinalIgnoreCase) -ge 0)) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    Stop-Process -Id $helperPid
    $importsRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot 'private\imports'))
    if (Test-Path -LiteralPath $importsRoot -PathType Container) {
        Get-ChildItem -LiteralPath $importsRoot -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|bmp|txt|md)$' } | ForEach-Object {
            $importTarget = [IO.Path]::GetFullPath($_.FullName)
            if ([IO.Path]::GetDirectoryName($importTarget).Equals($importsRoot,[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $importTarget -Force -ErrorAction SilentlyContinue }
        }
    }
    Write-Host 'Helper stopped.'
} elseif ($processInfo) { throw 'PID now belongs to another process. It was left untouched.' }
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
