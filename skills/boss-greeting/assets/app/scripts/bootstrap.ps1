param(
    [switch]$Diagnose,
    [switch]$Start,
    [string]$InstallDir = ''
)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$nodeCandidates = @((Join-Path $appRoot 'runtime\node.exe'))
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand -and $nodeCommand.Source) { $nodeCandidates += $nodeCommand.Source }
$nodeCandidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
$nodePath = $null
foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $nodeVersion = & $candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $nodePath=$candidate; break }
    } catch {}
}
if (-not $nodePath) {
    Write-Error 'Node.js 22+ is required. Install Node.js LTS using the host normal software-installation flow, then retry. No AI account credentials were searched.'
    exit 1
}
$installArguments = @((Join-Path $PSScriptRoot 'install.mjs'))
if ($Diagnose) { $installArguments += '--diagnose' }
if ($Start) { $installArguments += '--start' }
if ($InstallDir) { $installArguments += '--install-dir'; $installArguments += $InstallDir }
& $nodePath @installArguments
exit $LASTEXITCODE
