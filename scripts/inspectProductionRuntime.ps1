param(
    [string]$ProjectPath = (Get-Location).Path,
    [int]$Port = 3000
)

# Read-only inventory. Never prints process arguments, PM2 environments, .env or tokens.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $ProjectPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json'))) { throw 'Project package.json not found.' }
$processes = @(Get-CimInstance Win32_Process)
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
$listenerIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
$nodeProcesses = @($processes | Where-Object { $_.Name -match '^(node|w3wp|nginx|httpd)\.exe$' } | ForEach-Object {
    [PSCustomObject]@{
        processId = $_.ProcessId
        parentProcessId = $_.ParentProcessId
        executable = $_.ExecutablePath
        ownsRequestedPort = $_.ProcessId -in $listenerIds
        pm2Daemon = [bool]($_.CommandLine -match '[\\/]pm2[\\/]lib[\\/]Daemon\.js')
        pm2Container = [bool]($_.CommandLine -match 'ProcessContainer(Fork)?\.js')
        mentionsProject = [bool]($_.CommandLine -and $_.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    }
})

$pm2HomePath = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
$pm2Apps = @()
$pm2Inspection = 'Skipped: current PM2 home has no verified running daemon; no daemon was started.'
$daemonProcessId = 0
$daemonPidPath = Join-Path $pm2HomePath 'pm2.pid'
if (Test-Path -LiteralPath $daemonPidPath) {
    $parsed = [int]::TryParse((Get-Content -LiteralPath $daemonPidPath -Raw).Trim(), [ref]$daemonProcessId)
    $daemon = $processes | Where-Object { $_.ProcessId -eq $daemonProcessId -and $_.CommandLine -match '[\\/]pm2[\\/]lib[\\/]Daemon\.js' }
    if ($parsed -and $daemon -and (Get-Command pm2 -ErrorAction SilentlyContinue) -and (Get-Command node -ErrorAction SilentlyContinue)) {
        # Parse in Node: Windows environment keys can differ only in case, which PowerShell 5 rejects.
        $pm2SafeJson = & pm2 jlist 2>$null | & node -e 'let s='''';process.stdin.on(''data'',d=>s+=d);process.stdin.on(''end'',()=>{try{const a=JSON.parse(s);console.log(JSON.stringify({apps:a.map(p=>({name:p.name,pid:p.pid,status:p.pm2_env?.status,restarts:p.pm2_env?.restart_time,cwd:p.pm2_env?.pm_cwd,script:p.pm2_env?.pm_exec_path,port:p.pm2_env?.PORT,nodeEnv:p.pm2_env?.NODE_ENV,workers:p.pm2_env?.BULLMQ_WORKERS_ENABLED,schedulers:p.pm2_env?.FINANCIAL_SCHEDULERS_ENABLED,webhooks:p.pm2_env?.MERCHANT_WEBHOOK_WORKER_ENABLED}))}));}catch{process.exitCode=1;}});'
        if ($LASTEXITCODE -eq 0) {
            $pm2Apps = @(($pm2SafeJson | ConvertFrom-Json).apps)
            $pm2Inspection = 'Read from the verified existing daemon.'
        } else { $pm2Inspection = 'Could not parse PM2 metadata; no raw environment was printed.' }
    }
}

$health = [PSCustomObject]@{ reachable = $false }
try {
    $h = Invoke-RestMethod "http://127.0.0.1:$Port/health/ready" -TimeoutSec 5
    $health = [PSCustomObject]@{ reachable = $true; status = $h.status; processId = $h.pid; startupReady = $h.startupReady; db = $h.db; sessionStore = $h.sessionStore; redis = $h.redis }
} catch { }

$sites = @()
$proxyEnabled = $null
$rewriteTargets = @()
$iisInspection = 'WebAdministration not available or insufficient permissions.'
try {
    if (Get-Module -ListAvailable WebAdministration) {
        Import-Module WebAdministration
        $iisSites = @(Get-Website)
        $sites = @($iisSites | ForEach-Object { [PSCustomObject]@{ name = $_.Name; state = [string]$_.State; physicalPath = $_.PhysicalPath; protocols = @($_.Bindings.Collection | Select-Object -ExpandProperty protocol) } })
        $proxyEnabled = (Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -ErrorAction SilentlyContinue).Value
        foreach ($site in $iisSites) {
            try {
                $rules = @(Get-WebConfiguration -PSPath "IIS:\Sites\$($site.Name)" -Filter 'system.webServer/rewrite/rules/rule')
                foreach ($rule in $rules) {
                    $targetUri = $null
                    if ([Uri]::TryCreate([string]$rule.action.url, [UriKind]::Absolute, [ref]$targetUri)) {
                        $rewriteTargets += [PSCustomObject]@{ site = $site.Name; rule = [string]$rule.name; scheme = $targetUri.Scheme; host = $targetUri.Host; port = $targetUri.Port }
                    }
                }
            } catch { }
        }
        $iisInspection = 'Read-only IIS inventory; only destination hosts/ports are shown.'
    }
} catch { }

$services = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'pm2|node|plesk|psa|w3svc|was|nginx|apache' -or $_.ProcessId -in $listenerIds } | Select-Object Name, State, ProcessId, StartMode)
$startupTasks = @()
try {
    $startupTasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -match 'pm2|ahram|node' -or ($_.Actions.Execute -join ' ') -match 'pm2|node\.exe' } | Select-Object TaskName, TaskPath, @{Name='State';Expression={[string]$_.State}})
} catch { }
$revision = & git -C $projectRoot rev-parse --short HEAD
$workingTree = @(& git -C $projectRoot status --short)
$nodeVersion = if (Get-Command node -ErrorAction SilentlyContinue) { & node --version } else { 'not available' }

[PSCustomObject]@{
    timestampUtc = [DateTime]::UtcNow.ToString('o')
    computer = $env:COMPUTERNAME
    projectRoot = $projectRoot
    revision = $revision
    nodeVersion = $nodeVersion
    pm2Home = $pm2HomePath
    pm2Inspection = $pm2Inspection
    pm2Apps = $pm2Apps
    listeners = @($listeners | Select-Object LocalAddress, LocalPort, OwningProcess)
    processes = $nodeProcesses
    health = $health
    iisInspection = $iisInspection
    iisSites = $sites
    arrProxyEnabled = $proxyEnabled
    rewriteTargets = $rewriteTargets
    relatedServices = $services
    relatedScheduledTasks = $startupTasks
    workingTree = $workingTree
} | ConvertTo-Json -Depth 7
