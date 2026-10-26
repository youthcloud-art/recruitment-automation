[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Network,
    [string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent'
)

. (Join-Path $PSScriptRoot 'Common.ps1')

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Windows PowerShell as Administrator on the company server.'
}
$config = Read-CompanyConfig $InstallRoot
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $config.companyHost })) {
    throw 'Run this command on the company server that owns the configured address.'
}
Assert-CompanyNetwork $Network
$current = @([string[]]$config.allowedNetworks | ForEach-Object { ConvertTo-CanonicalFirewallNetwork $_ })
$network = ConvertTo-CanonicalFirewallNetwork $Network

# Do not change an unexpected firewall rule. The Windows filter and gateway
# environment must agree.
$ruleName = 'AutoRecru-Company-TCP' + [string]$config.gatewayPort
$rule = Get-NetFirewallRule -Name $ruleName -ErrorAction Stop
$ports = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
$addresses = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule
$application = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule
$firewallNetworks = @($addresses.RemoteAddress | ForEach-Object { ConvertTo-CanonicalFirewallNetwork $_ })
if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or
    [string]$ports.LocalPort -ne [string]$config.gatewayPort -or [string]$ports.Protocol -notin @('TCP','6') -or
    [string]$addresses.LocalAddress -ne [string]$config.companyHost -or
    [string]$application.Program -ine [string]$config.nodePath -or
    (($firewallNetworks | Sort-Object) -join ',') -cne (($current | Sort-Object) -join ',')) {
    throw 'The company firewall rule differs from the saved installation. No changes were made.'
}
if ($current -contains $network) {
    Write-Host "NETWORK_ALREADY_ALLOWED: $network. Check the Unionwell VLAN route or wireless client isolation."
    return
}

$next = @($current + $network | Sort-Object -Unique)
$syncDisabledByUs = $false
$syncLock = $null
$drainOwned = $false
$configChanged = $false
$firewallChanged = $false
$runtimeStopped = $false
$drainPath = Join-Path $InstallRoot 'shared\local\deploy-drain.request'
$configPath = Join-Path $InstallRoot 'delivery\config.json'
$backup = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('backups\network-access-' +
    (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.json'))
try {
    $sync = Get-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop
    if ($sync.State -ne 'Disabled') {
        Disable-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop | Out-Null
        $syncDisabledByUs = $true
    }
    $deadline = [datetime]::UtcNow.AddMinutes(20)
    do {
        try { $syncLock = [IO.File]::Open((Join-Path $InstallRoot 'control\sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { Start-Sleep -Seconds 10 }
    } while (-not $syncLock -and [datetime]::UtcNow -lt $deadline)
    if (-not $syncLock) { throw 'A mirror deployment still holds the deployment lock.' }
    $pointer = Get-Content -LiteralPath (Join-Path $InstallRoot 'control\current-release.json') -Raw | ConvertFrom-Json
    $releaseRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    if ([IO.Path]::GetFullPath([string]$pointer.root).TrimEnd('\') -ine $releaseRoot.TrimEnd('\')) {
        throw 'Run this script from the active company release.'
    }
    $latest = Read-CompanyConfig $InstallRoot
    if (((@([string[]]$latest.allowedNetworks | Sort-Object)) -join ',') -cne (($current | Sort-Object) -join ',')) {
        throw 'The company network configuration changed while acquiring the deployment lock.'
    }
    $lockedFirewallNetworks = @((Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule).RemoteAddress |
        ForEach-Object { ConvertTo-CanonicalFirewallNetwork $_ })
    if ((($lockedFirewallNetworks | Sort-Object) -join ',') -cne (($current | Sort-Object) -join ',')) {
        throw 'The company firewall rule changed while acquiring the deployment lock.'
    }
    if (Test-Path -LiteralPath $drainPath) { throw 'A deployment drain is already active.' }
    [IO.File]::WriteAllText($drainPath, 'network access update pending')
    $drainOwned = $true
    Assert-CompanyCollectionIdle $config

    # Preserve the exact previous configuration for a failed health check.
    Copy-Item -LiteralPath $configPath -Destination $backup
    $firewallChanged = $true
    $addresses | Set-NetFirewallAddressFilter -RemoteAddress $next -ErrorAction Stop | Out-Null
    $config.allowedNetworks = $next
    $configChanged = $true
    Write-JsonFile $configPath $config

    $runtimeStopped = $true
    Stop-CompanyRuntime $config
    Start-CompanyRuntime $config
    Wait-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz') -TimeoutSeconds 60
    Write-JsonFile (Join-Path $InstallRoot 'delivery\last-network-access-update.json') @{
        ok=$true;added=$network;allowedNetworks=$next;backup=$backup;timeUtc=[datetime]::UtcNow.ToString('o')
    }
    Write-Host "NETWORK_ACCESS_UPDATED: $network; SERVER_HEALTH_OK. Verify from a Unionwell client."
} catch {
    $failure = $_
    try {
        if ($configChanged) { Copy-Item -LiteralPath $backup -Destination $configPath -Force }
        if ($firewallChanged) {
            $addresses | Set-NetFirewallAddressFilter -RemoteAddress $firewallNetworks -ErrorAction Stop | Out-Null
        }
        if ($runtimeStopped) {
            Stop-CompanyRuntime $config
            Start-CompanyRuntime $config
            Wait-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz') -TimeoutSeconds 60
        }
    } catch { Write-Warning "Network-access rollback failed: $($_.Exception.Message)" }
    throw $failure
} finally {
    if ($drainOwned) { Remove-Item -LiteralPath $drainPath -Force -ErrorAction SilentlyContinue }
    if ($syncLock) { $syncLock.Dispose() }
    if ($syncDisabledByUs) { Enable-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop | Out-Null }
}
