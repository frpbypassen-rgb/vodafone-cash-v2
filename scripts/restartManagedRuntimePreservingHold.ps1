param(
    [string]$ProjectPath = (Get-Location).Path,
    [string]$HeldId = '6ae33154246256837d770bde',
    [switch]$AllowSettled,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $ProjectPath
function Check-Hold([string]$ExpectedHash) {
    $arguments = @('scripts/checkHeldRuntimeRestart.cjs', $HeldId)
    if ($ExpectedHash) { $arguments += $ExpectedHash }
    if ($AllowSettled) { $arguments += '--allow-settled' }
    $output = & node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Hold or work inspection failed; no transaction was modified.' }
    $report = ($output -join "`n") | ConvertFrom-Json
    if ($report.ok -ne $true -or $report.heldHash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid hold inspection.' }
    if (!$ExpectedHash) { Write-Host ('Protected transaction status: ' + $report.protectedStatus) }
    return $report.heldHash
}
function Read-App {
    $output = & pm2 jlist | & node -e 'let s='''';process.stdin.on(''data'',d=>s+=d);process.stdin.on(''end'',()=>{const a=JSON.parse(s);const p=a.find(x=>x.name===''ahram-pay'');if(!p||a.some(x=>x.name!==''ahram-pay''&&Number(x.pid)>0&&[''Ahram_Core_API'',''Ahram_Staging_API''].includes(x.name)))process.exit(1);else console.log(JSON.stringify({pid:p.pid,status:p.pm2_env.status,cwd:p.pm2_env.pm_cwd,script:p.pm2_env.pm_exec_path,workers:p.pm2_env.BULLMQ_WORKERS_ENABLED,schedulers:p.pm2_env.FINANCIAL_SCHEDULERS_ENABLED,webhooks:p.pm2_env.MERCHANT_WEBHOOK_WORKER_ENABLED}));});'
    if ($LASTEXITCODE -ne 0) { throw 'Unexpected PM2 application state.' }
    return (($output -join "`n") | ConvertFrom-Json)
}
$root = (Resolve-Path -LiteralPath '.').Path
& git merge-base --is-ancestor 21f6fd9 HEAD
if ($LASTEXITCODE -ne 0) { throw 'Required login update is not installed.' }
& git diff --quiet HEAD -- services/providerDispatchClaimService.js services/queueService.js
if ($LASTEXITCODE -ne 0) { throw 'Financial dispatch guards have local modifications; manual review required.' }
$snapshot = Check-Hold
$app = Read-App
$health = Invoke-RestMethod 'http://127.0.0.1:3000/health/ready' -TimeoutSec 10
if ($health.status -ne 'ok' -or $health.startupReady -ne $true -or [int]$health.pid -ne [int]$app.pid -or $app.status -ne 'online') { throw 'PM2 and live process do not match.' }
if ($app.cwd -ne $root -or $app.script -ne (Join-Path $root 'app.js')) { throw 'PM2 points to a different project.' }
$oldPid = [int]$health.pid
$oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
if ($oldProcess.Name -ne 'node.exe' -or $oldProcess.CommandLine -notmatch 'ProcessContainerFork\.js') { throw 'Unexpected live process.' }
if (!$Apply) {
    Write-Output 'PRECHECK_PASS: protected transaction and empty queues verified. No process, IIS, firewall or financial data changed.'
    return
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator.' }
Import-Module WebAdministration
if ((Get-Website -Name 'ahrampay.com').State -ne 'Started') { throw 'IIS site is not started.' }
$rule = 'AhramPay-Held-Maintenance-' + [Guid]::NewGuid().ToString('N')
$ruleCreated = $false
$siteStopped = $false
try {
    New-NetFirewallRule -Name $rule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Block -Profile Any -Enabled True | Out-Null
    $ruleCreated = $true
    Stop-Website -Name 'ahrampay.com'
    $siteStopped = $true
    Start-Sleep -Seconds 15
    $null = Check-Hold $snapshot
    Start-Sleep -Seconds 5
    $null = Check-Hold $snapshot
    $current = Read-App
    $owners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
    if ([int]$current.pid -ne $oldPid -or $owners.Count -ne 1 -or $owners[0] -ne $oldPid -or !$process -or $process.CreationDate -ne $oldProcess.CreationDate) { throw 'Process ownership changed.' }
    & pm2 stop ahram-pay
    if ($LASTEXITCODE -ne 0) { throw 'PM2 stop failed.' }
    for ($i=0; $i -lt 10 -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
    $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
    if ($remaining) {
        $owners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($remaining.CreationDate -ne $oldProcess.CreationDate -or $remaining.CommandLine -notmatch 'ProcessContainerFork\.js' -or $owners.Count -ne 1 -or $owners[0] -ne $oldPid) { throw 'Refusing to terminate an unverified process.' }
        $null = Check-Hold $snapshot
        Stop-Process -Id $oldPid -Force
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { Wait-Process -Id $oldPid -Timeout 15 }
    }
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3000 is still occupied.' }
    & pm2 restart ahram-pay --update-env
    if ($LASTEXITCODE -ne 0) { throw 'PM2 start failed.' }
    $ready = $false
    for ($i=0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 3
        try {
            $newHealth = Invoke-RestMethod 'http://127.0.0.1:3000/health/ready' -TimeoutSec 3
            $newApp = Read-App
            if ($newHealth.status -eq 'ok' -and $newHealth.startupReady -eq $true -and [int]$newHealth.pid -eq [int]$newApp.pid) { $ready=$true;break }
        } catch {}
    }
    if (!$ready) { throw 'New runtime is not ready.' }
    foreach ($flag in @('workers','schedulers','webhooks')) { if ([string]$app.$flag -ne [string]$newApp.$flag) { throw 'Background runtime flags changed.' } }
    $null = Check-Hold $snapshot
    $asset = Invoke-WebRequest 'http://127.0.0.1:3000/js/login-location.js?verify=held-restart' -UseBasicParsing -TimeoutSec 10
    if ($asset.Headers['Cache-Control'] -notmatch 'no-store') { throw 'New login cache policy is not active.' }
    Start-Website -Name 'ahrampay.com'
    $siteStopped=$false
    Remove-NetFirewallRule -Name $rule
    $ruleCreated=$false
    & pm2 save
    if ($LASTEXITCODE -ne 0) { throw 'Runtime is ready but PM2 save failed.' }
    $newHealth | Format-List status,pid,startupReady,db,sessionStore,redis
    Write-Output 'SUCCESS: new runtime ready; protected transaction was unchanged at final verification; site reopened.'
} catch {
    $originalError = $_
    $stillOld = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
    $owners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($stillOld -and $stillOld.CreationDate -eq $oldProcess.CreationDate -and $owners -contains $oldPid) {
        if ($siteStopped) { Start-Website -Name 'ahrampay.com' }
        if ($ruleCreated) { Remove-NetFirewallRule -Name $rule }
    } else {
        Write-Output "Maintenance rule (if still present): $rule"
        Write-Output 'Do not open traffic until ready. Send the error and: pm2 logs ahram-pay --lines 60 --nostream'
    }
    throw $originalError
}
