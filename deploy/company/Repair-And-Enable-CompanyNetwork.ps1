[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][string]$Network,
    [string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script in an Administrator PowerShell on the company server.'
}
$config = Read-CompanyConfig $InstallRoot
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $config.companyHost })) {
    throw 'The current computer is not the configured company server.'
}
Assert-CompanyNetwork $Network
if ($ExpectedCommit -notmatch '^[a-f0-9]{40}$') { throw 'ExpectedCommit must be a full Git SHA.' }
$source = Join-Path $InstallRoot 'source'
$sourceCommit = ''
$sourceDeadline = [datetime]::UtcNow.AddMinutes(45)
do {
    try {
        $output = & $config.gitPath -c ('safe.directory=' + $source) -C $source rev-parse HEAD
        if ($LASTEXITCODE -eq 0) { $sourceCommit = ([string]$output).Trim() }
    } catch { $sourceCommit = '' }
    if ($sourceCommit -ceq $ExpectedCommit) { break }
    if ((Get-ScheduledTask -TaskName $config.syncTask).State -eq 'Ready') {
        Start-ScheduledTask -TaskName $config.syncTask
    }
    Start-Sleep -Seconds 20
} while ([datetime]::UtcNow -lt $sourceDeadline)
if ($sourceCommit -cne $ExpectedCommit) {
    throw 'The company source checkout did not fetch the requested release within 45 minutes.'
}
$deliveryCommon = Join-Path $InstallRoot 'delivery\Common.ps1'
$backup = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('backups\health-timeout-' +
    (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6) + '.ps1'))
$oldSignature = 'function Wait-CompanyHealth([string]$Url, [int]$TimeoutSeconds = 90) {'
$newSignature = 'function Wait-CompanyHealth([string]$Url, [int]$TimeoutSeconds = 600) {'
$lock = $null
$disabledByUs = $false
$changed = $false
try {
    $task = Get-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop
    if ($task.State -ne 'Disabled') {
        Disable-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop | Out-Null
        $disabledByUs = $true
    }
    $deadline = [datetime]::UtcNow.AddMinutes(25)
    do {
        try { $lock = [IO.File]::Open((Join-Path $InstallRoot 'control\sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { Start-Sleep -Seconds 10 }
    } while (-not $lock -and [datetime]::UtcNow -lt $deadline)
    if (-not $lock) { throw 'The mirror task did not release its deployment lock.' }

    $sourceCommit = (& $config.gitPath -c ('safe.directory=' + $source) -C $source rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceCommit -cne $ExpectedCommit) {
        throw 'The source checkout changed while waiting for the deployment lock.'
    }
    $original = [IO.File]::ReadAllText($deliveryCommon)
    if ($original.Contains($oldSignature)) {
        if ([regex]::Matches($original, [regex]::Escape($oldSignature)).Count -ne 1) {
            throw 'The delivery health function appears more than once.'
        }
        $updated = $original.Replace($oldSignature, $newSignature)
        Copy-Item -LiteralPath $deliveryCommon -Destination $backup -ErrorAction Stop
        $temporary = $deliveryCommon + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        try {
            # Windows PowerShell 5.1 decodes BOM-less .ps1 files using the
            # system code page. Common.ps1 contains Chinese strings, so the
            # temporary file must retain a UTF-8 BOM before parsing it.
            [IO.File]::WriteAllText($temporary, $updated, [Text.UTF8Encoding]::new($true))
            $tokens = $null
            $errors = $null
            [System.Management.Automation.Language.Parser]::ParseFile($temporary, [ref]$tokens, [ref]$errors) | Out-Null
            if ($errors.Count -gt 0) { throw 'The patched delivery script did not parse.' }
            $changed = $true
            Move-Item -LiteralPath $temporary -Destination $deliveryCommon -Force -ErrorAction Stop
        } finally {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    } elseif (-not $original.Contains($newSignature)) {
        throw 'The delivery health function differs from the reviewed version; no file was changed.'
    }
    Write-Host 'DEPLOY_HEALTH_WAIT_READY: 600 seconds; existing runtime remains running.'
} catch {
    if ($changed) { Copy-Item -LiteralPath $backup -Destination $deliveryCommon -Force }
    throw
} finally {
    if ($lock) { $lock.Dispose() }
    if ($disabledByUs) { Enable-ScheduledTask -TaskName $config.syncTask -ErrorAction Stop | Out-Null }
}

if ((Get-ScheduledTask -TaskName $config.syncTask).State -eq 'Ready') {
    Start-ScheduledTask -TaskName $config.syncTask
}
$deadline = [datetime]::UtcNow.AddMinutes(60)
$deployed = $false
do {
    $pointer = Get-Content -LiteralPath (Join-Path $InstallRoot 'control\current-release.json') -Raw | ConvertFrom-Json
    $sync = Get-Content -LiteralPath (Join-Path $InstallRoot 'delivery\last-sync.json') -Raw | ConvertFrom-Json
    if ($pointer.commit -ceq $ExpectedCommit -and $sync.commit -ceq $ExpectedCommit -and
        $sync.ok -eq $true -and (Test-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz'))) {
        $deployed = $true
        break
    }
    Start-Sleep -Seconds 20
} while ([datetime]::UtcNow -lt $deadline)
if (-not $deployed) {
    throw "The release did not become healthy within 60 minutes. Last deployment result: $($sync | ConvertTo-Json -Compress)"
}

& (Join-Path ([string]$pointer.root) 'deploy\company\Add-CompanyNetwork.ps1') -Network $Network -InstallRoot $InstallRoot
if (-not (Test-CompanyHealth ('http://' + $config.companyHost + ':' + $config.gatewayPort + '/healthz'))) {
    throw 'The server health check failed after changing the company network list.'
}
Write-Host "COMPANY_NETWORK_ACCESS_OK: $Network; release=$ExpectedCommit"
