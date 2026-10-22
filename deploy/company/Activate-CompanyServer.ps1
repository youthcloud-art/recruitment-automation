# Complete the reviewed, prepared installation. The operator stops the old
# manually launched app only AFTER Gitee fetch, build and runtime checks pass.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$Commit,
    [string]$InstallRoot = 'D:\App\SXF\Smart-Recruitment-Agent'
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run Activate-Server.cmd as Administrator on the company server.' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($InstallRoot -ine 'D:\App\SXF\Smart-Recruitment-Agent') { throw 'This cutover package is for the reviewed Smart-Recruitment-Agent installation only.' }
$config = Read-CompanyConfig $InstallRoot
if ($config.companyHost -cne '192.168.1.24' -or -not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq '192.168.1.24' })) { throw 'Run this package on company server 192.168.1.24.' }
if ($config.repositoryUrl -cne 'git@gitee.com:felixshe/auto-recru-company.git' -or $config.branch -cne 'main') { throw 'The configured source is not the reviewed Gitee main branch.' }
if ($config.runAs -ine [Security.Principal.WindowsIdentity]::GetCurrent().Name) { throw 'Use the same logged-in Windows account that prepared this installation.' }
foreach ($network in $config.allowedNetworks) { Assert-CompanyNetwork $network }
if (@($config.allowedNetworks).Count -eq 0) { throw 'No company networks are configured.' }
if (Test-Path -LiteralPath (Join-Path $InstallRoot 'control\current-release.json')) { throw 'A release is already active. Use the normal mirror deployment task; do not repeat first activation.' }
foreach ($taskName in @($config.runtimeTask,$config.syncTask)) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($task.State -eq 'Running') { throw "An installation task is running: $taskName. Wait before activation." }
    if (@($task.Actions).Count -ne 1 -or $task.Actions[0].WorkingDirectory -ine $InstallRoot) { throw "Unexpected task configuration: $taskName" }
    $runtime = $taskName -eq $config.runtimeTask
    $scriptName = if ($runtime) {'Run-Company.ps1'} else {'Sync-Company.ps1'}
    $expectedArguments = '-NoProfile ' + $(if ($runtime) {'-WindowStyle Hidden '} else {''}) + '-ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot ('delivery\' + $scriptName)) + '" -InstallRoot "' + $InstallRoot + '"'
    if ($task.Actions[0].Arguments -cne $expectedArguments -or $task.Actions[0].Execute -ine "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe") { throw "Unexpected task action: $taskName" }
    if ($runtime -and ($task.Principal.UserId -ine $config.runAs -or [string]$task.Principal.LogonType -ne 'Interactive')) { throw 'The runtime task does not use the reviewed interactive account.' }
    if (-not $runtime -and ($task.Principal.UserId -notin @('SYSTEM','S-1-5-18') -or [string]$task.Principal.LogonType -ne 'ServiceAccount' -or $task.State -ne 'Disabled')) { throw 'The mirror task must still be disabled and owned by SYSTEM.' }
}

$resultPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AutoRecru-Deployment-Result.json'
$result = @{ok=$false;state='preparing';commit=$Commit;installRoot=$InstallRoot;url='http://192.168.1.24:4000/';backendPort=19501;timeUtc=[datetime]::UtcNow.ToString('o')}
$setupLock = $null
$testChildren = @()
$previousSsh = [Environment]::GetEnvironmentVariable('GIT_SSH_COMMAND','Process')
$activated = $false
$source = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot 'source')
$gitBase = @('-c', ('safe.directory=' + $source))
function Invoke-ActivationGit([string[]]$Arguments) {
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $config.gitPath @gitBase @Arguments
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $preference }
    if ($code -ne 0) { throw 'Gitee Git operation failed. The old application has not been stopped by this script.' }
    return $output
}
try {
    $setupLock = [IO.File]::Open((Join-Path $InstallRoot 'control\sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    # Never overwrite hand-edited delivery scripts. Accept only the reviewed
    # bootstrap bytes or this package's bytes; preserve originals in a backup.
    $baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bootstrap-delivery-baseline.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $deliveryFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File)
    foreach ($file in $deliveryFiles) {
        $destination = Join-Path $InstallRoot ('delivery\' + $file.Name)
        if (Test-Path -LiteralPath $destination) {
            $actual = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
            $incoming = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $old = $baseline.files.PSObject.Properties[$file.Name]
            if ($actual -ine $incoming -and (-not $old -or $actual -ine [string]$old.Value)) { throw "Delivery script has local changes and was preserved: $($file.Name)" }
        }
    }
    # Windows PID 4 owns 5001 on this server. Do not modify or stop it.
    Assert-CompanyPortsFree -BackendPort 19501 -GatewayPort 19502
    $config.backendPort = 19501
    $knownHosts = Join-Path $InstallRoot 'delivery\known_hosts'
    $env:GIT_SSH_COMMAND = '"' + $config.sshPath + '" -i "' + $config.deployKeyPath + '" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="' + $knownHosts + '"'
    Write-Host 'STEP 1: Verify the server read-only key by fetching Gitee main.'
    if (-not (Test-Path -LiteralPath $source)) {
        Invoke-ActivationGit @('clone','--quiet','--config','core.autocrlf=false','--branch','main',[string]$config.repositoryUrl,$source)
    }
    if (((Invoke-ActivationGit @('-C',$source,'remote','get-url','origin')) -join '').Trim() -cne [string]$config.repositoryUrl) { throw 'The existing source checkout has an unexpected origin.' }
    if (@(Invoke-ActivationGit @('-C',$source,'status','--porcelain')).Count -gt 0) { throw 'The source checkout contains local changes and was preserved.' }
    Invoke-ActivationGit @('-C',$source,'fetch','--quiet','--prune','origin','main')
    $mirrorCommit = ((Invoke-ActivationGit @('-C',$source,'rev-parse','origin/main')) -join '').Trim()
    if ($mirrorCommit -ine $Commit) { throw 'Gitee main does not match this cutover package. Download the current reviewed cutover package before continuing.' }
    Invoke-ActivationGit @('-C',$source,'reset','--hard',$Commit)
    $result.giteeVerified = $true

    $backup = Assert-ChildPath $InstallRoot (Join-Path $InstallRoot ('backups\setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)))
    New-Item -ItemType Directory -Path $backup | Out-Null
    Copy-Item -LiteralPath (Join-Path $InstallRoot 'delivery\config.json') -Destination (Join-Path $backup 'config.json')
    foreach ($file in $deliveryFiles) {
        $destination = Join-Path $InstallRoot ('delivery\' + $file.Name)
        if (Test-Path -LiteralPath $destination) { Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $file.Name) }
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
    Write-JsonFile (Join-Path $InstallRoot 'delivery\config.json') $config
    $result.setupBackup = $backup
    Write-Host 'STEP 2: Prepare the exact Gitee release while the old app stays online.'
    & (Join-Path $InstallRoot 'delivery\Prepare-Release.ps1') -InstallRoot $InstallRoot -SourceRoot $source -Commit $Commit
    $prepared = Get-Content -LiteralPath (Join-Path $InstallRoot 'delivery\prepared-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($prepared.commit -ine $Commit) { throw 'Prepared release commit mismatch.' }
    $release = Assert-ChildPath (Join-Path $InstallRoot 'releases') ([string]$prepared.root)
    Write-Host 'STEP 3: Test the real backend on loopback 19501 and gateway on loopback 19502.'
    foreach ($definition in @(Get-CompanyRuntimeDefinitions $config $release '127.0.0.1' 19502)) {
        $testChildren += Start-CompanyChild $config $definition 'preflight-'
    }
    try {
        Wait-CompanyHealth 'http://127.0.0.1:19502/healthz'
        $positions = Get-CompanyResponseText 'http://127.0.0.1:19502/api/positions' | ConvertFrom-Json
        $console = Get-CompanyResponseText 'http://127.0.0.1:19502/api/browser-console/status' | ConvertFrom-Json
        $socket = Get-CompanyResponseText 'http://127.0.0.1:19502/socket.io/?EIO=4&transport=polling'
        $page = Get-CompanyResponseText 'http://127.0.0.1:19502/'
        if (-not $positions.success -or -not $console.success -or -not $socket.StartsWith('0{') -or $page -notmatch '(?i)<html') { throw 'Preflight API, browser console, Socket.IO or frontend verification failed.' }
        foreach ($record in $testChildren) { if (-not (Get-VerifiedChild $record)) { throw 'A preflight process exited unexpectedly.' } }
        $result.preflightPassed = $true
    } finally {
        foreach ($record in $testChildren) { Stop-VerifiedChild $record }
        $testChildren = @()
    }
    Assert-CompanyPortsFree -BackendPort 19501 -GatewayPort 19502

    # Create only the dedicated, narrow company rule; never replace another rule.
    $rule = Get-NetFirewallRule -Name 'AutoRecru-Company-TCP4000' -ErrorAction SilentlyContinue
    if ($rule) {
        $ports = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule
        $addresses = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule
        $application = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule
        if ($rule.Enabled -ne 'True' -or $rule.Direction -ne 'Inbound' -or $rule.Action -ne 'Allow' -or
            [string]$ports.LocalPort -ne '4000' -or [string]$ports.Protocol -notin @('TCP','6') -or
            [string]$addresses.LocalAddress -ne [string]$config.companyHost -or $application.Program -ine [string]$config.nodePath -or
            ((@($addresses.RemoteAddress | ForEach-Object { ConvertTo-CanonicalFirewallNetwork $_ }) | Sort-Object) -join ',') -cne ((@($config.allowedNetworks) | Sort-Object) -join ',')) { throw 'The existing company firewall rule differs from the reviewed configuration.' }
    } else {
        New-NetFirewallRule -Name 'AutoRecru-Company-TCP4000' -DisplayName 'AutoRecru company networks TCP 4000' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $config.companyHost -LocalPort 4000 -RemoteAddress $config.allowedNetworks -Program $config.nodePath -Profile Any | Out-Null
    }
    $result.state = 'ready_for_cutover'
    Write-JsonFile $resultPath $result
    Write-Host ''
    Write-Host 'READY_TO_SWITCH: Gitee fetch, build and local runtime checks passed.'
    Write-Host 'The old recruitment app was manually launched in another PowerShell window.'
    Write-Host 'Keep that OLD window open. Press Ctrl+C there to stop the old app, then return HERE.'
    Write-Host 'Do not press Ctrl+C in this new activation window. Do not log off Windows.'
    Write-Host 'If the first activation fails, use the OLD window to re-run its previous launch command.'
    $answer = Read-Host 'After stopping the old app, type SWITCH here (or type CANCEL to leave the new app inactive)'
    if ($answer -cne 'SWITCH') { throw 'Cutover cancelled. No new runtime was started; keep or restart the old application as needed.' }
    Assert-CompanyPortsFree -BackendPort $config.backendPort
    & (Join-Path $InstallRoot 'delivery\Switch-Release.ps1') -InstallRoot $InstallRoot -ReleaseRoot $release
    $activated = $true
    $result.ok = $true
    $result.state = 'deployed'
    # Persist the successful activation before separately enabling future upgrades.
    Write-JsonFile $resultPath $result
    Enable-ScheduledTask -TaskName $config.syncTask | Out-Null
    Write-JsonFile (Join-Path $InstallRoot 'delivery\last-sync.json') @{ok=$true;result='initial_gitee_release_verified';commit=$Commit;timeUtc=[datetime]::UtcNow.ToString('o')}
    $result.mirrorTaskEnabled = $true
    Write-Host 'DEPLOYMENT_COMPLETE: http://192.168.1.24:4000/'
} catch {
    $result.state = if ($activated) {'deployed_delivery_needs_attention'} else {'stopped_before_activation_or_rolled_back'}
    $result.error = $_.Exception.Message
    Write-Host 'The script never stopped or deleted the old recruitment app.'
    if (-not $activated) { Write-Host 'If you manually stopped the old app, re-run its previous command in its original PowerShell window.' }
    throw
} finally {
    foreach ($record in $testChildren) { try { Stop-VerifiedChild $record } catch { Write-Warning $_.Exception.Message } }
    [Environment]::SetEnvironmentVariable('GIT_SSH_COMMAND',$previousSsh,'Process')
    if ($setupLock) { $setupLock.Dispose() }
    $result.timeUtc = [datetime]::UtcNow.ToString('o')
    Write-JsonFile $resultPath $result
    Write-Host "DEPLOYMENT_RESULT: $resultPath"
}
