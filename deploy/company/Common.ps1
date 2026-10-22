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

function Wait-CompanyHealth([string]$Url, [int]$TimeoutSeconds = 90) {
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-CompanyHealth $Url) { return }
        Start-Sleep -Milliseconds 1000
    } while ([datetime]::UtcNow -lt $deadline)
    throw "Health verification failed: $Url"
}

function Assert-CompanyPortsFree {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(4000, 5001) })
    if ($listeners.Count -gt 0) {
        $summary = ($listeners | ForEach-Object { "port=$($_.LocalPort),pid=$($_.OwningProcess)" }) -join '; '
        throw "A required port is still occupied ($summary). No unrelated process was killed."
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
