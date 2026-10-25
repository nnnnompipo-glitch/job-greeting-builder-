$ErrorActionPreference = 'Stop'

function Test-BossHelperProcess {
    param($ProcessInfo, [string]$ExpectedEntry)
    if (-not $ProcessInfo -or $ProcessInfo.Name -ne 'node.exe' -or -not $ProcessInfo.CommandLine) { return $false }
    # Our launcher passes the absolute script as Node's first argument. Parse whole
    # quoted/unquoted arguments rather than accepting another script's substring.
    $argumentPattern = '(?<!\S)(?:"([^"]*)"|([^"\s]+))(?=\s|$)'
    $commandLine = [string]$ProcessInfo.CommandLine
    if (([regex]::Replace($commandLine, $argumentPattern, '')).Trim()) { return $false }
    $arguments = [regex]::Matches($commandLine, $argumentPattern)
    if ($arguments.Count -lt 2) { return $false }
    $entryArgument = if ($arguments[1].Groups[1].Success) { $arguments[1].Groups[1].Value } else { $arguments[1].Groups[2].Value }
    $entryArgument = $entryArgument.Replace('/', '\')
    if ($entryArgument -notmatch '^(?:[a-zA-Z]:\\|\\\\)') { return $false }
    try {
        $actualEntry = [IO.Path]::GetFullPath($entryArgument)
        $expectedPath = [IO.Path]::GetFullPath($ExpectedEntry.Replace('/', '\'))
        return $actualEntry.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Remove-BossHelperImportFiles {
    param([string]$TaskRoot)
    $importsRoot = [IO.Path]::GetFullPath((Join-Path $TaskRoot 'private\imports'))
    if (-not (Test-Path -LiteralPath $importsRoot -PathType Container)) { return }
    if ((Get-Item -LiteralPath $importsRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    Get-ChildItem -LiteralPath $importsRoot -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|jpeg|bmp|txt|md)$'
    } | ForEach-Object {
        $importTarget = [IO.Path]::GetFullPath($_.FullName)
        if ([IO.Path]::GetDirectoryName($importTarget).Equals($importsRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $importTarget -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-BossHelper {
    param([string]$TaskRoot)
    $TaskRoot = [IO.Path]::GetFullPath($TaskRoot)
    $pidFile = Join-Path $TaskRoot 'private\server.pid'
    $expectedEntry = Join-Path $TaskRoot 'server\index.mjs'
    $candidateIds = @()
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        $recordedId = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$recordedId) -and $recordedId -gt 0) {
            $candidateIds += $recordedId
        }
    }
    # A failed launch or a different Node installation can leave a stale PID file.
    # The listener provides a candidate only; the exact script path proves ownership.
    $listeners = @(Get-NetTCPConnection -LocalPort 43127 -State Listen -ErrorAction SilentlyContinue)
    $listenerIds = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 0 } | Select-Object -Unique)
    $candidateIds = @($candidateIds + $listenerIds | Select-Object -Unique)
    $stoppedIds = @()
    foreach ($candidateId in $candidateIds) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $candidateId" -ErrorAction SilentlyContinue
        if (-not (Test-BossHelperProcess $processInfo $expectedEntry)) { continue }
        $modelWorkspace = Join-Path $TaskRoot 'private\model-workspace'
        $importScript = Join-Path $TaskRoot 'scripts\import-document.ps1'
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $candidateId" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and (($_.Name -eq 'codex.exe' -and $_.CommandLine.IndexOf($modelWorkspace, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine.IndexOf($importScript, [StringComparison]::OrdinalIgnoreCase) -ge 0)) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
        # Re-check the PID immediately before stopping it, in case the process exited.
        $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $candidateId" -ErrorAction SilentlyContinue
        if (Test-BossHelperProcess $currentProcess $expectedEntry) {
            Stop-Process -Id $candidateId -ErrorAction SilentlyContinue
            $stoppedIds += $candidateId
        }
    }
    if ($listenerIds | Where-Object { $_ -notin $stoppedIds }) {
        throw 'Port 43127 belongs to a process outside this helper directory. It was left untouched.'
    }
    if ($stoppedIds.Count) {
        Remove-BossHelperImportFiles $TaskRoot
        Write-Host 'Helper stopped.'
    } else { Write-Host 'No verified helper process is running for this directory.' }
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}

# Dot-sourcing exposes the ownership checks for isolated tests without stopping anything.
if ($MyInvocation.InvocationName -ne '.') {
    Stop-BossHelper (Split-Path -Parent $PSScriptRoot)
}
