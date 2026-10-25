$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$privateDir = Join-Path $taskRoot 'private'
New-Item -ItemType Directory -Path $privateDir -Force | Out-Null
$configFile = Join-Path $privateDir 'config.json'
# A portable copy carries its own runtime. Installed Node and Codex runtime are fallbacks.
$nodeCandidates = @((Join-Path $taskRoot 'runtime\node.exe'))
if ($env:BOSS_HELPER_NODE_PATH) { $nodeCandidates += $env:BOSS_HELPER_NODE_PATH }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand -and $nodeCommand.Source) { $nodeCandidates += $nodeCommand.Source }
$nodeCandidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
$nodePath = $null
foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        $nodeVersion = & $candidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $nodePath = $candidate; break }
    } catch {}
}
if (-not $nodePath) { throw 'Node.js 22+ was not found. Use the complete Windows portable package or install Node.js 22+.' }
# Codex native executable discovery is shared with the installer and generator.
if (Test-Path -LiteralPath $configFile) {
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    $defaultsFile = Join-Path $taskRoot 'templates\config.default.json'
    $config = if (Test-Path -LiteralPath $defaultsFile) {
        Get-Content -LiteralPath $defaultsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } else { [pscustomobject]@{port=43127;timeoutMs=120000} }
    $random = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $pairingToken = ([BitConverter]::ToString($random)).Replace('-','').ToLowerInvariant()
    $config | Add-Member -NotePropertyName token -NotePropertyValue $pairingToken -Force
}
if ($config.port -ne 43127 -or $config.token -notmatch '^[a-f0-9]{64}$') { throw 'Invalid local configuration. Check private/config.json without sharing its secret values.' }
$systemProxyUrl = ''
try {
    $proxySettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
    if ($proxySettings.ProxyEnable -eq 1 -and $proxySettings.ProxyServer) {
        $proxyServer = [string]$proxySettings.ProxyServer
        if ($proxyServer.Contains('=')) {
            $proxyEntry = $proxyServer.Split(';') | Where-Object { $_ -match '^https?=' } | Select-Object -First 1
            if ($proxyEntry) { $proxyServer = ($proxyEntry -split '=',2)[1] } else { $proxyServer = '' }
        }
        if ($proxyServer -and $proxyServer -notmatch '://') { $proxyServer = 'http://' + $proxyServer }
        $proxyUri = $null
        if ([Uri]::TryCreate($proxyServer, [UriKind]::Absolute, [ref]$proxyUri) -and $proxyUri.Scheme -in @('http','https','socks5')) { $systemProxyUrl = $proxyUri.AbsoluteUri }
    }
} catch {}
$config | Add-Member -NotePropertyName systemProxyUrl -NotePropertyValue $systemProxyUrl -Force
[IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
$pairingFile = Join-Path $privateDir 'pairing.txt'
[IO.File]::WriteAllText($pairingFile, $config.token, (New-Object Text.UTF8Encoding $false))
$headers = @{'X-Boss-Helper-Token'=$config.token}
$running = $false
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/api/health' -Headers $headers -TimeoutSec 2
    $running = $health.app -eq 'boss-greeting-helper' -and $health.version -ge 4 -and $health.generator -eq 'codex'
    if ($health.app -eq 'boss-greeting-helper' -and -not $running) {
        # The stop script verifies this directory owns the PID; it refuses other copies.
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the old helper owned by this directory.' }
    }
} catch {}
if (-not $running) {
    $entry = Join-Path $taskRoot 'server\index.mjs'
    $service = Start-Process -FilePath $nodePath -ArgumentList @('"' + $entry + '"') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateDir 'server.log') -RedirectStandardError (Join-Path $privateDir 'server-error.log')
    [IO.File]::WriteAllText((Join-Path $privateDir 'server.pid'), [string]$service.Id)
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/api/health' -Headers $headers -TimeoutSec 1
            if ($health.app -eq 'boss-greeting-helper' -and $health.version -ge 4 -and $health.generator -eq 'codex') { $running=$true; break }
        } catch {}
        if ($service.HasExited) { break }
    }
}
if (-not $running) { throw 'Helper did not start. Check private/server-error.log; port 43127 may already be used by another copy.' }
Write-Host 'Helper is running at 127.0.0.1:43127.'
Write-Host ('Pairing code file: ' + $pairingFile)
Write-Host ('Chrome extension folder: ' + (Join-Path $taskRoot 'extension'))
Write-Host 'Generation uses Codex with ChatGPT login. Check Codex login in the extension settings.'
if (-not $health.profileReady) { Write-Host 'Add your own candidate facts in Codex/profile settings before generating.' }
