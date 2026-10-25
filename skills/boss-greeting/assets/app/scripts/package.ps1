param(
    [string]$RuntimePath = '',
    [string]$RuntimeLicensePath = '',
    [string]$OutputDirectory = '',
    [switch]$PassThru
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$appVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($appVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'A valid application version is required.' }
$distRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $taskRoot 'dist' }
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

if (-not $RuntimePath) {
    $runtimeCandidates = @((Join-Path $taskRoot 'runtime\node.exe'))
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand -and $nodeCommand.Source) { $runtimeCandidates += $nodeCommand.Source }
    $runtimeCandidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    $RuntimePath = $runtimeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $RuntimePath -or -not (Test-Path -LiteralPath $RuntimePath -PathType Leaf)) { throw 'A Windows Node.js 22+ executable is required to build the portable package.' }
$runtimeIdentity = & $RuntimePath -p 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})' | ConvertFrom-Json
if ($runtimeIdentity.platform -ne 'win32' -or $runtimeIdentity.arch -ne 'x64' -or $runtimeIdentity.version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'The portable runtime must be Windows x64 Node.js 22+.' }
if (-not $RuntimeLicensePath) { $RuntimeLicensePath = Join-Path $taskRoot 'templates\node-LICENSE.txt' }
if (-not (Test-Path -LiteralPath $RuntimeLicensePath -PathType Leaf)) { throw 'Node.js LICENSE and third-party notices are required beside the runtime.' }
$licenseText = Get-Content -LiteralPath $RuntimeLicensePath -Raw -Encoding UTF8
if ($licenseText -notmatch 'Node.js is licensed' -or $licenseText.Length -lt 10000) { throw 'Node.js license file appears incomplete.' }

$buildId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0,8))
$stageRoot = Join-Path $distRoot ('staging-' + $buildId)
$packageRoot = Join-Path $stageRoot 'BOSS-Greeting-Helper'
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
$zipPath = Join-Path $distRoot ('BOSS-Greeting-Helper-' + $appVersion + '-Windows.zip')
if (Test-Path -LiteralPath $zipPath) { $zipPath = Join-Path $distRoot ('BOSS-Greeting-Helper-' + $appVersion + '-Windows-' + $buildId + '.zip') }

# Only these source paths enter the package. Never recurse through the workspace.
$relativeFiles = @(
    '启动助手.cmd', '停止助手.cmd',
    'scripts\start.ps1', 'scripts\stop.ps1', 'scripts\bootstrap.ps1', 'scripts\import-document.ps1', 'scripts\install.mjs', 'scripts\configure-host.mjs', 'scripts\codex.mjs',
    'templates\config.default.json', 'templates\profile.example.md', 'CHANGELOG.md',
    'extension\manifest.json', 'extension\platforms.cjs', 'extension\background.js', 'extension\extract.js', 'extension\content.js',
    'extension\popup.html', 'extension\popup.js', 'extension\popup.css',
    'extension\settings.html', 'extension\settings.js', 'extension\settings.css',
    'server\core.mjs', 'server\http.mjs', 'server\index.mjs', 'server\model.mjs', 'server\providers.mjs', 'server\imports.mjs',
    'server\greeting.schema.json'
)
# Additional runtime modules must be added explicitly when the server is extended.
foreach ($name in @('server\settings.mjs')) { if (Test-Path -LiteralPath (Join-Path $taskRoot $name)) { $relativeFiles += $name } }
try {
    foreach ($relative in $relativeFiles) {
        $sourcePath = Join-Path $taskRoot $relative
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw ('Missing package source: ' + $relative) }
        $targetPath = Join-Path $packageRoot $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    }
    Copy-Item -LiteralPath (Join-Path $taskRoot '打包说明.md') -Destination (Join-Path $packageRoot '使用说明.md')
    $runtimeTarget = Join-Path $packageRoot 'runtime'
    New-Item -ItemType Directory -Path $runtimeTarget -Force | Out-Null
    Copy-Item -LiteralPath $RuntimePath -Destination (Join-Path $runtimeTarget 'node.exe')
    Copy-Item -LiteralPath $RuntimeLicensePath -Destination (Join-Path $runtimeTarget 'LICENSE.txt')
    $runtimeNotice = 'Node.js ' + $runtimeIdentity.version + ' Windows x64. License source: https://github.com/nodejs/node/blob/' + $runtimeIdentity.version + '/LICENSE'
    [IO.File]::WriteAllText((Join-Path $runtimeTarget 'SOURCE.txt'),$runtimeNotice,(New-Object Text.UTF8Encoding $false))
    $packageMetadata = [ordered]@{name='boss-greeting-helper';version=$appVersion;private=$true;type='module';scripts=@{start='node server/index.mjs'};engines=@{node='>=22'}}
    [IO.File]::WriteAllText((Join-Path $packageRoot 'package.json'),($packageMetadata | ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding $false))
    $runtimeSha = (Get-FileHash -LiteralPath (Join-Path $runtimeTarget 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [ordered]@{version=$appVersion;builtAt=(Get-Date).ToUniversalTime().ToString('o');runtimeVersion=$runtimeIdentity.version;runtimeSha256=$runtimeSha;personalDataIncluded=$false;sourceFiles=$relativeFiles}
    [IO.File]::WriteAllText((Join-Path $packageRoot 'package-manifest.json'),($manifest | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding $false))
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
        if ($entries | Where-Object { $_ -match '(^|/)(private|\.git|node_modules|tests)(/|$)' -or $_ -match '\.(pdf|jpg|jpeg|png|log|pem)$' }) { throw 'Unexpected personal, testing, or credential file in ZIP.' }
        foreach ($required in @('runtime/node.exe','runtime/LICENSE.txt','CHANGELOG.md','extension/settings.html','templates/config.default.json','server/providers.mjs','scripts/install.mjs','scripts/codex.mjs')) {
            if (-not ($entries | Where-Object { $_ -eq ('BOSS-Greeting-Helper/' + $required) })) { throw ('Required package file missing from ZIP: ' + $required) }
        }
        Write-Host ('Package entries verified: ' + $entries.Count + '; no private directory, resumes, credentials, or logs included.')
    } finally { $archive.Dispose() }
    $zip = Get-Item -LiteralPath $zipPath
    Write-Host ('Portable ZIP: ' + $zip.FullName)
    Write-Host ('Size: ' + [Math]::Round($zip.Length / 1MB,2) + ' MiB; Node ' + $runtimeIdentity.version + ' bundled.')
    if ($PassThru) { [pscustomobject]@{zipPath=$zipPath;version=$appVersion;runtimePath=$RuntimePath} }
} finally {
    # Verify the absolute staging target before recursive cleanup; never remove dist itself.
    $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
    $resolvedDist = [IO.Path]::GetFullPath($distRoot).TrimEnd('\')
    if ($resolvedStage.StartsWith($resolvedDist + '\',[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedStage) -eq ('staging-' + $buildId)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
