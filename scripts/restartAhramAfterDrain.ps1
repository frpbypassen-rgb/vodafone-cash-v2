param(
    [string]$ProjectPath = (Get-Location).Path,
    [string]$SiteName = 'ahrampay.com',
    [ValidateRange(60,900)][int]$ReadyTimeoutSeconds = 360,
    [switch]$Apply,
    [switch]$UpdateDependencies,
    [string]$ReleaseCommit = ''
)
$ErrorActionPreference = 'Stop'
if ($Apply -and $ReleaseCommit -and !$UpdateDependencies) {
    throw 'Reviewed release installation requires -UpdateDependencies. No runtime or source was changed.'
}
Set-Location -LiteralPath $ProjectPath
$projectRoot = (Resolve-Path -LiteralPath '.').Path
$healthUrl = 'http://127.0.0.1:3000/health/ready'

function Read-ManagedApp {
    $output = & pm2 jlist | & node -e 'let s='''';process.stdin.on(''data'',d=>s+=d);process.stdin.on(''end'',()=>{const apps=JSON.parse(s),p=apps.find(x=>x.name===''ahram-pay'');if(!p||apps.some(x=>x!==p&&Number(x.pid)>0&&String(x.pm2_env.pm_cwd).toLowerCase()===String(p.pm2_env.pm_cwd).toLowerCase()))process.exit(1);else console.log(JSON.stringify({pid:p.pid,status:p.pm2_env.status,cwd:p.pm2_env.pm_cwd,script:p.pm2_env.pm_exec_path,mode:p.pm2_env.exec_mode,flags:[p.pm2_env.BULLMQ_WORKERS_ENABLED,p.pm2_env.FINANCIAL_SCHEDULERS_ENABLED,p.pm2_env.MERCHANT_WEBHOOK_WORKER_ENABLED]}));});'
    if ($LASTEXITCODE -ne 0) { throw 'PM2 inspection failed or duplicate project processes exist.' }
    return (($output -join "`n") | ConvertFrom-Json)
}
function Check-Empty {
    & node scripts/checkEmptyRuntime.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Open work exists or inspection is incomplete. No restart was performed.' }
}
function Assert-Owner($app, $health) {
    if ($app.status -ne 'online' -or $app.mode -ne 'fork_mode' -or [int]$app.pid -ne [int]$health.pid -or $health.status -ne 'ok' -or $health.startupReady -ne $true) { throw 'PM2 and ready process do not match.' }
    if ($app.cwd -ne $projectRoot -or $app.script -ne (Join-Path $projectRoot 'app.js')) { throw 'PM2 points to a different project.' }
    $owners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1 -or $owners[0] -ne [int]$app.pid) { throw 'Port 3000 owner does not match PM2.' }
}
$initialHealth = Invoke-RestMethod $healthUrl -TimeoutSec 10
$initialApp = Read-ManagedApp
Assert-Owner $initialApp $initialHealth
Check-Empty
$releaseInfo = $null
$releaseHelper = Join-Path $PSScriptRoot 'installReviewedServerRelease.cjs'
$reviewManifest = Join-Path $PSScriptRoot 'releases\server-local-20261112.json'
if ($ReleaseCommit) {
    $releaseOutput = & node $releaseHelper --project $projectRoot --commit $ReleaseCommit --manifest $reviewManifest
    if ($LASTEXITCODE -ne 0) { throw 'Reviewed source snapshot does not match. No live source was changed.' }
    $releaseInfo = (($releaseOutput -join "`n") | ConvertFrom-Json)
}
if (!$Apply) {
    Write-Output 'PRECHECK_PASS. Read-only inspection; no restart, IIS, firewall or financial changes.'
    return
}
$dependencyManifestHash = $null
$dependencyLockHash = $null
if ($UpdateDependencies) {
    $npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
    if ($releaseInfo) {
        $dependencyManifestHash = $releaseInfo.packageJsonSha256
        $dependencyLockHash = $releaseInfo.packageLockSha256
    } else {
        $dependencyManifestHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot 'package.json') -Algorithm SHA256).Hash
        $dependencyLockHash = (Get-FileHash -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Algorithm SHA256).Hash
    }
}
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator.' }
# Customers use HTTPS through IIS. Refuse to rely on IIS admission while the
# known public-port protection is disabled; never alter firewall settings here.
$portRule = Get-NetFirewallRule -PolicyStore ActiveStore -Name 'Ahram-Block-Public-TCP-3000' -ErrorAction Stop
if ($portRule.Enabled -ne 'True' -or $portRule.Action -ne 'Block' -or $portRule.Direction -ne 'Inbound') { throw 'Public port 3000 protection must remain enabled.' }
$portFilter = $portRule | Get-NetFirewallPortFilter
if ([string]$portFilter.Protocol -notin @('TCP','6') -or @($portFilter.LocalPort) -notcontains '3000') { throw 'The expected port 3000 firewall rule does not match.' }
if (@(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { !$_.Enabled }).Count) { throw 'Firewall profile disabled; cannot verify admission protection.' }
$publicHealth = Invoke-RestMethod ('https://' + $SiteName + '/health/ready') -TimeoutSec 15
if ([int]$publicHealth.pid -ne [int]$initialApp.pid -or $publicHealth.startupReady -ne $true) { throw 'Public HTTPS is serving a different runtime.' }
Import-Module WebAdministration
# Windows PowerShell can import the IIS provider without loading the separate
# managed administration assembly. Load the installed IIS assembly explicitly
# before constructing ServerManager; fail before changing admission if absent.
if (!('Microsoft.Web.Administration.ServerManager' -as [type])) {
    if ([IntPtr]::Size -ne 8) { throw 'Run this script in 64-bit Windows PowerShell as Administrator.' }
    $iisAssemblyPath = Join-Path $env:windir 'System32\inetsrv\Microsoft.Web.Administration.dll'
    if (!(Test-Path -LiteralPath $iisAssemblyPath -PathType Leaf)) { throw 'Installed IIS administration assembly was not found. No restart was performed.' }
    Add-Type -Path $iisAssemblyPath -ErrorAction Stop
}
$manager = New-Object Microsoft.Web.Administration.ServerManager
try {
    if (!$manager.Sites[$SiteName] -or $manager.Sites[$SiteName].State -ne 'Started') { throw 'Expected IIS site is not started.' }
    $rules = $manager.GetWebConfiguration($SiteName).GetSection('system.webServer/rewrite/rules').GetCollection()
    if (@($rules | Where-Object { [string]$_['name'] -like 'AhramPay-Deploy-*' }).Count) { throw 'An earlier deployment gate exists. Inspect it before proceeding.' }
} finally { $manager.Dispose() }
$gateName = 'AhramPay-Deploy-' + [Guid]::NewGuid().ToString('N')
$gateCreated = $false
$stopAttempted = $false
function Set-AdmissionGate([bool]$Enabled) {
    $gateManager = New-Object Microsoft.Web.Administration.ServerManager
    try {
        $rules = $gateManager.GetWebConfiguration($SiteName).GetSection('system.webServer/rewrite/rules').GetCollection()
        if ($Enabled) {
            $rule = $rules.CreateElement('rule')
            $rule['name'] = $gateName
            $rule['stopProcessing'] = $true
            $rule.GetChildElement('match')['url'] = '.*'
            $action = $rule.GetChildElement('action')
            $action['type'] = 'CustomResponse'
            $action['statusCode'] = 503
            $action['statusReason'] = 'Service Unavailable'
            $action['statusDescription'] = 'Ahram Pay update. Please retry shortly.'
            $rules.AddAt(0, $rule)
        } else {
            $matches = @($rules | Where-Object { [string]$_['name'] -eq $gateName })
            foreach ($rule in $matches) { $rules.Remove($rule) }
        }
        $gateManager.CommitChanges()
    } finally { $gateManager.Dispose() }
}
try {
    Set-AdmissionGate $true
    $gateCreated = $true
    $admissionClosed = $false
    try {
        $null = Invoke-WebRequest ('https://' + $SiteName + '/health/ready') -UseBasicParsing -TimeoutSec 10
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 503) { $admissionClosed = $true }
        else { throw }
    }
    if (!$admissionClosed) { throw 'IIS admission gate was not confirmed. Refusing restart.' }
    # Existing requests can still finish. Require two empty observations after
    # admission closes. A busy/unknown result aborts and reopens the old runtime.
    Start-Sleep -Seconds 15
    Check-Empty
    Start-Sleep -Seconds 5
    Check-Empty
    $beforeStop = Read-ManagedApp
    Assert-Owner $beforeStop (Invoke-RestMethod $healthUrl -TimeoutSec 10)
    if ([int]$beforeStop.pid -ne [int]$initialApp.pid) { throw 'Runtime changed during inspection.' }
    $stopAttempted = $true
    & pm2 stop ahram-pay
    if ($LASTEXITCODE -ne 0) { throw 'PM2 stop failed.' }
    for ($attempt=0; $attempt -lt 15 -and (Get-Process -Id $initialApp.pid -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Seconds 1 }
    if (Get-Process -Id $initialApp.pid -ErrorAction SilentlyContinue) { throw 'Old process is still alive. No force termination was attempted.' }
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3000 is still occupied. No process was killed.' }
    if ($releaseInfo) {
        $releaseBackup = Join-Path $env:LOCALAPPDATA ('Ahram-Reviewed-Release-' + [Guid]::NewGuid().ToString('N'))
        $installOutput = & node $releaseHelper --project $projectRoot --commit $ReleaseCommit --manifest $reviewManifest --backup $releaseBackup --stopped-pid $initialApp.pid --apply
        if ($LASTEXITCODE -ne 0) { throw ('Reviewed installation failed. Keep admission closed. Backup: ' + $releaseBackup) }
        $installedRelease = (($installOutput -join "`n") | ConvertFrom-Json)
        Write-Output ('RELEASE_INSTALLED=' + $installedRelease.release)
        if ($installedRelease.backup) { Write-Output ('RELEASE_BACKUP=' + $installedRelease.backup) }
    }
    if ($UpdateDependencies) {
        # Populate npm's cache in a separate directory BEFORE invoking this mode.
        # Preserve unchanged native modules; never run npm ci in the serving tree.
        # No downloads, lifecycle hooks, manifest edits or automatic retries here.
        if ((Get-FileHash -LiteralPath 'package.json' -Algorithm SHA256).Hash -ne $dependencyManifestHash -or
            (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash -ne $dependencyLockHash) {
            throw 'Dependency manifests changed before installation.'
        }
        & $npmCommand install --offline --ignore-scripts --no-audit --no-fund --no-save
        if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed. Admission remains closed.' }
        if ((Get-FileHash -LiteralPath 'package.json' -Algorithm SHA256).Hash -ne $dependencyManifestHash -or
            (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash -ne $dependencyLockHash) {
            throw 'Dependency manifests changed during installation.'
        }
        & node -e 'for(const name of [''bcryptjs'',''canvas'',''mongoose'',''connect-mongo''])require(name);console.log(''Runtime dependencies loaded.'');'
        if ($LASTEXITCODE -ne 0) { throw 'Dependency import check failed. Admission remains closed.' }
    }
    & pm2 restart ahram-pay --update-env
    if ($LASTEXITCODE -ne 0) { throw 'PM2 start failed.' }
    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $ready = $false
    do {
        Start-Sleep -Seconds 3
        try {
            $newHealth = Invoke-RestMethod $healthUrl -TimeoutSec 3
            $newApp = Read-ManagedApp
            Assert-Owner $newApp $newHealth
            if (($initialApp.flags | ConvertTo-Json -Compress) -ne ($newApp.flags | ConvertTo-Json -Compress)) { throw 'Runtime flags changed.' }
            $ready = $true
        } catch {}
    } while (!$ready -and [DateTime]::UtcNow -lt $deadline)
    if (!$ready) { throw 'Startup readiness was not confirmed.' }
    Set-AdmissionGate $false
    $gateCreated = $false
    & pm2 save
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Runtime is ready, but PM2 save failed.' }
    $newHealth | Format-List status,pid,startupReady,db,sessionStore,redis
    Write-Output 'SUCCESS: ready PM2 runtime verified; HTTPS admission reopened.'
} catch {
    if ($gateCreated -and !$stopAttempted) {
        Set-AdmissionGate $false
        $gateCreated = $false
        Write-Output 'Restart aborted before stopping the application. HTTPS admission restored.'
    }
    if ($gateCreated) {
        Write-Output ('Temporary IIS gate: ' + $gateName)
        Write-Output 'Runtime readiness is unconfirmed. Keep admission closed and send: pm2 logs ahram-pay --lines 60 --nostream'
    }
    throw
}
