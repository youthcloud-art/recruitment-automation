param(
    [switch]$NoOpenBrowser,
    [ValidateRange(10, 600)][int]$ReadyTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$localDirectory = Join-Path $projectRoot '.local'
$statePath = Join-Path $localDirectory 'processes.json'
$newServices = @()
$state = $null
$operationLock = $null

function Get-VerifiedProcess($Record, [string]$ExpectedScript) {
    if (-not $Record -or -not $Record.pid) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Record.pid)" -ErrorAction SilentlyContinue
    if (-not $process -or $process.Name -ine 'node.exe') { return $null }
    if ($process.ExecutablePath -ine [string]$Record.nodePath) { return $null }
    $pattern = '^\s*(?:"[^"]+"|\S+)\s+"?' + [regex]::Escape($ExpectedScript) + '"?(?:\s|$)'
    if ($process.CommandLine -notmatch $pattern) { return $null }
    if ([Math]::Abs(($process.CreationDate.ToUniversalTime() - ([datetimeoffset]$Record.createdAtUtc).UtcDateTime).TotalSeconds) -gt 1) { return $null }
    return $process
}

function Get-ProcessFamily($RootProcess) {
    $family = @{}
    $family[[int]$RootProcess.ProcessId] = $RootProcess.CreationDate
    $allProcesses = @(Get-CimInstance Win32_Process)
    do {
        $added = $false
        foreach ($child in $allProcesses) {
            $parentId = [int]$child.ParentProcessId
            $childId = [int]$child.ProcessId
            if (-not $family.ContainsKey($childId) -and $family.ContainsKey($parentId) -and $child.CreationDate -ge $family[$parentId]) {
                $family[$childId] = $child.CreationDate
                $added = $true
            }
        }
    } while ($added)
    return $family
}

function Assert-PortAvailable([int]$Port, $OwnedProcess) {
    $listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq $Port })
    if ($listeners.Count -eq 0) { return }
    $family = @{}
    if ($OwnedProcess) { $family = Get-ProcessFamily $OwnedProcess }
    foreach ($listener in $listeners) {
        if (-not $family.ContainsKey([int]$listener.OwningProcess)) {
            throw "Port $Port is occupied by another process (PID $($listener.OwningProcess)). Close that program or stop its service, then retry. No process was killed."
        }
    }
}

function Save-State {
    $temporaryPath = "$statePath.tmp"
    [IO.File]::WriteAllText($temporaryPath,
        ($state | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Start-LocalService([string]$Name, $Definition, [string]$NodePath) {
    $previousEnvironment = @{}
    $serviceEnvironment = @{ NODE_ENV = 'development'; PORT = [string]$Definition.port }
    if ($Name -eq 'frontend') {
        $serviceEnvironment.BROWSER = 'none'
        $serviceEnvironment.HOST = '127.0.0.1'
        $serviceEnvironment.CI = 'true'
    } elseif ($Name -eq 'backend') {
        $serviceEnvironment.HOST = '127.0.0.1'
    }
    try {
        foreach ($key in $serviceEnvironment.Keys) {
            $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $serviceEnvironment[$key], 'Process')
        }
        $arguments = @('"' + $Definition.scriptPath + '"')
        if ($Name -eq 'frontend') { $arguments += 'start' }
        $process = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $Definition.workingDirectory -WindowStyle Hidden -RedirectStandardOutput $Definition.stdout -RedirectStandardError $Definition.stderr -PassThru
        $information = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
        if (-not $information) { throw "$Name exited during launch. See $($Definition.stderr)" }
        return @{
            pid = $process.Id
            createdAtUtc = $information.CreationDate.ToUniversalTime().ToString('o')
            nodePath = $NodePath
            scriptPath = $Definition.scriptPath
            workingDirectory = $Definition.workingDirectory
            port = $Definition.port
            stdout = $Definition.stdout
            stderr = $Definition.stderr
        }
    } finally {
        foreach ($key in $previousEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process')
        }
    }
}

try {
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeMajor = [int](& $nodePath -p "process.versions.node.split('.')[0]")
    if ($nodeMajor -lt 24) { throw 'Node.js 24 or newer is required for the SQLite resume library.' }
    $definitions = [ordered]@{
        backend = @{
            scriptPath = Join-Path $projectRoot 'backend\src\index.js'
            workingDirectory = Join-Path $projectRoot 'backend'
            port = 5001
            url = 'http://127.0.0.1:5001/api/health'
            stdout = Join-Path $localDirectory 'backend.stdout.log'
            stderr = Join-Path $localDirectory 'backend.stderr.log'
        }
        frontend = @{
            scriptPath = Join-Path $projectRoot 'frontend\node_modules\react-scripts\bin\react-scripts.js'
            workingDirectory = Join-Path $projectRoot 'frontend'
            port = 3000
            url = 'http://127.0.0.1:3000'
            stdout = Join-Path $localDirectory 'frontend.stdout.log'
            stderr = Join-Path $localDirectory 'frontend.stderr.log'
        }
    }
    foreach ($requiredPath in @($definitions.backend.scriptPath, $definitions.frontend.scriptPath, (Join-Path $projectRoot 'backend\node_modules'))) {
        if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Required file or dependency is missing: $requiredPath" }
    }
    New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null
    try {
        $operationLock = [IO.File]::Open((Join-Path $localDirectory 'control.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        throw 'Another local startup or stop is in progress. Wait for it to finish, then retry.'
    }
    $state = @{ projectRoot = $projectRoot; services = @{} }
    if (Test-Path -LiteralPath $statePath) {
        $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($saved.projectRoot -ine $projectRoot) { throw "The saved process state belongs to another project: $statePath" }
        foreach ($name in $definitions.Keys) {
            $record = $saved.services.$name
            if (Get-VerifiedProcess $record $definitions[$name].scriptPath) { $state.services[$name] = $record }
        }
    }
    foreach ($name in $definitions.Keys) {
        $ownedProcess = Get-VerifiedProcess $state.services[$name] $definitions[$name].scriptPath
        Assert-PortAvailable $definitions[$name].port $ownedProcess
    }
    foreach ($name in $definitions.Keys) {
        if ($state.services.ContainsKey($name)) {
            Write-Host "Reusing $name (PID $($state.services[$name].pid))."
        } else {
            $state.services[$name] = Start-LocalService $name $definitions[$name] $nodePath
            $newServices += $name
            Save-State
            Write-Host "Started $name (PID $($state.services[$name].pid))."
        }
    }
    Save-State
    Write-Host "Waiting for http://localhost:3000 and the backend health check..."
    $deadline = [datetime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    $ready = @{}
    do {
        foreach ($name in $definitions.Keys) {
            $ownedProcess = Get-VerifiedProcess $state.services[$name] $definitions[$name].scriptPath
            if (-not $ownedProcess) { throw "$name exited before it was ready. See $($definitions[$name].stderr)" }
            if ($ready[$name]) { continue }
            $healthy = $false
            try {
                $response = Invoke-WebRequest -Uri $definitions[$name].url -UseBasicParsing -TimeoutSec 3
                $healthy = $response.StatusCode -eq 200
                if ($name -eq 'backend') { $healthy = $healthy -and (($response.Content | ConvertFrom-Json).status -eq 'ok') }
            } catch {
                # A listening socket can precede HTTP readiness during startup.
            }
            if ($healthy) {
                Assert-PortAvailable $definitions[$name].port $ownedProcess
                $ready[$name] = $true
            }
        }
        if ($ready.backend -and $ready.frontend) { break }
        Start-Sleep -Milliseconds 1000
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not ($ready.backend -and $ready.frontend)) { throw "Startup timed out after $ReadyTimeoutSeconds seconds." }
    Write-Host "Ready: http://localhost:3000"
    Write-Host "Backend health: http://localhost:5001/api/health"
    Write-Host "Logs and process state: $localDirectory"
    if (-not $NoOpenBrowser) {
        try { Start-Process 'http://localhost:3000' } catch { Write-Warning 'Could not open the default browser. Open http://localhost:3000 manually.' }
    }
    exit 0
} catch {
    $failure = $_.Exception.Message
    foreach ($name in $newServices) {
        $record = $state.services[$name]
        if (Get-VerifiedProcess $record $definitions[$name].scriptPath) {
            try {
                $terminator = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList @('/PID', [string]$record.pid, '/T', '/F') -WindowStyle Hidden -PassThru -Wait
                if ($terminator.ExitCode -ne 0 -and (Get-VerifiedProcess $record $definitions[$name].scriptPath)) {
                    Write-Warning "Could not clean up $name. Run stop-local.cmd to retry."
                    continue
                }
            } catch {
                Write-Warning "Could not clean up $name. Run stop-local.cmd to retry."
                continue
            }
        }
        $state.services.Remove($name)
    }
    if ($newServices.Count -gt 0) {
        if ($state.services.Count -gt 0) { Save-State } else { Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue }
    }
    [Console]::Error.WriteLine("Local startup failed: $failure")
    [Console]::Error.WriteLine("Logs: $localDirectory\backend.stdout.log, backend.stderr.log, frontend.stdout.log, frontend.stderr.log")
    exit 1
} finally {
    if ($operationLock) { $operationLock.Dispose() }
}
