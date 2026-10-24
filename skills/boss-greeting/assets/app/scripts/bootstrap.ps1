param(
    [switch]$Diagnose,
    [switch]$DetectLocal,
    [switch]$ApplyHostEnv,
    [switch]$Start,
    [switch]$ReplaceModel,
    [string]$Provider = '',
    [string]$Model = '',
    [string]$BaseUrl = '',
    [string]$ApiKeyEnv = '',
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
if ($DetectLocal) { $installArguments += '--detect-local' }
if ($ApplyHostEnv) { $installArguments += '--apply-host-env' }
if ($Start) { $installArguments += '--start' }
if ($ReplaceModel) { $installArguments += '--replace-model' }
foreach ($pair in @(@('--provider',$Provider),@('--model',$Model),@('--base-url',$BaseUrl),@('--api-key-env',$ApiKeyEnv),@('--install-dir',$InstallDir))) {
    if ($pair[1]) { $installArguments += $pair[0]; $installArguments += $pair[1] }
}
& $nodePath @installArguments
exit $LASTEXITCODE
