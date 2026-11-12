param(
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [Parameter(Mandatory=$true)][string]$Operation,
    [Parameter(Mandatory=$true)][string]$StatePath,
    [ValidateSet('Preview','Apply','Deploy')][string]$Phase = 'Preview',
    [ValidateRange(0,1000000000000)][decimal]$ExpectedAmount = 0,
    [switch]$EnableApiCredit,
    [string]$SiteName = 'ahrampay.com'
)
$ErrorActionPreference = 'Stop'
if ($Operation -notmatch '^ATT-[A-Za-z0-9-]+$') { throw 'Invalid operation reference.' }
$live = (Resolve-Path -LiteralPath $ProjectPath).Path
$review = Split-Path -Parent $PSScriptRoot
$release = (& git -C $review rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $release -notmatch '^[a-f0-9]{40}$') { throw 'Reviewed release was not found.' }
$stateFile = [IO.Path]::GetFullPath($StatePath)
if ([IO.Path]::GetExtension($stateFile) -ne '.json' -or
    $stateFile.StartsWith($live.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Preview state must be a JSON file outside the live project.'
}
Set-Location -LiteralPath $live
$cli = Join-Path $PSScriptRoot 'resumeRecordedApiPayment.cjs'
function Read-Recovery([bool]$ApplyPayment, [string]$Expected = '') {
    $arguments = @($cli, '--project', $live, '--operation', $Operation)
    if ($EnableApiCredit) { $arguments += '--enable-api-credit' }
    if ($ApplyPayment) { $arguments += @('--apply', '--expected-updated-at', $Expected) }
    $output = & node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Recovery inspection or completion failed. No provider Payment is sent; inspect the current row before continuing.' }
    $result = (($output -join "`n") | ConvertFrom-Json)
    if ($result.success -ne $true) { throw 'Recovery did not succeed.' }
    if ($ExpectedAmount -gt 0 -and [decimal]$result.preview.moneyMovements[0].amount -ne -$ExpectedAmount) {
        throw 'Operation amount does not match the expected provider payment. No next phase was attempted.'
    }
    return $result
}
function Save-State($Value) {
    [IO.File]::WriteAllText($stateFile, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
}
function Assert-Completed($Result) {
    if ($Result.verification.status -ne 'completed' -or $Result.verification.providerResultUnresolved -ne $false -or
        [int]$Result.verification.executorDebitCount -ne 1 -or
        ($EnableApiCredit -and $Result.verification.apiSettlementMode -ne 'credit')) {
        throw 'Completion, single debit, or API credit policy was not verified. No deployment was attempted.'
    }
}
if ($Phase -eq 'Preview') {
    $preview = Read-Recovery $false
    $rowVersion = $preview.expectedUpdatedAt
    if (!$rowVersion) { $rowVersion = $preview.verification.updatedAt }
    if (!$rowVersion) { throw 'Recovery preview has no row version.' }
    Save-State ([pscustomobject]@{ project = $live; operation = $Operation; release = $release;
        apiCredit = [bool]$EnableApiCredit; expectedAmount = $ExpectedAmount; expectedUpdatedAt = $rowVersion })
    $preview | ConvertTo-Json -Depth 12
    Write-Output 'PREVIEW_ONLY: no balance, ledger, operation status, source, service or IIS change.'
    return
}
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if ($state.project -ne $live -or $state.operation -ne $Operation -or $state.release -ne $release -or
    [bool]$state.apiCredit -ne [bool]$EnableApiCredit -or [decimal]$state.expectedAmount -ne $ExpectedAmount) {
    throw 'Preview does not match this project, operation, amount, release or policy.'
}
if ($Phase -eq 'Apply') {
    $null = Read-Recovery $false
    $result = Read-Recovery $true $state.expectedUpdatedAt
    Assert-Completed $result
    $result | ConvertTo-Json -Depth 12
    Write-Output 'RECORDED_PAYMENT_COMPLETED: one executor debit verified; no provider Payment sent.'
    return
}
$current = Read-Recovery $false
Assert-Completed $current
$manifest = Join-Path $review ('clean-source-' + [Guid]::NewGuid().ToString('N') + '.json')
& node (Join-Path $PSScriptRoot 'prepareCleanServerRelease.cjs') --project $live --commit $release --output $manifest
if ($LASTEXITCODE -ne 0) { throw 'Clean source precheck failed. Local source was preserved.' }
$restart = Join-Path $PSScriptRoot 'restartAhramAfterDrain.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restart -ProjectPath $live -SiteName $SiteName -ReleaseCommit $release -ReviewManifestPath $manifest -SourceOnly
if ($LASTEXITCODE -ne 0) { throw 'Deployment precheck failed. No source update or restart was attempted.' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $restart -ProjectPath $live -SiteName $SiteName -ReleaseCommit $release -ReviewManifestPath $manifest -SourceOnly -Apply
if ($LASTEXITCODE -ne 0) { throw 'Guarded deployment did not finish. Inspect its output; do not force restart or reopen admission.' }
