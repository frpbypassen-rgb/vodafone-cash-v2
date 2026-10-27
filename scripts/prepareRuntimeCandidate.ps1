param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Revision,
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [switch]$SkipDependencyInstall
)

# Preparation only. Never invokes PM2, the application, IIS, workers or database code.
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $ProjectPath).Path.TrimEnd('\', '/')
$destinationRoot = [IO.Path]::GetFullPath($DestinationPath).TrimEnd('\', '/')
if ($destinationRoot.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $destinationRoot.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $sourceRoot.StartsWith($destinationRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Candidate must be outside the serving project.'
}
if (Test-Path -LiteralPath $destinationRoot) { throw 'Candidate destination already exists; nothing was overwritten.' }
$parent = Split-Path -Parent $destinationRoot
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Candidate parent directory must already exist.' }
function Assert-NoReparseChain {
    param([string]$PathValue)
    $item = Get-Item -LiteralPath $PathValue
    while ($item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Preparation paths cannot pass through reparse points.' }
        $item = $item.Parent
    }
}
Assert-NoReparseChain $sourceRoot
Assert-NoReparseChain $parent

function Get-PrivateFileHash {
    param([string]$FilePath)
    $stream = [IO.File]::OpenRead($FilePath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)) }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Invoke-SafeGit {
    param([string]$Root, [string[]]$GitArguments)
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5 represents harmless Git stderr warnings as error records.
        $ErrorActionPreference = 'Continue'
        $result = & git -C $Root @GitArguments 2>$null
        $gitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($gitCode -ne 0) { throw 'Git preparation failed; serving files and processes were not changed.' }
    return $result
}
function Assert-RegularSourceFile {
    param([string]$RelativePath)
    $file = Join-Path $sourceRoot $RelativePath
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Required source file is missing.' }
    Assert-NoReparseChain $file
    return $file
}

$sourceRevision = (Invoke-SafeGit $sourceRoot @('rev-parse', 'HEAD')).Trim()
$verifiedRevision = (Invoke-SafeGit $sourceRoot @('rev-parse', '--verify', ($Revision + '^{commit}'))).Trim()
if ($verifiedRevision -ne $Revision) { throw 'Candidate revision is not available locally.' }
$approvedTracked = @('models/ApiBalanceAudit.js', 'models/ExecutorGroup.js', 'routes/executors.js', 'services/apiProviderReconciliationService.js', 'views/api_room.ejs')
$approvedNew = @('services/apiProfitCommissionService.js', 'utils/apiProfitCommission.js', 'views/partials/api_profit_commission.ejs')
$changed = @(Invoke-SafeGit $sourceRoot @('diff', '--name-only', 'HEAD', '--'))
$nestedGitChanges = @($changed | Where-Object { $_ -eq 'vodafone-cash-v2' })
$unapproved = @($changed | Where-Object { $_ -notin $approvedTracked -and $_ -ne 'vodafone-cash-v2' })
if ($unapproved.Count) { throw 'Unexpected tracked modifications; review them before preparing a candidate.' }
$untracked = @(Invoke-SafeGit $sourceRoot @('ls-files', '--others', '--exclude-standard'))
$runtimeUntracked = @($untracked | Where-Object { $_ -match '^(services|utils|views|routes|models|controllers|config)/' -and $_ -notin $approvedNew })
if ($runtimeUntracked.Count) { throw 'Unexpected untracked runtime files; review them before preparing a candidate.' }
$newFiles = @($approvedNew | Where-Object { $_ -in $untracked })
$sourceHashes = @{}
foreach ($relative in (@($changed | Where-Object { $_ -ne 'vodafone-cash-v2' }) + $newFiles + @('.env'))) {
    $file = Assert-RegularSourceFile $relative
    $sourceHashes[$relative] = Get-PrivateFileHash $file
}

# No hard links: candidate dependencies and files must be independent of the live copy.
[void](Invoke-SafeGit $parent @('clone', '--no-hardlinks', '--no-checkout', '--quiet', '--', $sourceRoot, $destinationRoot))
[void](Invoke-SafeGit $destinationRoot @('fetch', '--quiet', $sourceRoot, $Revision))
[void](Invoke-SafeGit $destinationRoot @('checkout', '--quiet', '--detach', $Revision))
if (-not (Select-String -LiteralPath (Join-Path $destinationRoot 'app.js') -SimpleMatch 'runtimeRoleGate(process.env)' -Quiet)) { throw 'Candidate does not implement the probe gate.' }
if (-not (Test-Path -LiteralPath (Join-Path $destinationRoot 'ecosystem.runtime-probe.config.js'))) { throw 'Candidate probe config is missing.' }
$patchPath = Join-Path $destinationRoot 'runtime-source-local.patch'
[void](Invoke-SafeGit $sourceRoot (@('diff', '--binary', '--full-index', ('--output=' + $patchPath), 'HEAD', '--') + $approvedTracked))
if ((Get-Item -LiteralPath $patchPath).Length -gt 0) {
    [void](Invoke-SafeGit $destinationRoot @('apply', '--3way', '--index', $patchPath))
}
foreach ($relative in $newFiles) {
    $destinationFile = Join-Path $destinationRoot $relative
    if (Test-Path -LiteralPath $destinationFile) { throw 'New local file conflicts with the candidate; no source files changed.' }
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $destinationFile))
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $destinationFile
}
# Copy secrets without printing or committing them. Candidate inherits the same private parent ACL.
Copy-Item -LiteralPath (Join-Path $sourceRoot '.env') -Destination (Join-Path $destinationRoot '.env')
foreach ($relative in $sourceHashes.Keys) {
    if ((Get-PrivateFileHash (Join-Path $sourceRoot $relative)) -ne $sourceHashes[$relative]) { throw 'Source changed during preparation; candidate must not be started.' }
}
if ((Invoke-SafeGit $sourceRoot @('rev-parse', 'HEAD')).Trim() -ne $sourceRevision) { throw 'Source revision changed during preparation.' }
$afterChanges = @(Invoke-SafeGit $sourceRoot @('diff', '--name-only', 'HEAD', '--'))
if (($changed -join "`n") -ne ($afterChanges -join "`n")) { throw 'Source working tree changed during preparation.' }
$afterUntracked = @(Invoke-SafeGit $sourceRoot @('ls-files', '--others', '--exclude-standard'))
if (($untracked -join "`n") -ne ($afterUntracked -join "`n")) { throw 'Source untracked files changed during preparation.' }
[void](Invoke-SafeGit $destinationRoot @('diff', '--cached', '--check'))

$syntaxFiles = @('app.js', 'utils/runtimeRole.js', 'ecosystem.runtime-probe.config.js') + @($changed + $newFiles | Where-Object { $_ -match '\.(js|cjs)$' })
foreach ($relative in ($syntaxFiles | Select-Object -Unique)) {
    & node --check (Join-Path $destinationRoot $relative) *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Candidate syntax validation failed.' }
}
if (-not $SkipDependencyInstall) {
    Push-Location -LiteralPath $destinationRoot
    try {
        # Disable lifecycle hooks: preparation itself must not execute application startup code.
        $savedPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & npm ci --ignore-scripts --no-audit --no-fund *> (Join-Path $destinationRoot 'runtime-dependency-install.log')
        $installCode = $LASTEXITCODE
        $ErrorActionPreference = $savedPreference
        if ($installCode -ne 0) { throw 'Candidate dependency installation failed; inspect its private log. Live dependencies were not touched.' }
    } finally { Pop-Location }
}

[PSCustomObject]@{
    prepared = $true
    candidatePath = $destinationRoot
    candidateRevision = $Revision
    sourceRevision = $sourceRevision
    appliedTrackedFiles = @($changed | Where-Object { $_ -in $approvedTracked })
    copiedNewFiles = $newFiles
    nestedGitChangesExcluded = $nestedGitChanges.Count
    dependenciesInstalled = -not [bool]$SkipDependencyInstall
    dependencyLifecycleHooksRun = $false
    sourceFilesUnchanged = $true
    processesChanged = $false
    nextStep = 'PRIVATE_PROBE_ONLY; not ready for public traffic. Native dependencies and source environment still require validation.'
} | ConvertTo-Json -Depth 4
