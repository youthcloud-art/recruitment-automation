$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$statePath = Join-Path $projectRoot '.local\processes.json'
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

try {
    $localDirectory = Split-Path -Parent $statePath
    if (Test-Path -LiteralPath $localDirectory) {
        try {
            $operationLock = [IO.File]::Open((Join-Path $localDirectory 'control.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
        } catch {
            throw 'Another local startup or stop is in progress. Wait for it to finish, then retry.'
        }
    }
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-Host 'No saved local services are running.'
        exit 0
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.projectRoot -ine $projectRoot) { throw "The saved process state belongs to another project: $statePath" }
    $entries = [ordered]@{
        frontend = Join-Path $projectRoot 'frontend\node_modules\react-scripts\bin\react-scripts.js'
        backend = Join-Path $projectRoot 'backend\src\index.js'
    }
    foreach ($name in $entries.Keys) {
        $record = $state.services.$name
        $process = Get-VerifiedProcess $record $entries[$name]
        if (-not $process) {
            Write-Host "No matching saved $name process; leaving other programs untouched."
            continue
        }
        # The backend's dedicated Chrome CDP windows hold user-authenticated
        # employer sessions. Keep them alive across a backend restart so the
        # next process can reconnect without another phone verification.
        $killArgs = if ($name -eq 'backend') {
            @('/PID', [string]$process.ProcessId, '/F')
        } else {
            @('/PID', [string]$process.ProcessId, '/T', '/F')
        }
        $terminator = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList $killArgs -WindowStyle Hidden -PassThru -Wait
        if ($terminator.ExitCode -ne 0 -and (Get-VerifiedProcess $record $entries[$name])) { throw "Could not stop $name (PID $($process.ProcessId))." }
        Write-Host "Stopped $name$(if ($name -ne 'backend') { ' and its child processes' })."
    }
    Remove-Item -LiteralPath $statePath -Force
    Write-Host 'Local services stopped. Data and logs were preserved.'
    exit 0
} catch {
    [Console]::Error.WriteLine("Local stop failed: $($_.Exception.Message)")
    [Console]::Error.WriteLine("Process state was preserved: $statePath")
    exit 1
} finally {
    if ($operationLock) { $operationLock.Dispose() }
}
