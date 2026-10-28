Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ChildPath([string]$Root, [string]$Path) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidate = [IO.Path]::GetFullPath($Path)
    if (-not $candidate.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the installation: $candidate"
    }
    return $candidate
}

function Write-JsonFile([string]$Path, $Value) {
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Read-CompanyConfig([string]$InstallRoot) {
    $config = Get-Content -LiteralPath (Join-Path $InstallRoot 'delivery\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([IO.Path]::GetFullPath([string]$config.installRoot).TrimEnd('\') -ine [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')) {
        throw 'The deployment configuration belongs to another installation.'
    }
    # Compatibility with the first bootstrap, which used a fixed port 5001.
    if (-not $config.PSObject.Properties['backendPort']) { $config | Add-Member -NotePropertyName backendPort -NotePropertyValue 5001 }
    if (-not $config.PSObject.Properties['gatewayPort']) { $config | Add-Member -NotePropertyName gatewayPort -NotePropertyValue 4000 }
    if (-not $config.PSObject.Properties['watchdogTask']) { $config | Add-Member -NotePropertyName watchdogTask -NotePropertyValue 'AutoRecru-Company-Watchdog' }
    $gateway = 0
    if (-not [int]::TryParse([string]$config.gatewayPort, [ref]$gateway) -or $gateway -lt 1024 -or $gateway -gt 65535) { throw 'The configured gateway port is invalid.' }
    $port = 0
    if (-not [int]::TryParse([string]$config.backendPort, [ref]$port) -or $port -lt 1024 -or $port -gt 65535 -or $port -eq $gateway) {
        throw 'The configured backend port is invalid or conflicts with the public gateway.'
    }
    return $config
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Executable" }
}

function Copy-DirectoryChecked([string]$Source, [string]$Destination, [switch]$Mirror) {
    $arguments = @($Source, $Destination, '/E', '/XJ', '/R:2', '/W:1', '/COPY:DAT', '/DCOPY:DAT', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    # Visible Chrome intentionally outlives its Node launcher. Preserve its
    # locked profile directories in place during BOTH backup and mirror restore.
    # A basename exclusion also protects destination-only profiles from /MIR.
    $arguments += @('/XD', 'browser-profiles')
    if ($Mirror) { $arguments += '/MIR' }
    & robocopy.exe @arguments | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Directory copy failed with robocopy exit code $LASTEXITCODE." }
}

function Test-CompanyHealth([string]$Url) {
    try {
        $request = [Net.HttpWebRequest]::Create($Url)
        $request.Proxy = $null
        $request.Timeout = 4000
        $response = $request.GetResponse()
        try { return [int]$response.StatusCode -eq 200 } finally { $response.Close() }
    } catch { return $false }
}

function Get-CompanyResponseText([string]$Url) {
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.Proxy = $null
    $request.Timeout = 5000
    $response = $request.GetResponse()
    try {
        if ([int]$response.StatusCode -ne 200) { throw "Unexpected HTTP status for $Url" }
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $response.Close() }
}

# Loading the shared resume store after a release switch can take several
# minutes on the company server. Keep the health predicate strict, but allow
# cold startup to finish before rolling a healthy release back.
function Wait-CompanyHealth([string]$Url, [int]$TimeoutSeconds = 600) {
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-CompanyHealth $Url) { return }
        Start-Sleep -Milliseconds 1000
    } while ([datetime]::UtcNow -lt $deadline)
    throw "Health verification failed: $Url"
}

function Assert-CompanyPortsFree([int]$BackendPort = 5001, [int]$GatewayPort = 4000) {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @($GatewayPort, $BackendPort) })
    if ($listeners.Count -gt 0) {
        $summary = ($listeners | ForEach-Object { "port=$($_.LocalPort),pid=$($_.OwningProcess)" }) -join '; '
        throw "A required port is still occupied ($summary). No unrelated process was killed."
    }
}

function Get-CompanyRuntimeDefinitions($Config, [string]$ReleaseRoot, [string]$GatewayHost, [int]$GatewayPort = 0) {
    if (-not $GatewayHost) { $GatewayHost = [string]$Config.companyHost }
    if ($GatewayPort -eq 0) { $GatewayPort = [int]$Config.gatewayPort }
    @(
        @{name='backend'; script=(Join-Path $ReleaseRoot 'backend\src\index.js'); cwd=(Join-Path $ReleaseRoot 'backend'); env=@{HOST='127.0.0.1';PORT=[string]$Config.backendPort;NODE_ENV='production';COMPANY_DEPLOYMENT='true';RECRUITMENT_ENV_FILE=(Join-Path $Config.installRoot 'shared\backend.env')}},
        @{name='gateway'; script=(Join-Path $ReleaseRoot 'deploy\company\gateway.js'); cwd=$ReleaseRoot; env=@{COMPANY_HOST=$GatewayHost;COMPANY_PORT=[string]$GatewayPort;BACKEND_PORT=[string]$Config.backendPort;LAN_ALLOW_CIDRS=([string[]]$Config.allowedNetworks -join ',');NODE_ENV='production';PUBLIC_ORIGIN=('http://' + $GatewayHost + ':' + $GatewayPort)}}
    )
}

function Start-CompanyChild($Config, $Definition, [string]$LogPrefix = '') {
    $previous = @{}
    $process = $null
    $logRoot = Assert-ChildPath $Config.installRoot (Join-Path $Config.installRoot 'logs')
    $logStem = $LogPrefix + $Definition.name
    foreach ($stream in @('stdout','stderr')) {
        $activeLog = Assert-ChildPath $logRoot (Join-Path $logRoot ($logStem + '.' + $stream + '.log'))
        if ((Test-Path -LiteralPath $activeLog -PathType Leaf) -and
            (Get-Item -LiteralPath $activeLog).Length -gt 0) {
            $archive = Assert-ChildPath $logRoot (Join-Path $logRoot ($logStem + '.' + $stream + '.' +
                (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.log'))
            Move-Item -LiteralPath $activeLog -Destination $archive -ErrorAction Stop
        }
        $old = @(Get-ChildItem -LiteralPath $logRoot -Filter ($logStem + '.' + $stream + '.*.log') -File |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 10)
        foreach ($file in $old) { Remove-Item -LiteralPath $file.FullName -Force }
    }
    try {
        foreach ($name in $Definition.env.Keys) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, [string]$Definition.env[$name], 'Process')
        }
        $process = Start-Process -FilePath $Config.nodePath -ArgumentList @('"' + $Definition.script + '"') -WorkingDirectory $Definition.cwd -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Config.installRoot ('logs\' + $LogPrefix + $Definition.name + '.stdout.log')) -RedirectStandardError (Join-Path $Config.installRoot ('logs\' + $LogPrefix + $Definition.name + '.stderr.log')) -PassThru
        $information = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
        if (-not $information) { throw "$($Definition.name) exited during startup." }
        return @{pid=$process.Id; executable=[string]$Config.nodePath; script=$Definition.script; createdAtUtc=$information.CreationDate.ToUniversalTime().ToString('o')}
    } catch {
        # The direct Process handle identifies only the child just created here.
        if ($process -and -not $process.HasExited) { $process.Kill() }
        throw
    } finally {
        foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
}

function Assert-CompanyNetwork([string]$Network) {
    $parts = $Network.Split('/')
    if ($parts.Count -ne 2 -or $parts[1] -notmatch '^\d{1,2}$') { throw "Invalid company CIDR: $Network" }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($parts[0], [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw "Invalid company IPv4 network: $Network" }
    $bytes = $address.GetAddressBytes()
    $prefix = [int]$parts[1]
    $minimum = 32
    if ($bytes[0] -eq 10) { $minimum = 8 }
    elseif ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) { $minimum = 12 }
    elseif ($bytes[0] -eq 192 -and $bytes[1] -eq 168) { $minimum = 16 }
    if ($minimum -eq 32 -or $prefix -lt $minimum -or $prefix -gt 32) { throw "Only explicit private company networks are accepted: $Network" }
    for ($bit = $prefix; $bit -lt 32; $bit++) {
        $byteIndex = [int][math]::Floor($bit / 8)
        if (($bytes[$byteIndex] -band (1 -shl (7 - ($bit % 8)))) -ne 0) { throw "Use a canonical network CIDR without host bits: $Network" }
    }
}

function ConvertTo-CanonicalFirewallNetwork([string]$Network) {
    $parts = $Network.Split('/')
    if ($parts.Count -eq 2 -and $parts[1].Contains('.')) {
        $mask = $null
        if (-not [Net.IPAddress]::TryParse($parts[1], [ref]$mask) -or $mask.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Invalid firewall network mask.' }
        $binary = ($mask.GetAddressBytes() | ForEach-Object { [Convert]::ToString($_,2).PadLeft(8,'0') }) -join ''
        if ($binary -notmatch '^1*0*$') { throw 'Non-contiguous firewall network mask.' }
        $Network = $parts[0] + '/' + ($binary.TrimEnd('0').Length)
    }
    Assert-CompanyNetwork $Network
    return $Network
}

function Get-VerifiedChild($Record) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Record.pid)" -ErrorAction SilentlyContinue
    if (-not $process -or $process.ExecutablePath -ine [string]$Record.executable) { return $null }
    if ([Math]::Abs(($process.CreationDate.ToUniversalTime() - ([datetimeoffset]$Record.createdAtUtc).UtcDateTime).TotalSeconds) -gt 1) { return $null }
    $pattern = '^\s*(?:"[^"]+"|\S+)\s+"?' + [regex]::Escape([string]$Record.script) + '"?(?:\s|$)'
    if ($process.CommandLine -notmatch $pattern) { return $null }
    return $process
}

function Stop-VerifiedChild($Record) {
    if (Get-VerifiedChild $Record) {
        $terminator = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList @('/PID', [string]$Record.pid, '/T', '/F') -WindowStyle Hidden -Wait -PassThru
        if ($terminator.ExitCode -ne 0 -and (Get-VerifiedChild $Record)) { throw "Could not stop owned process $($Record.pid)." }
    }
}

function Stop-CompanyRuntime($Config) {
    $control = Join-Path $Config.installRoot 'control'
    $request = Join-Path $control 'stop.request'
    [IO.File]::WriteAllText($request, 'deployment stop request')
    $deadline = [datetime]::UtcNow.AddSeconds(35)
    do {
        $task = Get-ScheduledTask -TaskName $Config.runtimeTask -ErrorAction Stop
        if ($task.State -ne 'Running') { break }
        Start-Sleep -Milliseconds 500
    } while ([datetime]::UtcNow -lt $deadline)
    if ((Get-ScheduledTask -TaskName $Config.runtimeTask).State -eq 'Running') {
        Stop-ScheduledTask -TaskName $Config.runtimeTask
    }
    $statePath = Join-Path $control 'processes.json'
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        foreach ($record in @($state.children)) { Stop-VerifiedChild $record }
    }
}

function Assert-CompanyCollectionIdle($Config) {
    # A release switch terminates the backend process. Never interrupt a
    # collector or an accepted AI evaluation merely to publish new code.
    $runtime = Get-ScheduledTask -TaskName $Config.runtimeTask -ErrorAction Stop
    if ($runtime.State -ne 'Running') { return }
    $base = 'http://127.0.0.1:' + $Config.backendPort + '/api'
    $checks = @(
        @{name='BOSS'; path='/boss-zhipin/browsing-status'; active={param($data) [bool]$data.isActive}},
        @{name='智联'; path='/zhilian/browsing-status'; active={param($data) [bool]$data.isActive}},
        @{name='前程无忧'; path='/wuyou/status?readOnly=1'; active={param($data) [bool]$data.batch.running}},
        @{name='AI 评估'; path='/recruitment-pipeline/evaluation-queue/status'; active={param($data) [bool]$data.running -or [int]$data.queued -gt 0}},
        @{name='批量评估'; path='/recruitment-pipeline/evaluate-batch/status'; active={param($data) [bool]$data.running}}
    )
    foreach ($check in $checks) {
        try {
            $reply = Invoke-RestMethod -Uri ($base + $check.path) -TimeoutSec 5 -ErrorAction Stop
            if ($reply.success -ne $true -or $null -eq $reply.data) { throw '状态响应无效' }
        } catch {
            throw "DEPLOY_DEFERRED: $($check.name) 状态暂不可确认；保留当前服务并稍后重试部署"
        }
        if (& $check.active $reply.data) {
            throw "DEPLOY_DEFERRED: $($check.name) 正在采集或评估；本次部署延后，当前任务继续运行"
        }
    }
}

function Start-CompanyRuntime($Config) {
    Remove-Item -LiteralPath (Join-Path $Config.installRoot 'control\stop.request') -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $Config.runtimeTask
}

function Connect-SharedState([string]$InstallRoot, [string]$ReleaseRoot) {
    $shared = Join-Path $InstallRoot 'shared'
    foreach ($mapping in @(
        @{ link='.local'; target='local' },
        @{ link='backend\storage'; target='backend-storage' },
        @{ link='backend\uploads'; target='backend-uploads' }
    )) {
        $link = Assert-ChildPath $ReleaseRoot (Join-Path $ReleaseRoot $mapping.link)
        $target = Assert-ChildPath $InstallRoot (Join-Path $shared $mapping.target)
        if (Test-Path -LiteralPath $link) { throw "Release unexpectedly contains persistent state: $link" }
        New-Item -ItemType Junction -Path $link -Value $target | Out-Null
    }
    if (Test-Path -LiteralPath (Join-Path $ReleaseRoot 'backend\.env')) { throw 'A release must not contain backend/.env.' }
    # The backend reads/writes shared/backend.env directly through
    # RECRUITMENT_ENV_FILE. Atomic mail-settings writes must not replace a link.
}
