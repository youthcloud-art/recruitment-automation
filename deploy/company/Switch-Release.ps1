[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$ReleaseRoot,
    [string[]]$LegacyTaskName = @(),
    [string]$LegacyInstallRoot
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-CompanyConfig $InstallRoot
$ReleaseRoot = Assert-ChildPath (Join-Path $InstallRoot 'releases') $ReleaseRoot
$release = Get-Content -LiteralPath (Join-Path $ReleaseRoot 'release.json') -Raw | ConvertFrom-Json
if ([string]$release.root -ine $ReleaseRoot) { throw 'The prepared release manifest is inconsistent.' }
$pointerPath = Join-Path $InstallRoot 'control\current-release.json'
$previous = $null
if (Test-Path -LiteralPath $pointerPath) { $previous = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json }
$oldTasks = @()
foreach ($name in $LegacyTaskName) {
    if (-not $LegacyInstallRoot) { throw 'LegacyInstallRoot is mandatory when replacing an old task.' }
    if ($name -in @($config.runtimeTask, $config.syncTask)) { throw 'A legacy task cannot name the new runtime or delivery task.' }
    $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
    foreach ($action in $task.Actions) {
        $legacyRoot = [IO.Path]::GetFullPath($LegacyInstallRoot).TrimEnd('\')
        $workingDirectoryMatches = [string]$action.WorkingDirectory -ine '' -and ([IO.Path]::GetFullPath([string]$action.WorkingDirectory).TrimEnd('\') -ieq $legacyRoot)
        $argumentMatches = [string]$action.Arguments -match ('(?i)(?:^|[\s"])' + [regex]::Escape($legacyRoot) + '(?:[\\/\s"]|$)')
        if (-not ($workingDirectoryMatches -or $argumentMatches)) {
            throw "Legacy task $name does not refer to the explicit legacy installation."
        }
    }
    $oldTasks += @{name=$name; enabled=([string]$task.State -ne 'Disabled'); running=([string]$task.State -eq 'Running')}
}
$snapshot = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('backups\before-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)))
$changed = $false
$stopped = $false
$snapshotComplete = $false
$switchLock = $null
$drainPath = Join-Path $InstallRoot 'shared\local\deploy-drain.request'
$drainOwned = $false
try {
    $switchLock = [IO.File]::Open((Join-Path $InstallRoot 'control\switch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    # All dependency installation/build work has already completed at this point.
    if ($previous) {
        [IO.File]::WriteAllText($drainPath, 'deployment pending')
        $drainOwned = $true
        Assert-CompanyCollectionIdle $config
    }
    if ($previous) { Stop-CompanyRuntime $config; $stopped = $true }
    foreach ($old in $oldTasks) {
        Disable-ScheduledTask -TaskName $old.name | Out-Null
        if ($old.running) { Stop-ScheduledTask -TaskName $old.name }
    }
    Assert-CompanyPortsFree -BackendPort $config.backendPort -GatewayPort $config.gatewayPort
    New-Item -ItemType Directory -Path $snapshot | Out-Null
    Copy-DirectoryChecked (Join-Path $InstallRoot 'shared') (Join-Path $snapshot 'shared')
    $snapshotComplete = $true
    Write-JsonFile (Join-Path $snapshot 'previous.json') @{previous=$previous; legacyTasks=$oldTasks; legacyRoot=$LegacyInstallRoot}
    Write-JsonFile $pointerPath @{root=$ReleaseRoot; commit=[string]$release.commit; activatedAtUtc=[datetime]::UtcNow.ToString('o')}
    $changed = $true
    Start-CompanyRuntime $config
    Wait-CompanyHealth ("http://" + $config.companyHost + ':' + $config.gatewayPort + '/healthz')
    Write-JsonFile (Join-Path $InstallRoot 'delivery\last-deployment.json') @{ok=$true;commit=[string]$release.commit;release=$ReleaseRoot;snapshot=$snapshot;timeUtc=[datetime]::UtcNow.ToString('o')}
    Write-Host "DEPLOYED: $($release.commit) http://$($config.companyHost):$($config.gatewayPort)/"
} catch {
    $failure = $_
    if (-not $switchLock) { throw $failure }
    if ($changed) {
        try { Stop-CompanyRuntime $config } catch { Write-Warning $_.Exception.Message }
        # Refuse to restore a database while any known application port is live.
        Assert-CompanyPortsFree -BackendPort $config.backendPort -GatewayPort $config.gatewayPort
        if ($snapshotComplete) { Copy-DirectoryChecked (Join-Path $snapshot 'shared') (Join-Path $InstallRoot 'shared') -Mirror }
        if ($previous) { Write-JsonFile $pointerPath $previous } else { Remove-Item -LiteralPath $pointerPath -Force -ErrorAction SilentlyContinue }
    }
    if ($previous -and $stopped) {
        Start-CompanyRuntime $config
        Wait-CompanyHealth ("http://" + $config.companyHost + ':' + $config.gatewayPort + '/healthz')
    }
    foreach ($old in $oldTasks) {
        if ($old.enabled) { Enable-ScheduledTask -TaskName $old.name | Out-Null }
        if ($old.running -and (Get-ScheduledTask -TaskName $old.name).State -ne 'Running') { Start-ScheduledTask -TaskName $old.name }
    }
    throw $failure
} finally {
    if ($drainOwned) { Remove-Item -LiteralPath $drainPath -Force -ErrorAction SilentlyContinue }
    if ($switchLock) { $switchLock.Dispose() }
}
