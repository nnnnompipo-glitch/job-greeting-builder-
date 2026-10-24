param(
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
# The development tree keeps skill templates beside the app; a published repo nests the app.
if (Test-Path -LiteralPath (Join-Path $appRoot 'SKILL.md') -PathType Leaf) {
    $skillTemplateRoot = $appRoot
    $repositoryTemplateRoot = $appRoot
} else {
    $skillTemplateRoot = [IO.Path]::GetFullPath((Join-Path $appRoot '..\..'))
    $repositoryTemplateRoot = [IO.Path]::GetFullPath((Join-Path $skillTemplateRoot '..\..'))
}
$distRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $appRoot 'dist' }
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
$buildId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0,8))
$repositoryRoot = Join-Path $distRoot ('BOSS-Greeting-Skill-GitHub-' + $buildId)
$skillTargetRoot = Join-Path $repositoryRoot 'skills\boss-greeting'
$appTargetRoot = Join-Path $skillTargetRoot 'assets\app'
New-Item -ItemType Directory -Path $appTargetRoot -Force | Out-Null

function Copy-ExportFile([string]$SourceRoot, [string]$Relative, [string]$DestinationRoot, [string]$DestinationRelative = '') {
    if (-not $DestinationRelative) { $DestinationRelative = $Relative }
    $source = Join-Path $SourceRoot $Relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('Required export source missing: ' + $Relative) }
    $target = Join-Path $DestinationRoot $DestinationRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}

# The list is deliberately explicit. Never copy private/, an installed home directory or .git.
$appFiles = @(
    'package.json', '启动助手.cmd', '停止助手.cmd',
    'scripts\start.ps1', 'scripts\stop.ps1', 'scripts\bootstrap.ps1', 'scripts\install.mjs', 'scripts\configure-host.mjs',
    'scripts\package.ps1', 'scripts\export-github.ps1',
    'templates\config.default.json', 'templates\profile.example.md', 'templates\node-LICENSE.txt',
    'server\core.mjs', 'server\http.mjs', 'server\index.mjs', 'server\model.mjs',
    'server\providers.mjs', 'server\settings.mjs', 'server\greeting.schema.json',
    'extension\manifest.json', 'extension\background.js', 'extension\extract.js', 'extension\content.js',
    'extension\popup.html', 'extension\popup.js', 'extension\popup.css',
    'extension\settings.html', 'extension\settings.js', 'extension\settings.css',
    'extension\tests\extension.test.cjs', 'extension\tests\browser-qa.cjs', 'extension\tests\settings-qa.cjs',
    'tests\providers.test.mjs', 'tests\server.test.mjs', 'tests\settings.test.mjs'
)
$optionalAppFiles = @('tests\install.test.mjs', 'tests\host-config.test.mjs')
foreach ($relative in $appFiles) { Copy-ExportFile $appRoot $relative $appTargetRoot }
foreach ($relative in $optionalAppFiles) {
    if (Test-Path -LiteralPath (Join-Path $appRoot $relative) -PathType Leaf) { Copy-ExportFile $appRoot $relative $appTargetRoot }
}
foreach ($relative in @('SKILL.md','agents\openai.yaml','references\install.md')) { Copy-ExportFile $skillTemplateRoot $relative $skillTargetRoot }
Copy-ExportFile $repositoryTemplateRoot 'README.md' $repositoryRoot
Copy-ExportFile $repositoryTemplateRoot '.github\workflows\ci.yml' $repositoryRoot
Copy-ExportFile $repositoryTemplateRoot 'README.md' $appTargetRoot '使用说明.md'
Copy-ExportFile $appRoot '打包说明.md' $appTargetRoot
$ignore = "**/private/`n**/dist/`n**/node_modules/`n**/runtime/`n*.log`n"
[IO.File]::WriteAllText((Join-Path $repositoryRoot '.gitignore'),$ignore,(New-Object Text.UTF8Encoding $false))
[IO.File]::WriteAllText((Join-Path $appTargetRoot '.gitignore'),"private/`ndist/`nnode_modules/`nruntime/`n*.log`n",(New-Object Text.UTF8Encoding $false))

# Reject absolute per-user and messaging-cache source paths before publication.
$textFiles = Get-ChildItem -LiteralPath $repositoryRoot -Recurse -File
foreach ($file in $textFiles) {
    $text = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    if ($text -match '(?i)[A-Z]:[\\/]Users[\\/](?!Public(?:[\\/]|$)|Default(?:[\\/]|$))[^\\/\s"'']+[\\/]|[A-Z]:[\\/]xwechat[_]files[\\/]') {
        throw ('User-specific content found in export: ' + $file.FullName.Substring($repositoryRoot.Length + 1))
    }
}
$forbidden = $textFiles | Where-Object {
    $_.FullName.Substring($repositoryRoot.Length + 1) -match '(^|[\\/])(private|\.git|node_modules|runtime)([\\/]|$)' -or
    $_.Extension -match '^\.(exe|dll|pdf|jpg|jpeg|png|log|pem|key)$'
}
if ($forbidden) { throw 'Unexpected personal, binary or credential file entered source export.' }
$skillText = Get-Content -LiteralPath (Join-Path $skillTargetRoot 'SKILL.md') -Raw -Encoding UTF8
if ($skillText -notmatch '(?s)^---\s*\r?\n.*?name:\s*boss-greeting\s*\r?\n.*?description:.*?\r?\n---') { throw 'Skill frontmatter is missing or unexpected.' }
if (-not (Test-Path -LiteralPath (Join-Path $appTargetRoot 'scripts\install.mjs'))) { throw 'Skill is missing its executable app payload.' }

# A stable ZIP name is convenient; preserve a previous export instead of deleting it.
$zipPath = Join-Path $distRoot 'BOSS-Greeting-Skill-GitHub.zip'
if (Test-Path -LiteralPath $zipPath) {
    $archiveRoot = Join-Path $distRoot 'archive'
    New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
    Move-Item -LiteralPath $zipPath -Destination (Join-Path $archiveRoot ('BOSS-Greeting-Skill-GitHub-' + $buildId + '.zip'))
}
# Compress children so an uploaded ZIP expands directly into the repository root.
Compress-Archive -Path (Join-Path $repositoryRoot '*') -DestinationPath $zipPath -CompressionLevel Optimal
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entries = @($archive.Entries | ForEach-Object {$_.FullName.Replace('\','/')})
    foreach ($required in @('README.md','.gitignore','.github/workflows/ci.yml','skills/boss-greeting/SKILL.md','skills/boss-greeting/assets/app/.gitignore','skills/boss-greeting/assets/app/scripts/install.mjs','skills/boss-greeting/assets/app/server/providers.mjs')) {
        if (-not ($entries -contains $required)) { throw ('Source ZIP is missing: ' + $required) }
    }
    if ($entries | Where-Object { $_ -match '(^|/)(private|\.git|node_modules|runtime)(/|$)' -or $_ -match '\.(exe|dll|pdf|jpg|jpeg|png|log|pem|key)$' }) { throw 'Source ZIP contains forbidden personal/binary files.' }
    Write-Host ('Verified source ZIP entries: ' + $entries.Count)
} finally { $archive.Dispose() }
Write-Host ('Clean repository folder: ' + $repositoryRoot)
Write-Host ('GitHub source ZIP: ' + $zipPath)
Write-Host ('Source ZIP size: ' + [Math]::Round((Get-Item -LiteralPath $zipPath).Length / 1KB,2) + ' KiB')
Write-Host 'No remote repository was created or pushed.'
