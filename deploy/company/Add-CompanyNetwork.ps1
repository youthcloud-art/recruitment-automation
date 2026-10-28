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
$next = @($current + $network | Sort-Object -Unique)
$syncDisabledByUs = $false
$syncLock = $null
$configChanged = $false
$firewallChanged = $false
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
    $statusUrl = 'http://' + $config.companyHost + ':' + $config.gatewayPort + '/__company/network-access'
    $live = Get-CompanyResponseText $statusUrl | ConvertFrom-Json
    if ($live.success -ne $true -or $live.data.dynamic -ne $true -or $live.data.reloadError -or
        ((@($live.data.allowedNetworks | Sort-Object)) -join ',') -cne (($current | Sort-Object) -join ',')) {
        throw 'The running gateway does not support verified live network updates, or its rules differ from the saved configuration.'
    }
    if ($current -contains $network) {
        Write-Host "NETWORK_ALREADY_ALLOWED: $network. Check the Unionwell VLAN route or wireless client isolation."
        return
    }

    # Preserve the exact previous configuration for a failed health check.
    Copy-Item -LiteralPath $configPath -Destination $backup
    $firewallChanged = $true
    $addresses | Set-NetFirewallAddressFilter -RemoteAddress $next -ErrorAction Stop | Out-Null
    $config.allowedNetworks = $next
    $configChanged = $true
    Write-JsonFile $configPath $config
    $loaded = $false
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    do {
        try {
            $live = Get-CompanyResponseText $statusUrl | ConvertFrom-Json
            $loaded = $live.success -eq $true -and $live.data.dynamic -eq $true -and -not $live.data.reloadError -and
                ((@($live.data.allowedNetworks | Sort-Object)) -join ',') -ceq (($next | Sort-Object) -join ',')
        } catch { $loaded = $false }
        if (-not $loaded) { Start-Sleep -Milliseconds 500 }
    } while (-not $loaded -and [datetime]::UtcNow -lt $deadline)
    if (-not $loaded) { throw 'The running gateway did not load the new company network list.' }
    if (-not (Test-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz'))) {
        throw 'The company gateway health check failed after the network update.'
    }
    Write-JsonFile (Join-Path $InstallRoot 'delivery\last-network-access-update.json') @{
        ok=$true;added=$network;allowedNetworks=$next;backup=$backup;timeUtc=[datetime]::UtcNow.ToString('o')
    }
    Write-Host "NETWORK_ACCESS_UPDATED: $network; GATEWAY_RELOADED; SERVER_HEALTH_OK. Verify from a Unionwell client."
} catch {
    $failure = $_
    $configRestored = -not $configChanged
    if ($configChanged) {
        try { Copy-Item -LiteralPath $backup -Destination $configPath -Force; $configRestored = $true }
        catch { Write-Warning "Could not restore company config: $($_.Exception.Message)" }
    }
    if ($firewallChanged) {
        try { $addresses | Set-NetFirewallAddressFilter -RemoteAddress $firewallNetworks -ErrorAction Stop | Out-Null }
        catch { Write-Warning "Could not restore company firewall rule: $($_.Exception.Message)" }
    }
    if ($configChanged -and $configRestored) {
        $restored = $false
        $restoreDeadline = [datetime]::UtcNow.AddSeconds(25)
        do {
            try {
                $live = Get-CompanyResponseText $statusUrl | ConvertFrom-Json
                $restored = $live.success -eq $true -and -not $live.data.reloadError -and
                    ((@($live.data.allowedNetworks | Sort-Object)) -join ',') -ceq (($current | Sort-Object) -join ',')
            } catch { $restored = $false }
            if (-not $restored) { Start-Sleep -Milliseconds 500 }
        } while (-not $restored -and [datetime]::UtcNow -lt $restoreDeadline)
        if (-not $restored) { Write-Warning 'The gateway did not reload the restored company network list.' }
    }
    throw $failure
} finally {
    if ($syncLock) { $syncLock.Dispose() }
    if ($syncDisabledByUs) { Enable-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop | Out-Null }
}
