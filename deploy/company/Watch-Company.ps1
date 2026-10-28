[CmdletBinding()]
param([string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent')
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Read-CompanyConfig $InstallRoot
$control = Join-Path $InstallRoot 'control'
$lock = $null
$resultPath = Join-Path $InstallRoot 'delivery\last-watchdog.json'
try {
    try { $lock = [IO.File]::Open((Join-Path $control 'watch.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { exit 0 }
    if (-not (Test-Path -LiteralPath (Join-Path $control 'current-release.json')) -or
        (Test-Path -LiteralPath (Join-Path $control 'stop.request')) -or
        (Get-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop).State -eq 'Running') { exit 0 }
    $health = 'http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz'
    if (Test-CompanyHealth $health) {
        Write-JsonFile $resultPath @{timeUtc=[datetime]::UtcNow.ToString('o');result='healthy'}
        exit 0
    }
    $runtime = Get-ScheduledTask -TaskName $config.runtimeTask -ErrorAction Stop
    if ($runtime.State -eq 'Running') {
        # A busy or degraded running process needs diagnosis, not a second
        # copy of the app or a forced kill of its Chrome login windows.
        Write-JsonFile $resultPath @{timeUtc=[datetime]::UtcNow.ToString('o');result='running_unhealthy'}
        exit 0
    }
    Assert-CompanyPortsFree -BackendPort $config.backendPort -GatewayPort $config.gatewayPort
    Start-CompanyRuntime $config
    Wait-CompanyHealth $health -TimeoutSeconds 30
    Write-JsonFile $resultPath @{timeUtc=[datetime]::UtcNow.ToString('o');result='restarted'}
} catch {
    Write-JsonFile $resultPath @{timeUtc=[datetime]::UtcNow.ToString('o');result='failed';reason=$_.Exception.Message}
    throw
} finally {
    if ($lock) { $lock.Dispose() }
}
