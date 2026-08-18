[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ServiceAccountPath,

    [string]$EnvPath = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env'),

    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$resolvedServiceAccountPath = (Resolve-Path -LiteralPath $ServiceAccountPath).Path
$resolvedEnvPath = if (Test-Path -LiteralPath $EnvPath) {
    (Resolve-Path -LiteralPath $EnvPath).Path
} else {
    [IO.Path]::GetFullPath($EnvPath)
}

if (-not (Test-Path -LiteralPath $resolvedEnvPath)) {
    throw "Environment file not found: $resolvedEnvPath"
}

$serviceAccountBytes = [IO.File]::ReadAllBytes($resolvedServiceAccountPath)
$serviceAccount = [Text.Encoding]::UTF8.GetString($serviceAccountBytes) | ConvertFrom-Json

foreach ($requiredField in @('project_id', 'client_email', 'private_key')) {
    if ([string]::IsNullOrWhiteSpace([string]$serviceAccount.$requiredField)) {
        throw "Service account JSON is missing $requiredField"
    }
}

$encodedServiceAccount = [Convert]::ToBase64String($serviceAccountBytes)
$source = [IO.File]::ReadAllText($resolvedEnvPath)
$newline = if ($source.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = [Collections.Generic.List[string]]::new()
foreach ($line in ($source -replace '^\uFEFF', '' -split '\r?\n')) {
    $lines.Add($line)
}

function Set-EnvironmentValue {
    param(
        [Collections.Generic.List[string]]$Lines,
        [string]$Key,
        [string]$Value
    )

    $pattern = '^\s*(?:export\s+)?' + [Regex]::Escape($Key) + '\s*='
    $indices = [Collections.Generic.List[int]]::new()
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match $pattern) {
            $indices.Add($index)
        }
    }

    if ($indices.Count -eq 0) {
        if ($Lines.Count -gt 0 -and $Lines[$Lines.Count - 1] -ne '') {
            $Lines.Add('')
        }
        $Lines.Add("$Key=$Value")
        return
    }

    $keepIndex = $indices[$indices.Count - 1]
    $Lines[$keepIndex] = "$Key=$Value"
    for ($position = $indices.Count - 2; $position -ge 0; $position--) {
        $Lines.RemoveAt($indices[$position])
    }
}

$settings = [ordered]@{
    FCM_ENABLED                     = 'true'
    FIREBASE_SERVICE_ACCOUNT_BASE64 = $encodedServiceAccount
    FIREBASE_PROJECT_ID             = [string]$serviceAccount.project_id
    FIREBASE_CLIENT_EMAIL           = [string]$serviceAccount.client_email
    FCM_WORKER_INTERVAL_MS          = '3000'
    FCM_DEVICE_ACTIVE_DAYS          = '90'
}

foreach ($entry in $settings.GetEnumerator()) {
    Set-EnvironmentValue -Lines $lines -Key $entry.Key -Value $entry.Value
}

while ($lines.Count -gt 1 -and $lines[$lines.Count - 1] -eq '' -and $lines[$lines.Count - 2] -eq '') {
    $lines.RemoveAt($lines.Count - 1)
}

$backupPath = "$resolvedEnvPath.firebase-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$result = (($lines -join $newline).TrimEnd("`r", "`n")) + $newline

if ($PSCmdlet.ShouldProcess($resolvedEnvPath, 'Enable Firebase Cloud Messaging')) {
    Copy-Item -LiteralPath $resolvedEnvPath -Destination $backupPath -Force
    [IO.File]::WriteAllText($resolvedEnvPath, $result, [Text.UTF8Encoding]::new($false))

    Write-Host 'Firebase push configuration applied.'
    Write-Host "Project: $($serviceAccount.project_id)"
    Write-Host "Service account: $($serviceAccount.client_email)"
    Write-Host "Backup: $backupPath"

    if ($Restart) {
        $appRoot = Split-Path $PSScriptRoot -Parent
        $pm2 = (Get-Command pm2 -ErrorAction Stop).Source
        Push-Location $appRoot
        try {
            & $pm2 startOrRestart .\ecosystem.config.js --env production --update-env
            if ($LASTEXITCODE -ne 0) {
                throw "PM2 restart failed with exit code $LASTEXITCODE"
            }
            & $pm2 save
        } finally {
            Pop-Location
        }
    }
}
