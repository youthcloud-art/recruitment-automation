[CmdletBinding()]
param([string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent')
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-CompanyConfig $InstallRoot
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this one-time update in an Administrator PowerShell on the company server.'
}
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $config.companyHost })) {
    throw 'The current computer does not own the configured company server address.'
}
$releaseRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$pointer = Get-Content -LiteralPath (Join-Path $InstallRoot 'control\current-release.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $releaseRoot 'release.json') -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath([string]$pointer.root).TrimEnd('\') -ine $releaseRoot.TrimEnd('\') -or
    [string]$pointer.commit -ine [string]$manifest.commit) {
    throw 'Run this script from the active release, after the Gitee deployment completes.'
}
$syncLock = $null
$syncTaskDisabled = $false
$watchName = [string]$config.watchdogTask
$watchPath = Join-Path $InstallRoot 'delivery\Watch-Company.ps1'
$backup = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('backups\delivery-reliability-' +
    (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)))
$files = @('Common.ps1','Run-Company.ps1','Watch-Company.ps1',
    'Sync-Company.ps1','Switch-Release.ps1')
$copied = $false
$runtimeStopped = $false
$watchCreated = $false
$drainPath = Join-Path $InstallRoot 'shared\local\deploy-drain.request'
$drainOwned = $false
try {
    # Prevent the next scheduled mirror run, then wait for any current build
    # to release its exclusive lock. This makes one invocation sufficient.
    $syncTask = Get-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop
    if ($syncTask.State -ne 'Disabled') {
        Disable-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop | Out-Null
        $syncTaskDisabled = $true
    }
    $deadline = [datetime]::UtcNow.AddMinutes(20)
    do {
        try { $syncLock = [IO.File]::Open((Join-Path $InstallRoot 'control\sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { Start-Sleep -Seconds 10 }
    } while (-not $syncLock -and [datetime]::UtcNow -lt $deadline)
    if (-not $syncLock) { throw 'The current mirror deployment did not release its lock within 20 minutes.' }
    $pointer = Get-Content -LiteralPath (Join-Path $InstallRoot 'control\current-release.json') -Raw | ConvertFrom-Json
    if ([IO.Path]::GetFullPath([string]$pointer.root).TrimEnd('\') -ine $releaseRoot.TrimEnd('\') -or
        [string]$pointer.commit -ine [string]$manifest.commit) {
        throw 'A newer release became active while waiting; run the updater from that active release.'
    }
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($name in $files) {
        $source = Assert-ChildPath $releaseRoot (Join-Path $PSScriptRoot $name)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release is missing $name" }
    }
    foreach ($name in $files) {
        $destination = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('delivery\' + $name))
        if (Test-Path -LiteralPath $destination) {
            Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $name)
        }
    }
    [IO.File]::WriteAllText($drainPath, 'reliability update pending')
    $drainOwned = $true
    Assert-CompanyCollectionIdle $config
    $copied = $true
    foreach ($name in $files) {
        $destination = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('delivery\' + $name))
        $source = Assert-ChildPath $releaseRoot (Join-Path $PSScriptRoot $name)
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
    $runtimeStopped = $true
    Stop-CompanyRuntime $config
    Start-CompanyRuntime $config
    $health = 'http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz'
    Wait-CompanyHealth $health -TimeoutSeconds 600
    $existing = Get-ScheduledTask -TaskName $watchName -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $watchPath +
            '" -InstallRoot "' + $InstallRoot + '"') -WorkingDirectory $InstallRoot
    if ($existing) {
        if (@($existing.Actions).Count -ne 1 -or
            $existing.Actions[0].Execute -ine $action.Execute -or
            $existing.Actions[0].Arguments -cne $action.Arguments -or
            $existing.Actions[0].WorkingDirectory -ine $action.WorkingDirectory) {
            throw 'An unrelated watchdog task already uses this name; it was not overwritten.'
        }
    } else {
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
            -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable
        $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $watchName -Action $action -Trigger $trigger `
            -Settings $settings -Principal $taskPrincipal `
            -Description 'Restart the company recruitment runtime only when stopped and unhealthy; preserve browser profiles.' | Out-Null
        $watchCreated = $true
    }
    Write-JsonFile (Join-Path $InstallRoot 'delivery\last-reliability-update.json') @{
        ok=$true;commit=[string]$pointer.commit;backup=$backup;timeUtc=[datetime]::UtcNow.ToString('o')
    }
    Write-Host "RELIABILITY_UPDATE_OK: $($pointer.commit)"
} catch {
    $failure = $_
    if ($watchCreated) { Unregister-ScheduledTask -TaskName $watchName -Confirm:$false -ErrorAction SilentlyContinue }
    if ($copied) {
        try {
            if ($runtimeStopped -and (Get-ScheduledTask -TaskName $config.runtimeTask).State -eq 'Running') {
                Stop-CompanyRuntime $config
            }
            foreach ($name in $files) {
                $old = Join-Path $backup $name
                $destination = Join-Path $InstallRoot ('delivery\' + $name)
                if (Test-Path -LiteralPath $old) { Copy-Item -LiteralPath $old -Destination $destination -Force }
                else { Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue }
            }
            if ($runtimeStopped) {
                Start-CompanyRuntime $config
                Wait-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz') -TimeoutSeconds 600
            }
        } catch { Write-Warning "Rollback failed: $($_.Exception.Message)" }
    }
    throw $failure
} finally {
    if ($drainOwned) { Remove-Item -LiteralPath $drainPath -Force -ErrorAction SilentlyContinue }
    if ($syncLock) { $syncLock.Dispose() }
    if ($syncTaskDisabled) { Enable-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop | Out-Null }
}
