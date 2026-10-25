param(
    [string]$OutputDirectory = '',
    [string]$ArchiveDirectory = '',
    [string]$RuntimePath = '',
    [string]$CommitRef = '',
    [string]$Label = 'release',
    [switch]$SourceOnly,
    [switch]$PassThru
)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$repositoryRoot = if (Test-Path -LiteralPath (Join-Path $appRoot 'SKILL.md')) { $appRoot } else { [IO.Path]::GetFullPath((Join-Path $appRoot '..\..\..\..')) }
$appVersion = (Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$extensionVersion = (Get-Content -LiteralPath (Join-Path $appRoot 'extension\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($appVersion -notmatch '^\d+\.\d+\.\d+$' -or $extensionVersion -ne $appVersion) { throw 'Application and extension versions must match.' }
$changelog = Get-Content -LiteralPath (Join-Path $repositoryRoot 'CHANGELOG.md') -Raw -Encoding UTF8
$versionPattern = '(?m)^##\s+(?:\[' + [regex]::Escape($appVersion) + '\]|' + [regex]::Escape($appVersion) + ')(?=\s|$)'
if ($changelog -notmatch $versionPattern) { throw 'Add the current version to CHANGELOG.md before building a release.' }
if ($CommitRef -and $CommitRef -notmatch '^[0-9a-fA-F]{7,40}$') { throw 'CommitRef must be a Git commit hash.' }
if (-not $ArchiveDirectory) { $ArchiveDirectory = Join-Path $repositoryRoot '版本归档' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $appRoot 'dist' }

$nodeCandidates = @($RuntimePath, (Join-Path $appRoot 'runtime\node.exe'), $env:BOSS_HELPER_NODE_PATH)
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
$nodeCandidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
$nodePath = $null
foreach ($candidate in ($nodeCandidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $nodeVersion = & $candidate --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $nodePath=$candidate; break }
}
if (-not $nodePath) { throw 'Node.js 22+ is required to create and verify version archives.' }

$export = & (Join-Path $PSScriptRoot 'export-github.ps1') -OutputDirectory $OutputDirectory -PassThru
$artifacts = @($export.zipPath)
if (-not $SourceOnly) {
    $package = & (Join-Path $PSScriptRoot 'package.ps1') -OutputDirectory $OutputDirectory -RuntimePath $nodePath -PassThru
    $artifacts += $package.zipPath
}
$archiveArguments = @((Join-Path $PSScriptRoot 'archive-version.mjs'), '--source', $export.repositoryRoot, '--version', $appVersion, '--label', $Label, '--output', [IO.Path]::GetFullPath($ArchiveDirectory))
if ($CommitRef) { $archiveArguments += @('--commit', $CommitRef) }
foreach ($artifact in $artifacts) { $archiveArguments += @('--artifact', $artifact) }
$archiveArguments += @('--description', '发布构建：包含完整公开源码、更新日志和构建产物。个人资料与账号信息不进入归档。仅在与已提交源码一致时填写提交号。')
$archiveOutput = & $nodePath @archiveArguments
if ($LASTEXITCODE -ne 0) { throw 'Version archival failed. Existing archives were not overwritten.' }
$archive = ($archiveOutput | Out-String) | ConvertFrom-Json
$verificationOutput = & $nodePath (Join-Path $PSScriptRoot 'archive-version.mjs') --verify $archive.snapshotDir
if ($LASTEXITCODE -ne 0) { throw 'Version archive checksum verification failed.' }
Write-Host ($verificationOutput | Out-String).Trim()
Write-Host ('Version archive: ' + $archive.snapshotDir)
Write-Host 'Release prepared locally. This script does not create a Git commit or push a repository.'
if ($PassThru) { [pscustomobject]@{version=$appVersion;sourceRoot=$export.repositoryRoot;artifacts=$artifacts;snapshotDir=$archive.snapshotDir} }
