[CmdletBinding()]
param(
    [string]$CheckoutRoot,
    [string]$BranchName,
    [switch]$PrepareOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($CheckoutRoot)) {
    $CheckoutRoot = Join-Path (Split-Path -Parent $ProjectRoot) 'lhwiki-latest-pr'
}
$CheckoutRoot = (Resolve-Path -LiteralPath $CheckoutRoot).Path
$PublicRoot = Join-Path $CheckoutRoot 'LHwiki-source-20260808'
$WorkspaceRoot = (Resolve-Path (Join-Path $ProjectRoot '..\..\..')).Path

function Invoke-Native {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

function Assert-Command {
    param([Parameter(Mandatory)] [string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Assert-SyncthingReady {
    $conflicts = @(Get-ChildItem -LiteralPath $WorkspaceRoot -Recurse -Force -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*.sync-conflict-*' })
    if ($conflicts.Count -gt 0) {
        $paths = $conflicts.FullName -join [Environment]::NewLine
        throw "Syncthing conflict files found:`n$paths"
    }

    if (-not (Get-Process -Name syncthing -ErrorAction SilentlyContinue)) {
        throw 'Syncthing is not running.'
    }

    $configPath = Join-Path $env:LOCALAPPDATA 'Syncthing\config.xml'
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "Syncthing config not found: $configPath"
    }

    [xml]$config = Get-Content -LiteralPath $configPath -Raw
    $apiKey = [string]$config.configuration.gui.apikey
    $address = [string]$config.configuration.gui.address
    if ([string]::IsNullOrWhiteSpace($address)) {
        $address = '127.0.0.1:8384'
    }
    if ($address -like '0.0.0.0:*') {
        $address = $address -replace '^0.0.0.0:', '127.0.0.1:'
    }
    if ($address -notmatch '^https?://') {
        $address = 'http://' + $address
    }

    $headers = @{ 'X-API-Key' = $apiKey }
    $folders = @($config.configuration.folder | Where-Object {
        $folderPath = ([string]$_.path).TrimEnd('\')
        $WorkspaceRoot -eq $folderPath -or $WorkspaceRoot.StartsWith($folderPath + '\')
    })
    if ($folders.Count -eq 0) {
        throw "No Syncthing folder owns $WorkspaceRoot"
    }

    foreach ($folder in $folders) {
        $folderId = [uri]::EscapeDataString([string]$folder.id)
        $status = Invoke-RestMethod -Uri "$address/rest/db/status?folder=$folderId" -Headers $headers -Method Get
        if ($status.state -ne 'idle' -or $status.needFiles -ne 0 -or $status.needBytes -ne 0 -or $status.errors -ne 0) {
            throw "Syncthing folder $($folder.id) is not ready: state=$($status.state), needFiles=$($status.needFiles), needBytes=$($status.needBytes), errors=$($status.errors)"
        }
    }
}

function Test-ExcludedRelativePath {
    param([Parameter(Mandatory)] [string]$RelativePath)

    $path = $RelativePath.Replace('\', '/')
    $segments = $path.Split('/')
    $blockedDirectories = @('.git', 'node_modules', '.wrangler', 'dist', 'work', 'outputs', 'release', 'archive')
    if ($segments | Where-Object { $_ -in $blockedDirectories }) {
        return $true
    }

    $name = [IO.Path]::GetFileName($path)
    if ($name -in @('.dev.vars', 'cloudbaserc.json', 'deployment.log', 'd1-export.private.sql')) {
        return $true
    }
    if ($name -match '\.private\.' -or $name -match '\.(clixml|pem|key)$') {
        return $true
    }
    if ($name -like '.env*' -and $name -ne '.env.example') {
        return $true
    }
    return $false
}

function Copy-PublicTree {
    $safeFiles = @(
        '.dev.vars.example',
        '.gitignore',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'GITHUB发布说明.md',
        'LICENSE',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'README.md',
        'schema.sql',
        'SECURITY.md',
        'wrangler.jsonc'
    )
    $safeDirectories = @('.agents', '.github', 'cloudbase', 'public', 'scripts', 'shared', 'specs', 'test', 'worker')

    New-Item -ItemType Directory -Force -Path $PublicRoot | Out-Null
    foreach ($relative in $safeFiles) {
        $source = Join-Path $ProjectRoot $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Required public file is missing: $relative"
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $PublicRoot $relative) -Force
    }

    $backupReadme = Join-Path $ProjectRoot 'backup\README.md'
    if (-not (Test-Path -LiteralPath $backupReadme -PathType Leaf)) {
        throw 'Public backup/README.md is missing.'
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $PublicRoot 'backup') | Out-Null
    Copy-Item -LiteralPath $backupReadme -Destination (Join-Path $PublicRoot 'backup\README.md') -Force

    foreach ($directory in $safeDirectories) {
        $sourceDirectory = Join-Path $ProjectRoot $directory
        $destinationDirectory = Join-Path $PublicRoot $directory
        if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
            throw "Required public directory is missing: $directory"
        }
        New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null

        $sourceFiles = @{}
        foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory -Recurse -Force -File) {
            $relative = [IO.Path]::GetRelativePath($sourceDirectory, $file.FullName)
            if (Test-ExcludedRelativePath $relative) {
                continue
            }
            $sourceFiles[$relative.ToLowerInvariant()] = $true
            $destination = Join-Path $destinationDirectory $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
        }

        foreach ($file in Get-ChildItem -LiteralPath $destinationDirectory -Recurse -Force -File -ErrorAction SilentlyContinue) {
            $relative = [IO.Path]::GetRelativePath($destinationDirectory, $file.FullName)
            if (-not $sourceFiles.ContainsKey($relative.ToLowerInvariant())) {
                Remove-Item -LiteralPath $file.FullName -Force
            }
        }
    }
}

function Update-RepositorySummary {
    param(
        [Parameter(Mandatory)] [string]$Version,
        [Parameter(Mandatory)] [string[]]$LatestBullets
    )

    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'CHANGELOG.md') -Destination (Join-Path $CheckoutRoot 'CHANGELOG.md') -Force
    $readmePath = Join-Path $CheckoutRoot 'README.md'
    $readme = Get-Content -LiteralPath $readmePath -Raw
    $readme = [regex]::Replace($readme, '- 当前版本：\*\*v[^*]+\*\*', "- 当前版本：**v$Version**")
    $recent = "## 最近更新`r`n`r`n" + ($LatestBullets -join "`r`n") + "`r`n`r`n"
    $readme = [regex]::Replace($readme, '(?s)## 最近更新\r?\n.*?(?=## 本地测试)', $recent)
    $readme = $readme.TrimEnd("`r", "`n") + "`r`n"
    Set-Content -LiteralPath $readmePath -Value $readme -Encoding utf8 -NoNewline
}

function Assert-PublicSafety {
    $forbiddenFiles = @(Get-ChildItem -LiteralPath $PublicRoot -Recurse -Force -File | Where-Object {
        $relative = [IO.Path]::GetRelativePath($PublicRoot, $_.FullName)
        Test-ExcludedRelativePath $relative
    })
    if ($forbiddenFiles.Count -gt 0) {
        throw "Forbidden files entered the public tree: $($forbiddenFiles.FullName -join ', ')"
    }

    $secretPatterns = @(
        '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
        '\bgh[opsu]_[A-Za-z0-9]{20,}\b',
        '\bAKID[A-Za-z0-9]{16,}\b'
    )
    $secretPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in Get-ChildItem -LiteralPath $PublicRoot -Recurse -Force -File) {
        if ($file.Length -gt 5MB) {
            continue
        }
        foreach ($pattern in $secretPatterns) {
            $matches = @(Select-String -LiteralPath $file.FullName -Pattern $pattern -ErrorAction SilentlyContinue)
            $unsafeMatches = @($matches | Where-Object {
                $relative = [IO.Path]::GetRelativePath($PublicRoot, $file.FullName).Replace('\', '/')
                -not ($relative -eq 'test/codebuddy-integration.test.js' -and $_.Line -match 'containsSensitiveContent\(')
            })
            if ($unsafeMatches.Count -gt 0) {
                [void]$secretPaths.Add($file.FullName)
            }
        }
    }
    if ($secretPaths.Count -gt 0) {
        throw "Possible secret material found in: $($secretPaths -join ', ')"
    }
}

Assert-Command git
Assert-Command gh
Assert-Command pnpm
Assert-SyncthingReady

$package = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid package version: $version"
}
if ([string]::IsNullOrWhiteSpace($BranchName)) {
    $BranchName = "codex/lhwiki-v$version-updates"
}

$changelog = Get-Content -LiteralPath (Join-Path $ProjectRoot 'CHANGELOG.md') -Raw
$escapedVersion = [regex]::Escape($version)
$headingMatch = [regex]::Match($changelog, "(?m)^## v$escapedVersion — (?<title>[^\r\n]+)")
if (-not $headingMatch.Success) {
    throw "CHANGELOG.md has no entry for v$version"
}
$latestTitle = $headingMatch.Groups['title'].Value -replace '\s*（\d{4}-\d{2}-\d{2}）\s*$', ''
$sectionMatch = [regex]::Match($changelog, "(?ms)^## v$escapedVersion — [^\r\n]+\r?\n(?<body>.*?)(?=^## v|\z)")
$latestBullets = @($sectionMatch.Groups['body'].Value -split '\r?\n' | Where-Object { $_ -match '^- ' })
if ($latestBullets.Count -eq 0) {
    throw "CHANGELOG.md v$version entry has no release bullets"
}

if (-not (Test-Path -LiteralPath (Join-Path $CheckoutRoot '.git'))) {
    throw "Checkout is not a Git repository: $CheckoutRoot"
}
$initialStatus = @(& git -C $CheckoutRoot status --porcelain)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read the publication checkout status.'
}
if ($initialStatus.Count -gt 0) {
    throw "Publication checkout is not clean:`n$($initialStatus -join [Environment]::NewLine)"
}

Invoke-Native git -C $CheckoutRoot fetch origin --prune
Invoke-Native git -C $CheckoutRoot switch main
Invoke-Native git -C $CheckoutRoot pull --ff-only origin main

$localBranch = @(& git -C $CheckoutRoot branch --list $BranchName)
if ($localBranch.Count -gt 0) {
    throw "Local branch already exists: $BranchName"
}
$remoteBranch = @(& git -C $CheckoutRoot ls-remote --heads origin $BranchName)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to check the remote release branch.'
}
if ($remoteBranch.Count -gt 0) {
    throw "Remote branch already exists: $BranchName"
}
Invoke-Native git -C $CheckoutRoot switch -c $BranchName

Copy-PublicTree
Update-RepositorySummary -Version $version -LatestBullets $latestBullets
Assert-PublicSafety

Push-Location $ProjectRoot
try {
    Invoke-Native pnpm test
}
finally {
    Pop-Location
}
Push-Location $PublicRoot
try {
    Invoke-Native pnpm test
}
finally {
    Pop-Location
}
Invoke-Native git -C $CheckoutRoot diff --check

$changed = @(& git -C $CheckoutRoot status --short)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read prepared changes.'
}
if ($changed.Count -eq 0) {
    throw 'No public changes were found.'
}

Write-Output "Prepared LHwiki v$version on $BranchName"
Write-Output ($changed -join [Environment]::NewLine)
if ($PrepareOnly) {
    Write-Output 'PrepareOnly: skipped commit, push, and PR creation.'
    exit 0
}

Invoke-Native git -C $CheckoutRoot add -- README.md CHANGELOG.md LHwiki-source-20260808
$staged = @(& git -C $CheckoutRoot diff --cached --name-only)
if ($LASTEXITCODE -ne 0 -or $staged.Count -eq 0) {
    throw 'No staged publication changes were found.'
}
Invoke-Native git -C $CheckoutRoot commit -m "发布 LHwiki v$version 更新"
Invoke-Native git -C $CheckoutRoot push -u origin $BranchName

$existingPr = (& gh pr list --repo ray-oriental/LHwiki --head $BranchName --state open --json url --jq '.[0].url').Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to query an existing pull request.'
}
if ([string]::IsNullOrWhiteSpace($existingPr)) {
    $bodyPath = [IO.Path]::GetTempFileName()
    try {
        $body = @(
            '## 概要',
            '',
            "发布 LHwiki v$version（$latestTitle），同步正式源码中的公开文件。",
            '',
            '## 更新',
            '',
            ($latestBullets -join "`r`n"),
            '',
            '## 验证',
            '',
            '- `pnpm test`（正式源码）',
            '- `pnpm test`（GitHub 发布副本）',
            '- `git diff --check`',
            '- 敏感文件名与常见密钥模式检查',
            '',
            '本 PR 只更新公开源码，不执行生产部署、数据库迁移或 PR 合并。'
        ) -join "`r`n"
        Set-Content -LiteralPath $bodyPath -Value $body -Encoding utf8
        $existingPr = (& gh pr create --repo ray-oriental/LHwiki --base main --head $BranchName --title "发布 LHwiki v$version：$latestTitle" --body-file $bodyPath).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw 'GitHub PR creation failed.'
        }
    }
    finally {
        Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
    }
}

$head = (& git -C $CheckoutRoot rev-parse HEAD).Trim()
Write-Output "PR=$existingPr"
Write-Output "BRANCH=$BranchName"
Write-Output "HEAD=$head"
